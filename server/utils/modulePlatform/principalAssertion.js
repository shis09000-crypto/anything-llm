const crypto = require("crypto");
const { canonicalJson, sha256 } = require("./canonical");
const {
  signHybridEnvelope,
  verifyHybridEnvelope,
} = require("../security/hybridSignature");
const { PURPOSES } = require("../security/cryptoSuiteRegistry");

const PRINCIPAL_ASSERTION_FORMAT = "athena-principal-assertion:v1";
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 60_000;

function assertionPayload({
  issuer,
  audience,
  authUserId,
  userId,
  sessionId,
  clientId,
  trustLevel,
  scopes = [],
  requestHash,
  correlationId,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  nonce = crypto.randomUUID(),
} = {}) {
  const boundedTtl = Math.max(1_000, Math.min(Number(ttlMs), MAX_TTL_MS));
  return {
    format: PRINCIPAL_ASSERTION_FORMAT,
    issuer: String(issuer || ""),
    audience: String(audience || ""),
    authUserId: String(authUserId || ""),
    userId: Number(userId),
    sessionId: String(sessionId || ""),
    clientId: String(clientId || ""),
    trustLevel: String(trustLevel || "low"),
    scopes: [...new Set(scopes.map(String))].sort(),
    requestHash: String(requestHash || ""),
    correlationId: String(correlationId || ""),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + boundedTtl).toISOString(),
    nonce: String(nonce),
  };
}

function validatePayload(payload = {}, { audience, now = Date.now() } = {}) {
  const findings = [];
  if (payload.format !== PRINCIPAL_ASSERTION_FORMAT)
    findings.push("format_invalid");
  for (const field of [
    "issuer",
    "audience",
    "authUserId",
    "sessionId",
    "clientId",
    "requestHash",
    "correlationId",
    "nonce",
  ])
    if (!String(payload[field] || "")) findings.push(`${field}_missing`);
  if (!Number.isSafeInteger(payload.userId) || payload.userId <= 0)
    findings.push("user_id_invalid");
  if (!Array.isArray(payload.scopes) || payload.scopes.some((v) => !v))
    findings.push("scopes_invalid");
  if (audience && payload.audience !== audience)
    findings.push("audience_invalid");
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt))
    findings.push("time_invalid");
  else {
    if (issuedAt > now + 5_000) findings.push("issued_in_future");
    if (expiresAt <= now) findings.push("expired");
    if (expiresAt - issuedAt > MAX_TTL_MS) findings.push("ttl_exceeded");
  }
  return { valid: findings.length === 0, findings };
}

function issuePrincipalAssertion({
  signers,
  policy = {
    threshold: 2,
    classicalRequired: true,
    pqRequired: true,
  },
  ...input
} = {}) {
  const payload = assertionPayload(input);
  const validation = validatePayload(payload, {
    audience: input.audience,
    now: input.now,
  });
  if (!validation.valid) {
    const error = new Error("principal_assertion_invalid");
    error.code = "PRINCIPAL_ASSERTION_INVALID";
    error.findings = validation.findings;
    throw error;
  }
  const body = canonicalJson(payload);
  return {
    payload,
    payloadHash: sha256(body),
    signature: signHybridEnvelope({
      data: Buffer.from(body),
      signers,
      policy,
      now: new Date(payload.issuedAt),
    }),
  };
}

function verifyPrincipalAssertion(
  assertion,
  { audience, trustedKeys, now = Date.now(), requireHybrid = true } = {}
) {
  const payload = assertion?.payload || {};
  const validation = validatePayload(payload, { audience, now });
  if (!Array.isArray(trustedKeys) || trustedKeys.length === 0)
    validation.findings.push("trusted_keys_missing");
  const body = canonicalJson(payload);
  if (assertion?.payloadHash !== sha256(body))
    validation.findings.push("payload_hash_mismatch");
  const signature = verifyHybridEnvelope({
    data: Buffer.from(body),
    envelope: assertion?.signature,
    purpose: PURPOSES.SECURITY_AUDIT_CHECKPOINT,
    trustedKeys,
    requirePolicy: {
      threshold: requireHybrid ? 2 : 1,
      classicalRequired: true,
      pqRequired: requireHybrid,
    },
  });
  return {
    valid: validation.findings.length === 0 && signature.valid,
    findings: [...validation.findings, ...signature.findings],
    payload,
  };
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  PRINCIPAL_ASSERTION_FORMAT,
  assertionPayload,
  issuePrincipalAssertion,
  validatePayload,
  verifyPrincipalAssertion,
};
