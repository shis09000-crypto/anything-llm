const crypto = require("crypto");
const { DataAccessCenter } = require("../dataAccess");
const { decodeJWT } = require("../http");
const {
  codexDevAuthUser,
  isCodexDevAuthBypassEnabled,
} = require("../codexDevAuthBypass");
const { getClientContext, getClientRecord } = require("../clientIdentity");
const { jwtIdleState, sessionClientIdFromToken } = require("../sessionIdle");
const {
  remoteIdentityOperationsEnabled,
  validateSessionViaIdentity,
} = require("./identityOperationsClient");

const REALTIME_TICKET_TTL_MS = 90_000;
const REALTIME_TICKET_MAX_TTL_MS = 120_000;
const REALTIME_REVALIDATE_MS = 5_000;
const REALTIME_PURPOSES = new Set([
  "broadcast",
  "agent",
  "crypto",
  "character-performance",
  "athena-3d-center",
]);

// Resolve repository surfaces only at the point of use. Sync and maintenance
// consumers intentionally provide narrow DataAccessCenter adapters and should
// not need to construct the entire authentication graph merely to import this
// module.
function systemSettings() {
  return DataAccessCenter.adminSystem;
}

function authSession() {
  return DataAccessCenter.adminSystem.authSession;
}

function authIdentity() {
  return DataAccessCenter.authIdentity.model;
}

function shadowUser() {
  return DataAccessCenter.authIdentity.shadowUser;
}

function realtimeTicketStore() {
  return DataAccessCenter.adminSystem.realtimeTicket;
}

