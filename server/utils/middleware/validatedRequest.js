const { EncryptionManager } = require("../EncryptionManager");
const { decodeJWT } = require("../http");
const { applyCodexDevAuthBypass } = require("../codexDevAuthBypass");
const { jwtIdleState, sessionClientIdFromToken } = require("../sessionIdle");
const { DataAccessCenter } = require("../dataAccess");
const {
  attachAuthenticatedClientContext,
  getClientRecord,
  getClientContext,
} = require("../clientIdentity");
const {
  CLIENT_REVOKED_ERROR,
  requireIdentityOwnedSignedHighRiskRequest,
  requireSignedHighRiskRequest,
} = require("../requestSigning");
const {
  assertPrincipalViaIdentity,
  remoteIdentityOperationsEnabled,
} = require("../authz/identityOperationsClient");
const SystemSettings = DataAccessCenter.adminSystem;
const AuthSession = DataAccessCenter.adminSystem.authSession;
const AuthIdentity = DataAccessCenter.authIdentity.model;
const User = DataAccessCenter.authIdentity.shadowUser;
const EncryptionMgr = new EncryptionManager();
const { isAuthEpochCompatible } = require("../authz/authCompatibility");

function rejectAuthentication(response, status, payload, reasonCode) {
  const normalizedReasonCode = String(
    reasonCode || "authentication_failed"
  ).slice(0, 96);
  response.locals.authFailureReason = normalizedReasonCode;
  const responsePayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload, reasonCode: normalizedReasonCode }
      : payload;
  return response.status(status).json(responsePayload);
}

async function validateRequest(request, response, next) {
  if (applyCodexDevAuthBypass(request, response)) {
    await attachAuthenticatedClientContext({
      request,
      user: response.locals.user,
    });
    return requireSignedHighRiskRequest(request, response, next);
  }

  if (remoteIdentityOperationsEnabled()) {
    return validateIdentityOwnedRequest(request, response, next);
  }

  const multiUserMode = await SystemSettings.isMultiUserMode();
  response.locals.multiUserMode = multiUserMode;
  if (multiUserMode)
    return await validateMultiUserRequest(request, response, next);

  // When in development passthrough auth token for ease of development.
  // Or if the user simply did not set an Auth token or JWT Secret
  if (
    process.env.NODE_ENV === "development" ||
    !process.env.AUTH_TOKEN ||
    !process.env.JWT_SECRET
  ) {
    return requireSignedHighRiskRequest(request, response, next);
  }

  if (!process.env.AUTH_TOKEN) {
    return rejectAuthentication(
      response,
      401,
      {
        error: "You need to set an AUTH_TOKEN environment variable.",
      },
      "server_auth_not_configured"
    );
  }

  const auth = request.header("Authorization");
  const token = auth ? auth.split(" ")[1] : null;

  if (!token) {
    return rejectAuthentication(
      response,
      401,
      { error: "No auth token found." },
      "missing_session_storage"
    );
  }

  const bcrypt = require("bcryptjs");
  const decoded = decodeJWT(token);
  if (!isAuthEpochCompatible(decoded))
    return sessionRejected(response, "session_epoch_incompatible");
  const sessionId = decoded?.sid;

  if (sessionId) {
    const sessionResult = await AuthSession.validate(sessionId, {
      authoritative: requiresAuthoritativeSession(request),
      subjectType: "instance",
      tokenVersion: decoded.tokenVersion || 1,
    });
    if (
      !sessionResult.valid ||
      !AuthSession.verifySingleUserAuthVersion(decoded.authVersion)
    ) {
      return sessionRejected(response, sessionResult.code);
    }
    response.locals.authSession = sessionResult.session;
    return requireSignedHighRiskRequest(request, response, next);
  }

  const { p } = decoded;

  if (p === null || !/\w{32}:\w{32}/.test(p)) {
    return rejectAuthentication(
      response,
      401,
      { error: "Token expired or failed validation." },
      "invalid_auth_token"
    );
  }

  // Since the blame of this comment we have been encrypting the `p` property of JWTs with the persistent
  // encryptionManager PEM's. This prevents us from storing the `p` unencrypted in the JWT itself, which could
  // be unsafe. As a consequence, existing JWTs with invalid `p` values that do not match the regex
  // in ln:44 will be marked invalid so they can be logged out and forced to log back in and obtain an encrypted token.
  // This kind of methodology only applies to single-user password mode.
  if (!(await AuthSession.legacySingleUserTokenAllowed())) {
    return rejectAuthentication(
      response,
      401,
      {
        error: "Legacy session expired.",
        code: "session_revoked",
      },
      "session_revoked"
    );
  }

  let legacyPassword = null;
  try {
    legacyPassword = EncryptionMgr.decrypt(p);
  } catch {}
  const authTokenHash = await bcrypt.hash(process.env.AUTH_TOKEN, 10);
  if (!(await bcrypt.compare(String(legacyPassword || ""), authTokenHash))) {
    return rejectAuthentication(
      response,
      401,
      { error: "Invalid auth credentials." },
      "invalid_auth_credentials"
    );
  }

  response.locals.legacySingleUserToken = true;

  return requireSignedHighRiskRequest(request, response, next);
}

