const crypto = require("crypto");
const { reqBody } = require("../http");
const { authSessionFingerprintFromRequest } = require("./vaultAccessGrants");

const DEFAULT_SENSITIVE_SESSION_TTL_MS = 5 * 60 * 1000;
const SENSITIVE_SESSION_HEADER = "X-Athena-Sensitive-Session";
const sensitiveSessions = new Map();

function numericEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ttlMs() {
  return numericEnv(
    "ATHENA_SENSITIVE_SESSION_TTL_MS",
    DEFAULT_SENSITIVE_SESSION_TTL_MS
  );
}

function now() {
  return Date.now();
}

function compactString(value, maxLength = 512) {
  if (value === null || value === undefined) return null;
  const next = String(value).trim();
  if (!next) return null;
  return next.slice(0, maxLength);
}

function normalizeUserId(value) {
  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function hashResourceId(value = "") {
  const raw = compactString(value, 2048) || "global";
  return crypto.createHash("sha256").update(raw).digest("base64url");
}

function cleanupExpiredSensitiveSessions() {
  const current = now();
  for (const [token, session] of sensitiveSessions.entries()) {
    if (!session || session.expiresAt <= current || session.status !== "active")
      sensitiveSessions.delete(token);
  }
}

function issueSensitiveSession({
  userId,
  clientId,
  resourceType = "sensitive",
  resourceId = "global",
  ownerScope = null,
  trustLevel = "verified",
  method = "unknown",
  requestId = null,
  sessionFingerprint = null,
  ttl = ttlMs(),
} = {}) {
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  if (!ownerId || !normalizedClientId) return null;

  cleanupExpiredSensitiveSessions();
  const token = `ssn_${crypto.randomBytes(32).toString("base64url")}`;
  const issuedAt = now();
  const expiresAt = issuedAt + ttl;
  const session = {
    token,
    sessionId: token,
    userId: ownerId,
    clientId: normalizedClientId,
    resourceType: compactString(resourceType, 96) || "sensitive",
    resourceIdHash: hashResourceId(resourceId),
    ownerScope: compactString(ownerScope, 256),
    trustLevel: compactString(trustLevel, 64) || "verified",
    method: compactString(method, 64) || "unknown",
    requestId: compactString(requestId, 128),
    sessionFingerprint: compactString(sessionFingerprint, 128),
    issuedAt,
    expiresAt,
    lastHeartbeatAt: issuedAt,
    status: "active",
  };
  sensitiveSessions.set(token, session);
  return publicSensitiveSession(session, ttl);
}

function publicSensitiveSession(session, ttl = null) {
  if (!session) return null;
  const remainingTtl = Math.max(0, session.expiresAt - now());
  return {
    sessionId: session.sessionId,
    token: session.token,
    resourceType: session.resourceType,
    ownerScope: session.ownerScope,
    trustLevel: session.trustLevel,
    createdAt: new Date(session.issuedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    ttlMs: Number.isFinite(ttl) ? ttl : remainingTtl,
    status: session.status,
  };
}

function sensitiveSessionTokenFromRequest(request) {
  const header =
    request?.header?.(SENSITIVE_SESSION_HEADER) ||
    request?.headers?.[SENSITIVE_SESSION_HEADER.toLowerCase()];
  if (header) return compactString(header, 512);

  const body = reqBody(request) || {};
  return compactString(
    body.sensitiveSession || body.sensitiveSessionToken,
    512
  );
}

function validateSensitiveSession({
  token,
  userId,
  clientId,
  resourceType = null,
  resourceId = null,
  ownerScope = null,
  sessionFingerprint = null,
  heartbeat = false,
} = {}) {
  cleanupExpiredSensitiveSessions();
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  const session = token ? sensitiveSessions.get(String(token)) : null;
  const expectedResourceIdHash =
    resourceId === null || resourceId === undefined
      ? null
      : hashResourceId(resourceId);
  const resourceMatches =
    !resourceType || session?.resourceType === compactString(resourceType, 96);
  const idMatches =
    !expectedResourceIdHash ||
    session?.resourceIdHash === expectedResourceIdHash;
  const ownerScopeMatches =
    !ownerScope || session?.ownerScope === compactString(ownerScope, 256);
  const failureReason = !session
    ? "missing_or_expired"
    : !ownerId
      ? "missing_user"
      : !normalizedClientId
        ? "missing_client"
        : session.status !== "active"
          ? "inactive"
          : session.userId !== ownerId
            ? "user_mismatch"
            : session.clientId !== normalizedClientId
              ? "client_mismatch"
              : !resourceMatches
                ? "resource_type_mismatch"
                : !idMatches
                  ? "resource_id_mismatch"
                  : !ownerScopeMatches
                    ? "owner_scope_mismatch"
                    : session.sessionFingerprint &&
                        session.sessionFingerprint !==
                          compactString(sessionFingerprint, 128)
                      ? "auth_session_mismatch"
                      : session.expiresAt <= now()
                        ? "expired"
                        : null;

  if (
    !session ||
    !ownerId ||
    !normalizedClientId ||
    session.status !== "active" ||
    session.userId !== ownerId ||
    session.clientId !== normalizedClientId ||
    !resourceMatches ||
    !idMatches ||
    !ownerScopeMatches ||
    (session.sessionFingerprint &&
      session.sessionFingerprint !== compactString(sessionFingerprint, 128)) ||
    session.expiresAt <= now()
  ) {
    if (token && session) sensitiveSessions.delete(String(token));
    return {
      ok: false,
      error: "sensitive_session_required",
      reason: failureReason || "unknown",
      present: !!session,
    };
  }

  if (heartbeat) session.lastHeartbeatAt = now();
  return { ok: true, session };
}

function validateSensitiveSessionForRequest(
  request,
  { userId, clientId, resourceType, resourceId, ownerScope, heartbeat } = {}
) {
  const token = sensitiveSessionTokenFromRequest(request);
  return validateSensitiveSession({
    token,
    userId,
    clientId,
    resourceType,
    resourceId,
    ownerScope,
    heartbeat,
    sessionFingerprint: authSessionFingerprintFromRequest(request),
  });
}

function revokeSensitiveSession({
  token,
  userId = null,
  clientId = null,
} = {}) {
  const session = token ? sensitiveSessions.get(String(token)) : null;
  if (!session) return false;
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  if (ownerId && session.userId !== ownerId) return false;
  if (normalizedClientId && session.clientId !== normalizedClientId)
    return false;
  sensitiveSessions.delete(String(token));
  return true;
}

function revokeSensitiveSessions({
  userId,
  clientId = null,
  resourceType = null,
  resourceId = null,
  ownerScope = null,
} = {}) {
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  const normalizedResourceType = compactString(resourceType, 96);
  const normalizedOwnerScope = compactString(ownerScope, 256);
  const resourceIdHash =
    resourceId === null || resourceId === undefined
      ? null
      : hashResourceId(resourceId);
  if (!ownerId) return 0;
  let count = 0;
  for (const [token, session] of sensitiveSessions.entries()) {
    if (
      session.userId === ownerId &&
      (!normalizedClientId || session.clientId === normalizedClientId) &&
      (!normalizedResourceType ||
        session.resourceType === normalizedResourceType) &&
      (!resourceIdHash || session.resourceIdHash === resourceIdHash) &&
      (!normalizedOwnerScope || session.ownerScope === normalizedOwnerScope)
    ) {
      sensitiveSessions.delete(token);
      count += 1;
    }
  }
  return count;
}

function sensitiveSessionSnapshot({ userId = null, clientId = null } = {}) {
  cleanupExpiredSensitiveSessions();
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  return [...sensitiveSessions.values()]
    .filter((session) => {
      if (ownerId && session.userId !== ownerId) return false;
      if (normalizedClientId && session.clientId !== normalizedClientId)
        return false;
      return true;
    })
    .map((session) => ({
      sessionId: session.sessionId ? "[redacted-sensitive-session]" : null,
      resourceType: session.resourceType,
      ownerScope: session.ownerScope ? "[redacted-owner-scope]" : null,
      trustLevel: session.trustLevel,
      status: session.status,
      ageMs: Math.max(0, now() - session.issuedAt),
      expiresInMs: Math.max(0, session.expiresAt - now()),
      lastHeartbeatAgeMs: Math.max(0, now() - session.lastHeartbeatAt),
    }));
}

module.exports = {
  DEFAULT_SENSITIVE_SESSION_TTL_MS,
  SENSITIVE_SESSION_HEADER,
  issueSensitiveSession,
  publicSensitiveSession,
  revokeSensitiveSession,
  revokeSensitiveSessions,
  sensitiveSessionSnapshot,
  sensitiveSessionTokenFromRequest,
  ttlMs,
  validateSensitiveSession,
  validateSensitiveSessionForRequest,
};