function compact(value, maxLength = 256) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function bearerToken(request) {
  const header =
    request?.header?.("Authorization") || request?.headers?.authorization;
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function queryValue(request, name) {
  const value = request?.query?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function sessionRequired(env = process.env) {
  if (env.ATHENA_SESSION_V2 === "false") return false;
  if (env.ATHENA_REALTIME_REQUIRE_SESSION === "false") return false;
  if (env.ATHENA_REALTIME_REQUIRE_SESSION === "true") return true;
  return env.NODE_ENV === "production";
}

function legacyQueryTokenAllowed(env = process.env) {
  if (env.ATHENA_REALTIME_LEGACY_QUERY_TOKEN === "true") {
    if (env.NODE_ENV !== "production") return true;
    const expiresAt = Date.parse(
      String(env.ATHENA_REALTIME_LEGACY_QUERY_TOKEN_EXPIRES_AT || "")
    );
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }
  if (env.ATHENA_REALTIME_LEGACY_QUERY_TOKEN === "false") return false;
  return env.NODE_ENV !== "production";
}

function ticketTtlMs(env = process.env) {
  const value = Number(env.ATHENA_REALTIME_TICKET_TTL_MS);
  if (!Number.isFinite(value) || value <= 0) return REALTIME_TICKET_TTL_MS;
  return Math.min(
    Math.max(Math.round(value), 30_000),
    REALTIME_TICKET_MAX_TTL_MS
  );
}

function revalidationIntervalMs(env = process.env) {
  const value = Number(env.ATHENA_REALTIME_REVALIDATE_MS);
  const configured =
    Number.isFinite(value) && value > 0 ? value : REALTIME_REVALIDATE_MS;
  return env.NODE_ENV === "production"
    ? Math.min(Math.max(Math.round(configured), 1_000), REALTIME_REVALIDATE_MS)
    : Math.max(Math.round(configured), 1_000);
}

function realtimeAuthError(code, status = 401) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = status;
  return error;
}

function normalizePurpose(value) {
  const purpose = compact(value, 32)?.toLowerCase();
  if (!REALTIME_PURPOSES.has(purpose)) {
    throw realtimeAuthError("realtime_ticket_invalid_purpose", 400);
  }
  return purpose;
}

function claimsFromRequest(request) {
  const token = bearerToken(request);
  if (!token) return null;
  const decoded = decodeJWT(token);
  if (!decoded || (!decoded.id && !decoded.sid)) return null;
  return safeRealtimeClaims(decoded);
}

function safeRealtimeClaims(claims = {}) {
  return {
    id: claims.id || null,
    authUserId: claims.authUserId || null,
    sid: claims.sid || null,
    tokenVersion: claims.tokenVersion || 1,
    clientId: claims.clientId || claims.did || claims.deviceId || null,
    authVersion: claims.authVersion || null,
    role: claims.role || null,
    lastUserActionAt: claims.lastUserActionAt || null,
    iat: claims.iat || null,
    exp: claims.exp || null,
    developmentBypass: claims.developmentBypass === true,
  };
}

async function issueRealtimeTicket({
  request,
  response,
  purpose,
  resourceId = null,
} = {}) {
  const normalizedPurpose = normalizePurpose(purpose);
  const normalizedResourceId = compact(resourceId, 192);
  const multiUser =
    response?.locals?.multiUserMode ??
    (await systemSettings().isMultiUserMode());
  let claims = claimsFromRequest(request);

  if (!claims && isCodexDevAuthBypassEnabled(request)) {
    const user = response?.locals?.user || codexDevAuthUser();
    claims = {
      id: user?.id || null,
      authUserId: user?.authUserId || null,
      role: user?.role || "admin",
      developmentBypass: true,
    };
  }

  if (!claims && !(process.env.NODE_ENV === "development" && !multiUser)) {
    throw realtimeAuthError("realtime_session_required");
  }

  if (multiUser && !response?.locals?.user && !claims?.developmentBypass) {
    throw realtimeAuthError("realtime_identity_required");
  }
  if (sessionRequired() && !claims?.sid) {
    throw realtimeAuthError("realtime_session_required");
  }

  const clientContext = getClientContext(request, {
    user: response?.locals?.user || null,
  });
  const ticket = `rt_${crypto.randomBytes(32).toString("base64url")}`;
  const expiresAt = Date.now() + ticketTtlMs();
  await realtimeTicketStore().issue({
    ticket,
    entry: {
      purpose: normalizedPurpose,
      appEnv: String(
        process.env.APP_ENV || process.env.NODE_ENV || "development"
      ),
      resourceId: normalizedResourceId,
      claims,
      multiUser: !!multiUser,
      clientId: clientContext?.clientId || null,
      expiresAt,
    },
  });
  return {
    ticket,
    expiresAt: new Date(expiresAt).toISOString(),
    expiresInMs: expiresAt - Date.now(),
  };
}

async function consumeRealtimeTicket({
  ticket,
  purpose,
  resourceId = null,
} = {}) {
  const key = compact(ticket, 512);
  if (!key) throw realtimeAuthError("realtime_ticket_required");
  const entry = await realtimeTicketStore().consume(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    throw realtimeAuthError("realtime_ticket_expired");
  }

  const normalizedPurpose = normalizePurpose(purpose);
  const normalizedResourceId = compact(resourceId, 192);
  if (entry.purpose !== normalizedPurpose) {
    throw realtimeAuthError("realtime_ticket_purpose_mismatch");
  }
  if (
    entry.resourceId &&
    (!normalizedResourceId || entry.resourceId !== normalizedResourceId)
  ) {
    throw realtimeAuthError("realtime_ticket_resource_mismatch");
  }
  return entry;
}

async function resolveUserFromClaims(claims) {
  if (!claims?.id) return null;
  const users = shadowUser();
  const identities = authIdentity();
  const shadow = users._get
    ? await users._get({ id: Number(claims.id) })
    : await users.get({ id: Number(claims.id) });
  if (!shadow) throw realtimeAuthError("realtime_identity_invalid");

  let authUser = claims.authUserId
    ? await identities.findById(claims.authUserId)
    : null;
  if (!authUser && shadow.authUserId) {
    authUser = await identities.findById(shadow.authUserId);
  }
  if (!authUser) {
    authUser = await identities.bootstrapAuthUserFromShadow(shadow);
  }
  if (!authUser || !(await identities.canLoginInCurrentEnvAsync(authUser))) {
    throw realtimeAuthError("realtime_identity_revoked");
  }
  const synced = await identities.ensureShadowUser(authUser);
  return users.filterFields ? users.filterFields(synced) : synced;
}

async function validateClaims({ request, claims, multiUser, authoritative }) {
  if (!claims) {
    if (process.env.NODE_ENV === "development" && !multiUser) {
      return { user: null, session: null, claims: {} };
    }
    throw realtimeAuthError("realtime_session_required");
  }

  if (claims.developmentBypass && process.env.NODE_ENV !== "production") {
    const user = multiUser ? await resolveUserFromClaims(claims) : null;
    return { user, session: null, claims };
  }

  if (claims.id && jwtIdleState(claims).idleExpired) {
    throw realtimeAuthError("realtime_session_idle_expired");
  }

  if (remoteIdentityOperationsEnabled()) {
    const validated = await validateSessionViaIdentity({ claims });
    const ownerPrincipal = validated?.principal || null;
    if (!ownerPrincipal?.sessionId) {
      throw realtimeAuthError("realtime_session_invalid");
    }
    const users = shadowUser();
    const shadow = multiUser
      ? users._get
        ? await users._get({ id: Number(ownerPrincipal.userId) })
        : await users.get({ id: Number(ownerPrincipal.userId) })
      : null;
    if (multiUser && !shadow)
      throw realtimeAuthError("realtime_identity_invalid");
    const user = shadow
      ? users.filterFields
        ? users.filterFields(shadow)
        : shadow
      : null;
    const clientContext = getClientContext(request, { user });
    if (
      ownerPrincipal.clientId &&
      (clientContext.legacy ||
        clientContext.clientId !== ownerPrincipal.clientId)
    ) {
      throw realtimeAuthError("realtime_session_client_mismatch");
    }
    return {
      user,
      session: {
        sessionId: ownerPrincipal.sessionId,
        authUserId: ownerPrincipal.authUserId,
        clientId: ownerPrincipal.clientId,
        tokenVersion: ownerPrincipal.tokenVersion,
        authMode: ownerPrincipal.authMode,
      },
      claims,
      clientContext,
    };
  }

  const subjectType = multiUser ? "user" : "instance";
  let session = null;
  if (claims.sid) {
    const sessions = authSession();
    const result = await sessions.validate(claims.sid, {
      authoritative,
      subjectType,
      tokenVersion: claims.tokenVersion || 1,
    });
    if (!result.valid) {
      throw realtimeAuthError(result.code || "realtime_session_invalid");
    }
    session = result.session;
    if (
      !multiUser &&
      !sessions.verifySingleUserAuthVersion(claims.authVersion)
    ) {
      throw realtimeAuthError("realtime_session_version_mismatch");
    }
  } else if (sessionRequired()) {
    throw realtimeAuthError("realtime_session_required");
  }

  const user = multiUser ? await resolveUserFromClaims(claims) : null;
  if (
    multiUser &&
    session?.authUserId &&
    Number(session.authUserId) !== Number(user?.authUserId)
  ) {
    throw realtimeAuthError("realtime_session_subject_mismatch");
  }

  const clientContext = getClientContext(request, { user });
  const tokenClientId = sessionClientIdFromToken(claims);
  if (
    tokenClientId &&
    (clientContext.legacy || clientContext.clientId !== tokenClientId)
  ) {
    throw realtimeAuthError("realtime_session_client_mismatch");
  }
  if (multiUser && tokenClientId) {
    const client = await getClientRecord({
      userId: user.id,
      clientId: tokenClientId,
      includeRevoked: true,
    });
    if (client?.revokedAt)
      throw realtimeAuthError("realtime_client_revoked", 403);
  }

  return { user, session, claims, clientContext };
}

async function authenticateRealtimeRequest({
  request,
  purpose,
  resourceId = null,
  authoritative = true,
} = {}) {
  const multiUser = await systemSettings().isMultiUserMode();
  const ticket = queryValue(request, "realtimeTicket");
  let claims = null;
  let source = "authorization_header";
  let ticketEntry = null;

  if (ticket) {
    ticketEntry = await consumeRealtimeTicket({ ticket, purpose, resourceId });
    claims = ticketEntry.claims;
    source = "one_time_ticket";
    if (ticketEntry.multiUser !== !!multiUser) {
      throw realtimeAuthError("realtime_ticket_environment_mismatch");
    }
    const currentAppEnv = String(
      process.env.APP_ENV || process.env.NODE_ENV || "development"
    );
    if (ticketEntry.appEnv !== currentAppEnv) {
      throw realtimeAuthError("realtime_ticket_environment_mismatch");
    }
  } else {
    claims = claimsFromRequest(request);
    if (!claims) {
      const legacyToken = queryValue(request, "token");
      if (legacyToken && legacyQueryTokenAllowed()) {
        claims = safeRealtimeClaims(
          decodeJWT(decodeURIComponent(String(legacyToken))) || {}
        );
        source = "legacy_query_token";
        console.warn("[realtime-auth] Legacy query token accepted", {
          purpose: normalizePurpose(purpose),
        });
      }
    }
    if (!claims && isCodexDevAuthBypassEnabled(request)) {
      const user = codexDevAuthUser();
      claims = {
        id: user?.id || null,
        authUserId: user?.authUserId || null,
        role: user?.role || "admin",
        developmentBypass: true,
      };
      source = "development_bypass";
    }
  }

  const principal = await validateClaims({
    request,
    claims,
    multiUser,
    authoritative,
  });
  if (
    ticketEntry?.clientId &&
    principal.clientContext?.clientId !== ticketEntry.clientId
  ) {
    throw realtimeAuthError("realtime_ticket_client_mismatch");
  }

  request.realtimePrincipal = {
    ...principal,
    multiUser: !!multiUser,
    source,
    purpose: normalizePurpose(purpose),
    resourceId: compact(resourceId, 192),
  };
  return request.realtimePrincipal;
}

async function revalidateRealtimePrincipal(request) {
  const current = request?.realtimePrincipal;
  if (!current) throw realtimeAuthError("realtime_principal_missing");
  const principal = await validateClaims({
    request,
    claims: current.claims,
    multiUser: current.multiUser,
    authoritative: true,
  });
  request.realtimePrincipal = { ...current, ...principal };
  return request.realtimePrincipal;
}

function monitorRealtimePrincipal({ request, socket, onRevoked = null } = {}) {
  if (!request?.realtimePrincipal?.claims?.sid) return () => {};
  let running = false;
  const timer = setInterval(async () => {
    if (running || socket?.readyState !== 1) return;
    running = true;
    try {
      await revalidateRealtimePrincipal(request);
    } catch (error) {
      clearInterval(timer);
      try {
        onRevoked?.(error);
        const retryable = error?.code === "identity_capability_unavailable";
        socket?.close?.(
          retryable ? 1013 : 1008,
          compact(error.code, 96) ||
            (retryable ? "identity_capability_unavailable" : "session_revoked")
        );
      } catch {}
    } finally {
      running = false;
    }
  }, revalidationIntervalMs());
  timer.unref?.();
  const stop = () => clearInterval(timer);
  socket?.once?.("close", stop);
  socket?.once?.("error", stop);
  return stop;
}

module.exports = {
  authenticateRealtimeRequest,
  issueRealtimeTicket,
  legacyQueryTokenAllowed,
  monitorRealtimePrincipal,
  revalidateRealtimePrincipal,
  sessionRequired,
  _internals: {
    consumeRealtimeTicket,
    revalidationIntervalMs,
    ticketTtlMs,
  },
};