async function validateIdentityOwnedRequest(request, response, next) {
  const token = request.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return rejectAuthentication(
      response,
      401,
      { error: "No auth token found." },
      "missing_session_storage"
    );
  }
  try {
    const client = getClientContext(request);
    const result = await assertPrincipalViaIdentity({ request, client });
    const principal = result?.principal;
    if (!principal?.sessionId)
      return sessionRejected(response, "session_invalid");
    response.locals.multiUserMode = principal.subjectType === "user";
    response.locals.authSession = {
      sessionId: principal.sessionId,
      authUserId: principal.authUserId,
      clientId: principal.clientId,
      authMode: principal.authMode,
      tokenVersion: principal.tokenVersion,
    };
    if (response.locals.multiUserMode) {
      if (!result.user?.id)
        return sessionRejected(response, "account_unavailable");
      response.locals.user = result.user;
    }
    const clientContext = {
      ...client,
      userId: result.user?.id || principal.userId || null,
      clientId: principal.clientId || client.clientId,
    };
    request.clientContext = clientContext;
    response.locals.clientContext = clientContext;
    if (
      principal.clientId &&
      (clientContext.legacy || clientContext.clientId !== principal.clientId)
    ) {
      return sessionRejected(response, "session_client_mismatch");
    }
    return requireIdentityOwnedSignedHighRiskRequest(request, response, next);
  } catch (error) {
    if (Number(error?.httpStatus) >= 400 && Number(error?.httpStatus) < 500) {
      return sessionRejected(
        response,
        error.reasonCode || error.code || "session_invalid"
      );
    }
    return rejectAuthentication(
      response,
      503,
      {
        success: false,
        error: "identity_capability_unavailable",
        retryable: true,
      },
      "identity_capability_unavailable"
    );
  }
}

function validatedRequest(request, response, next) {
  return validateRequest(request, response, next).catch((error) => {
    if (response.headersSent) return next(error);

    const unavailable = isAuthenticationStateUnavailable(error);
    console.error("[validatedRequest] request validation failed", {
      name: error?.name || "Error",
      code: error?.code || null,
      path: request.originalUrl || request.path || null,
      unavailable,
    });

    return rejectAuthentication(
      response,
      unavailable ? 503 : 500,
      {
        success: false,
        error: unavailable
          ? "authentication_state_unavailable"
          : "request_validation_failed",
        retryable: unavailable,
      },
      unavailable
        ? "authentication_state_unavailable"
        : "request_validation_failed"
    );
  });
}

function isAuthenticationStateUnavailable(error) {
  const name = String(error?.name || "");
  const code = String(error?.code || "");
  return (
    name.startsWith("PrismaClient") ||
    /^P\d{4}$/.test(code) ||
    code === "database_operation_failed" ||
    code === "AUTH_DB_FOREIGN_KEY_VIOLATION"
  );
}

