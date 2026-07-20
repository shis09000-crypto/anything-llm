const { EncryptionManager } = require("../EncryptionManager");
const { decodeJWT } = require("../http");
const { applyCodexDevAuthBypass } = require("../codexDevAuthBypass");
const { jwtIdleState, sessionClientIdFromToken } = require("../sessionIdle");
const { DataAccessCenter } = require("../dataAccess");
const {
  attachAuthenticatedClientContext,
  getClientRecord,
} = require("../clientIdentity");
const {
  CLIENT_REVOKED_ERROR,
  requireSignedHighRiskRequest,
} = require("../requestSigning");
const SystemSettings = DataAccessCenter.adminSystem;
const AuthSession = DataAccessCenter.adminSystem.authSession;
const AuthIdentity = DataAccessCenter.authIdentity.model;
const User = DataAccessCenter.authIdentity.shadowUser;
const EncryptionMgr = new EncryptionManager();

async function validatedRequest(request, response, next) {
  if (applyCodexDevAuthBypass(request, response)) {
    await attachAuthenticatedClientContext({
      request,
      user: response.locals.user,
    });
    return requireSignedHighRiskRequest(request, response, next);
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
    response.status(401).json({
      error: "You need to set an AUTH_TOKEN environment variable.",
    });
    return;
  }

  const auth = request.header("Authorization");
  const token = auth ? auth.split(" ")[1] : null;

  if (!token) {
    response.status(401).json({
      error: "No auth token found.",
    });
    return;
  }

  const bcrypt = require("bcryptjs");
  const decoded = decodeJWT(token);
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
    response.status(401).json({
      error: "Token expired or failed validation.",
    });
    return;
  }

  // Since the blame of this comment we have been encrypting the `p` property of JWTs with the persistent
  // encryptionManager PEM's. This prevents us from storing the `p` unencrypted in the JWT itself, which could
  // be unsafe. As a consequence, existing JWTs with invalid `p` values that do not match the regex
  // in ln:44 will be marked invalid so they can be logged out and forced to log back in and obtain an encrypted token.
  // This kind of methodology only applies to single-user password mode.
  if (!(await AuthSession.legacySingleUserTokenAllowed())) {
    response.status(401).json({
      error: "Legacy session expired.",
      code: "session_revoked",
    });
    return;
  }

  let legacyPassword = null;
  try {
    legacyPassword = EncryptionMgr.decrypt(p);
  } catch {}
  const authTokenHash = await bcrypt.hash(process.env.AUTH_TOKEN, 10);
  if (!(await bcrypt.compare(String(legacyPassword || ""), authTokenHash))) {
    response.status(401).json({
      error: "Invalid auth credentials.",
    });
    return;
  }

  response.locals.legacySingleUserToken = true;

  return requireSignedHighRiskRequest(request, response, next);
}

async function validateMultiUserRequest(request, response, next) {
  const auth = request.header("Authorization");
  const token = auth ? auth.split(" ")[1] : null;

  if (!token) {
    response.status(401).json({
      error: "No auth token found.",
    });
    return;
  }

  const valid = decodeJWT(token);
  if (!valid || !valid.id) {
    response.status(401).json({
      error: "Invalid auth token.",
    });
    return;
  }

  const idleState = jwtIdleState(valid);
  if (idleState.idleExpired) {
    response.status(401).json({
      error: "Session expired due to inactivity.",
      idleExpiresAt: idleState.idleExpiresAt,
      idleRemainingMs: 0,
    });
    return;
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
  } else if (
    AuthSession.enabled() &&
    process.env.ATHENA_SESSION_V2_REQUIRE_MULTI === "true"
  ) {
    return sessionRejected(response, "session_missing");
  }

  const shadow = await User._get({ id: valid.id });
  if (!shadow) {
    response.status(401).json({
      error: "Invalid auth for user.",
    });
    return;
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
    response.status(401).json({
      error: "Invalid auth for user.",
    });
    return;
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
      response.status(401).json({
        error: "Session client mismatch.",
      });
      return;
    }

    const client = await getClientRecord({
      userId: response.locals.user.id,
      clientId: tokenClientId,
      includeRevoked: true,
    });
    if (client?.revokedAt) {
      response.status(403).json({
        success: false,
        error: CLIENT_REVOKED_ERROR,
      });
      return;
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

function sessionRejected(response, reason = "session_revoked") {
  const expired = /expired/.test(String(reason));
  response.status(401).json({
    success: false,
    error: "session_revoked",
    reason,
    ...(expired ? { expired: true } : {}),
  });
}

module.exports = {
  validatedRequest,
};
