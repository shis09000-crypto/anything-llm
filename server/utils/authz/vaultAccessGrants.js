const crypto = require("crypto");
const { reqBody } = require("../http");

const DEFAULT_VAULT_GRANT_TTL_MS = 5 * 60 * 1000;
const VAULT_GRANT_HEADER = "X-Athena-Vault-Grant";
const vaultGrants = new Map();

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function vaultGrantRequired() {
  if (process.env.VAULT_GRANT_REQUIRED === "false") return false;
  if (process.env.ATHENA_VAULT_GRANT_REQUIRED === "false") return false;
  return envFlag("VAULT_GRANT_REQUIRED", true);
}

function normalizeUserId(value) {
  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function compactString(value, maxLength = 512) {
  if (value === null || value === undefined) return null;
  const next = String(value).trim();
  if (!next) return null;
  return next.slice(0, maxLength);
}

function authSessionFingerprintFromRequest(request) {
  const auth =
    request?.header?.("Authorization") || request?.headers?.authorization;
  const token = compactString(auth, 2048);
  if (!token) return null;
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function grantTtlMs() {
  const value = Number(process.env.ATHENA_VAULT_GRANT_TTL_MS);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_VAULT_GRANT_TTL_MS;
}

function now() {
  return Date.now();
}

function cleanupExpiredVaultGrants() {
  const current = now();
  for (const [token, grant] of vaultGrants.entries()) {
    if (!grant || grant.expiresAt <= current) vaultGrants.delete(token);
  }
}

function issueVaultAccessGrant({
  userId,
  clientId,
  method = "unknown",
  requestId = null,
  sessionFingerprint = null,
  ttlMs = grantTtlMs(),
} = {}) {
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  if (!ownerId || !normalizedClientId) return null;

  cleanupExpiredVaultGrants();
  const token = crypto.randomBytes(32).toString("base64url");
  const issuedAt = now();
  const expiresAt = issuedAt + ttlMs;
  vaultGrants.set(token, {
    userId: ownerId,
    clientId: normalizedClientId,
    method: compactString(method, 64) || "unknown",
    requestId: compactString(requestId, 128),
    sessionFingerprint: compactString(sessionFingerprint, 128),
    issuedAt,
    expiresAt,
  });
  return {
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    ttlMs,
  };
}

function vaultGrantTokenFromRequest(request) {
  const header =
    request?.header?.(VAULT_GRANT_HEADER) ||
    request?.headers?.[VAULT_GRANT_HEADER.toLowerCase()];
  if (header) return compactString(header, 512);

  const body = reqBody(request) || {};
  return compactString(body.vaultGrant || body.vaultGrantToken, 512);
}

function validateVaultAccessGrant({
  token,
  userId,
  clientId,
  sessionFingerprint = null,
  consume = false,
} = {}) {
  cleanupExpiredVaultGrants();
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  const grant = token ? vaultGrants.get(String(token)) : null;
  if (
    !grant ||
    !ownerId ||
    !normalizedClientId ||
    grant.userId !== ownerId ||
    grant.clientId !== normalizedClientId ||
    (grant.sessionFingerprint &&
      grant.sessionFingerprint !== compactString(sessionFingerprint, 128)) ||
    grant.expiresAt <= now()
  ) {
    if (token && grant) vaultGrants.delete(String(token));
    return null;
  }

  grant.lastUsedAt = now();
  if (consume) vaultGrants.delete(String(token));
  return grant;
}

function revokeVaultAccessGrants({ userId, clientId = null } = {}) {
  const ownerId = normalizeUserId(userId);
  const normalizedClientId = compactString(clientId, 256);
  if (!ownerId) return 0;
  let count = 0;
  for (const [token, grant] of vaultGrants.entries()) {
    if (
      grant.userId === ownerId &&
      (!normalizedClientId || grant.clientId === normalizedClientId)
    ) {
      vaultGrants.delete(token);
      count += 1;
    }
  }
  return count;
}

function validateVaultGrantForRequest(request, { userId, clientId } = {}) {
  if (!vaultGrantRequired()) return { ok: true, bypassed: true };
  const token = vaultGrantTokenFromRequest(request);
  const grant = validateVaultAccessGrant({
    token,
    userId,
    clientId,
    sessionFingerprint: authSessionFingerprintFromRequest(request),
  });
  if (!grant) {
    return { ok: false, error: "vault_access_grant_required" };
  }
  return { ok: true, grant };
}

module.exports = {
  DEFAULT_VAULT_GRANT_TTL_MS,
  VAULT_GRANT_HEADER,
  authSessionFingerprintFromRequest,
  cleanupExpiredVaultGrants,
  grantTtlMs,
  issueVaultAccessGrant,
  revokeVaultAccessGrants,
  validateVaultAccessGrant,
  validateVaultGrantForRequest,
  vaultGrantRequired,
  vaultGrantTokenFromRequest,
};