async function validateMultiUserRequest(request, response, next) {
  const auth = request.header("Authorization");
  const token = auth ? auth.split(" ")[1] : null;

  if (!token) {
    return rejectAuthentication(
      response,
      401,
      { error: "No auth token found." },
      "missing_session_storage"
    );
  }

  const valid = decodeJWT(token);
  if (!valid || !valid.id) {
    return rejectAuthentication(
      response,
      401,
      { error: "Invalid auth token." },
      "invalid_auth_token"
    );
  }
  if (!isAuthEpochCompatible(valid))
    return sessionRejected(response, "session_epoch_incompatible");

  const idleState = jwtIdleState(valid);
  if (idleState.idleExpired) {
    return rejectAuthentication(
      response,
      401,
      {
        error: "Session expired due to inactivity.",
        idleExpiresAt: idleState.idleExpiresAt,
        idleRemainingMs: 0,
      },
      "session_idle_expired"
    );
  }

  const sessionId = valid.sid;
  let authSession = null;
  if (sessionId) {
    const sessionResult = await AuthSession.validate(sessionId, {
      authoritative: requiresAuthoritativeSession(request),
      subjectType: "user",
      tokenVersion: valid.tokenVersion || 1,
    });
    if (!sessionResult.valid) {
      return sessionRejected(response, sessionResult.code);
    }
    authSession = sessionResult.session;
    response.locals.authSession = authSession;
  } else if (AuthSession.enabled() && multiUserSessionRequired()) {
    return sessionRejected(response, "session_missing");
  }

  const shadow = await User._get({ id: valid.id });
  if (!shadow) {
    return rejectAuthentication(
      response,
      401,
      { error: "Invalid auth for user." },
      "account_unavailable"
    );
  }

  let authUser = valid.authUserId
    ? await AuthIdentity.findById(valid.authUserId)
    : null;
  if (!authUser && shadow.authUserId) {
    authUser = await AuthIdentity.findById(shadow.authUserId);
  }
  if (!authUser) {
    authUser = await AuthIdentity.bootstrapAuthUserFromShadow(shadow);
  }

  if (
    authSession?.authUserId &&
    Number(authSession.authUserId) !== Number(authUser?.id)
  ) {
    return sessionRejected(response, "session_subject_mismatch");
  }

  if (!authUser || !(await AuthIdentity.canLoginInCurrentEnvAsync(authUser))) {
    return rejectAuthentication(
      response,
      401,
      { error: "Invalid auth for user." },
      "account_unavailable"
    );
  }

  const syncedUser = await AuthIdentity.ensureShadowUser(authUser);
  response.locals.user = User.filterFields(syncedUser);
  const clientContext = await attachAuthenticatedClientContext({
    request,
    user: response.locals.user,
  });
  response.locals.clientContext = clientContext;

  const tokenClientId = sessionClientIdFromToken(valid);
  if (tokenClientId) {
    if (clientContext.legacy || clientContext.clientId !== tokenClientId) {
      return rejectAuthentication(
        response,
        401,
        { error: "Session client mismatch." },
        "session_client_mismatch"
      );
    }

    const client = await getClientRecord({
      userId: response.locals.user.id,
      clientId: tokenClientId,
      includeRevoked: true,
    });
    if (client?.revokedAt) {
      return rejectAuthentication(
        response,
        403,
        {
          success: false,
          error: CLIENT_REVOKED_ERROR,
        },
        "client_revoked"
      );
    }
  }

  return requireSignedHighRiskRequest(request, response, next);
}

function requiresAuthoritativeSession(request) {
  const path = String(request.originalUrl || request.path || "").toLowerCase();
  return /\/(security|sessions?|auth|passkey|trusted-device|client|account|user|admin|sync\/v2\/mutations)/.test(
    path
  );
}

function multiUserSessionRequired(env = process.env) {
  if (env.ATHENA_SESSION_V2_REQUIRE_MULTI === "true") return true;
  if (env.ATHENA_SESSION_V2_REQUIRE_MULTI === "false") return false;
  return env.NODE_ENV === "production";
}

function sessionRejected(response, reason = "session_revoked") {
  const expired = /expired/.test(String(reason));
  return rejectAuthentication(
    response,
    401,
    {
      success: false,
      error: "session_revoked",
      reason,
      ...(expired ? { expired: true } : {}),
    },
    reason
  );
}

module.exports = {
  validatedRequest,
};
