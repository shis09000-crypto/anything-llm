const crypto = require("crypto");
const { getClientContext } = require("../clientIdentity");
const {
  authSessionFingerprintFromRequest,
} = require("../authz/vaultAccessGrants");
const { reqBody } = require("../http");
const { hashLogValue } = require("../security/redaction");

const READER_DEBUG_ACCESS_HEADER = "X-Athena-Reader-Debug-Grant";
const DEFAULT_READER_DEBUG_ACCESS_TTL_MS = 5 * 60 * 1000;
const MAX_READER_DEBUG_ACCESS_TTL_MS = 15 * 60 * 1000;
const readerDebugAccessGrants = new Map();

const CONTENT_ENDPOINTS = new Set([
  "metadata",
  "original",
  "preview.pdf",
  "page-preview",
]);

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

function normalizeWorkspaceSlug(value) {
  return compactString(value, 128) || null;
}

function normalizeEndpoint(value) {
  const endpoint = compactString(value, 64)?.toLowerCase();
  if (endpoint === "preview") return "preview.pdf";
  return CONTENT_ENDPOINTS.has(endpoint) ? endpoint : null;
}

function normalizeEndpoints(values = null) {
  const rawValues = Array.isArray(values)
    ? values
    : values
      ? [values]
      : ["original", "preview.pdf", "page-preview"];
  const endpoints = rawValues.map(normalizeEndpoint).filter(Boolean);
  return [...new Set(endpoints)];
}

function clampTtl(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0)
    return DEFAULT_READER_DEBUG_ACCESS_TTL_MS;
  return Math.min(Math.max(1_000, ttl), MAX_READER_DEBUG_ACCESS_TTL_MS);
}

function debugGrantHash(debugGrantId = "") {
  return crypto
    .createHash("sha256")
    .update(String(debugGrantId))
    .digest("base64url");
}

function issueReaderDebugAccessGrant({
  request = null,
  userId,
  clientId,
  workspaceSlug = null,
  readerDocumentId,
  endpoints = null,
  ttlMs = null,
  requestId = null,
  commandId = null,
} = {}) {
  cleanupExpiredReaderDebugAccessGrants();
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  const normalizedReaderDocumentId = compactString(readerDocumentId, 128);
  const normalizedEndpoints = normalizeEndpoints(endpoints);
  if (
    !ownerId ||
    !normalizedClientId ||
    !normalizedReaderDocumentId ||
    !normalizedEndpoints.length
  ) {
    const error = new Error("Reader debug access grant scope is incomplete.");
    error.status = 400;
    error.code = "reader_debug_grant_scope_invalid";
    throw error;
  }

  const debugGrantId = `rdg_${crypto.randomBytes(32).toString("base64url")}`;
  const issuedAt = now();
  const ttl = clampTtl(ttlMs);
  const grant = {
    debugGrantHash: debugGrantHash(debugGrantId),
    userId: ownerId,
    clientId: normalizedClientId,
    workspaceSlug: normalizeWorkspaceSlug(workspaceSlug),
    readerDocumentId: normalizedReaderDocumentId,
    endpoints: normalizedEndpoints,
    issuedAt,
    expiresAt: issuedAt + ttl,
    status: "active",
    requestId: compactString(requestId, 128),
    commandId: compactString(commandId, 128),
    authSessionFingerprint: authSessionFingerprintFromRequest(request),
    lastUsedAt: null,
    useCount: 0,
  };
  readerDebugAccessGrants.set(grant.debugGrantHash, grant);
  return publicReaderDebugAccessGrant(debugGrantId, grant);
}

function publicReaderDebugAccessGrant(debugGrantId, grant) {
  return {
    debugGrantId,
    headerName: READER_DEBUG_ACCESS_HEADER,
    readerDocumentId: grant.readerDocumentId,
    workspaceSlug: grant.workspaceSlug,
    endpoints: [...grant.endpoints],
    createdAt: new Date(grant.issuedAt).toISOString(),
    expiresAt: new Date(grant.expiresAt).toISOString(),
    ttlMs: Math.max(0, grant.expiresAt - now()),
    status: grant.status,
  };
}

function readerDebugGrantIdFromRequest(request) {
  const header =
    request?.header?.(READER_DEBUG_ACCESS_HEADER) ||
    request?.headers?.[READER_DEBUG_ACCESS_HEADER.toLowerCase()];
  if (header) return compactString(header, 512);

  const body = reqBody(request) || {};
  return compactString(body.readerDebugGrantId || body.debugGrantId, 512);
}

function cleanupExpiredReaderDebugAccessGrants() {
  const current = now();
  for (const [hash, grant] of readerDebugAccessGrants.entries()) {
    if (!grant || grant.status !== "active" || grant.expiresAt <= current) {
      readerDebugAccessGrants.delete(hash);
    }
  }
}

function validateReaderDebugAccessGrant({
  debugGrantId,
  userId,
  clientId,
  workspaceSlug = null,
  readerDocumentId,
  endpoint,
  authSessionFingerprint = null,
} = {}) {
  cleanupExpiredReaderDebugAccessGrants();
  const normalizedDebugGrantId = compactString(debugGrantId, 512);
  const hash = normalizedDebugGrantId
    ? debugGrantHash(normalizedDebugGrantId)
    : null;
  const grant = hash ? readerDebugAccessGrants.get(hash) : null;
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  const normalizedWorkspaceSlug = normalizeWorkspaceSlug(workspaceSlug);
  const normalizedReaderDocumentId = compactString(readerDocumentId, 128);
  const normalizedEndpoint = normalizeEndpoint(endpoint);

  const failureReason = !normalizedDebugGrantId
    ? "missing_debug_grant"
    : !grant
      ? "missing_or_expired"
      : !ownerId
        ? "missing_user"
        : !normalizedClientId
          ? "missing_client"
          : grant.status !== "active"
            ? "inactive"
            : grant.userId !== ownerId
              ? "user_mismatch"
              : grant.clientId !== normalizedClientId
                ? "client_mismatch"
                : grant.workspaceSlug !== normalizedWorkspaceSlug
                  ? "workspace_mismatch"
                  : grant.readerDocumentId !== normalizedReaderDocumentId
                    ? "reader_document_mismatch"
                    : !normalizedEndpoint ||
                        !grant.endpoints.includes(normalizedEndpoint)
                      ? "endpoint_mismatch"
                      : grant.authSessionFingerprint &&
                          grant.authSessionFingerprint !==
                            compactString(authSessionFingerprint, 128)
                        ? "auth_session_mismatch"
                        : grant.expiresAt <= now()
                          ? "expired"
                          : null;

  if (failureReason) {
    if (hash && grant && ["inactive", "expired"].includes(failureReason)) {
      readerDebugAccessGrants.delete(hash);
    }
    return {
      ok: false,
      error: "reader_debug_grant_required",
      reason: failureReason,
      present: !!grant,
    };
  }

  grant.lastUsedAt = now();
  grant.useCount += 1;
  return {
    ok: true,
    grant: {
      readerDocumentId: grant.readerDocumentId,
      workspaceSlug: grant.workspaceSlug,
      endpoints: [...grant.endpoints],
      expiresAt: grant.expiresAt,
    },
  };
}

function validateReaderDebugAccessGrantForRequest(
  request,
  response,
  { workspaceSlug = null, readerDocumentId, endpoint } = {}
) {
  const context = getClientContext(request);
  return validateReaderDebugAccessGrant({
    debugGrantId: readerDebugGrantIdFromRequest(request),
    userId: response?.locals?.user?.id,
    clientId: context?.clientId,
    workspaceSlug,
    readerDocumentId,
    endpoint,
    authSessionFingerprint: authSessionFingerprintFromRequest(request),
  });
}

function revokeReaderDebugAccessGrant({
  debugGrantId,
  userId = null,
  clientId = null,
} = {}) {
  const normalizedDebugGrantId = compactString(debugGrantId, 512);
  const hash = normalizedDebugGrantId
    ? debugGrantHash(normalizedDebugGrantId)
    : null;
  const grant = hash ? readerDebugAccessGrants.get(hash) : null;
  if (!grant) return false;
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  if (ownerId && grant.userId !== ownerId) return false;
  if (normalizedClientId && grant.clientId !== normalizedClientId) return false;
  readerDebugAccessGrants.delete(hash);
  return true;
}

function readerDebugAccessGrantSnapshot({
  userId = null,
  clientId = null,
  readerDocumentId = null,
  workspaceSlug = undefined,
} = {}) {
  cleanupExpiredReaderDebugAccessGrants();
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  const normalizedReaderDocumentId = compactString(readerDocumentId, 128);
  const hasWorkspaceFilter = workspaceSlug !== undefined;
  const normalizedWorkspaceSlug = normalizeWorkspaceSlug(workspaceSlug);
  return [...readerDebugAccessGrants.values()]
    .filter((grant) => {
      if (ownerId && grant.userId !== ownerId) return false;
      if (normalizedClientId && grant.clientId !== normalizedClientId)
        return false;
      if (
        normalizedReaderDocumentId &&
        grant.readerDocumentId !== normalizedReaderDocumentId
      )
        return false;
      if (hasWorkspaceFilter && grant.workspaceSlug !== normalizedWorkspaceSlug)
        return false;
      return true;
    })
    .map((grant) => ({
      debugGrantId: "[redacted-reader-debug-grant]",
      debugGrantHash: hashLogValue(grant.debugGrantHash),
      readerDocumentId: grant.readerDocumentId,
      workspaceSlug: grant.workspaceSlug,
      endpoints: [...grant.endpoints],
      status: grant.status,
      ageMs: Math.max(0, now() - grant.issuedAt),
      expiresInMs: Math.max(0, grant.expiresAt - now()),
      useCount: grant.useCount,
      lastUsedAgeMs: grant.lastUsedAt
        ? Math.max(0, now() - grant.lastUsedAt)
        : null,
    }));
}

module.exports = {
  DEFAULT_READER_DEBUG_ACCESS_TTL_MS,
  READER_DEBUG_ACCESS_HEADER,
  issueReaderDebugAccessGrant,
  normalizeReaderDebugAccessEndpoints: normalizeEndpoints,
  readerDebugAccessGrantSnapshot,
  readerDebugGrantIdFromRequest,
  revokeReaderDebugAccessGrant,
  validateReaderDebugAccessGrant,
  validateReaderDebugAccessGrantForRequest,
  _private: {
    cleanupExpiredReaderDebugAccessGrants,
    debugGrantHash,
  },
};
