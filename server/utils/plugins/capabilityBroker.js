const crypto = require("crypto");
const { resolveActiveKey } = require("../security/keyCustody");

const TOKEN_VERSION = "athena-plugin-capability:v1";
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 60_000;
const consumedNonces = new Map();

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function signingKey(keyDescriptor = resolveActiveKey()) {
  if (!keyDescriptor?.material) {
    const error = new Error("plugin_capability_signing_key_unavailable");
    error.code = "PLUGIN_CAPABILITY_SIGNING_KEY_UNAVAILABLE";
    throw error;
  }
  return {
    keyId: keyDescriptor.keyId,
    material: Buffer.from(
      crypto.hkdfSync(
        "sha256",
        keyDescriptor.material,
        Buffer.from("athena-plugin-capability-broker:v1"),
        Buffer.from("invocation-signing"),
        32
      )
    ),
  };
}

function encoded(value) {
  return Buffer.from(value).toString("base64url");
}

function decoded(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function pruneConsumed(now = Date.now()) {
  for (const [nonce, expiresAt] of consumedNonces) {
    if (expiresAt <= now) consumedNonces.delete(nonce);
  }
}

function issueInvocationCredential({
  serviceIdentity,
  tool,
  args = {},
  manifest = {},
  subject = "agent:unknown",
  maxCostUsd = null,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
  nonce = crypto.randomUUID(),
  keyDescriptor,
} = {}) {
  if (!serviceIdentity || !tool) {
    const error = new Error("plugin_capability_subject_and_tool_required");
    error.code = "PLUGIN_CAPABILITY_INVALID_REQUEST";
    throw error;
  }
  const boundedTtl = Math.max(1_000, Math.min(Number(ttlMs), MAX_TTL_MS));
  const key = signingKey(keyDescriptor);
  const payload = {
    version: TOKEN_VERSION,
    keyId: key.keyId,
    issuer: "athena-capability-broker",
    audience: String(serviceIdentity),
    subject: String(subject).slice(0, 160),
    tool: String(tool),
    argsHash: sha256(canonicalJson(args)),
    capabilityHash: sha256(canonicalJson(manifest)),
    maxCostUsd:
      Number.isFinite(Number(maxCostUsd)) && Number(maxCostUsd) >= 0
        ? Number(maxCostUsd)
        : null,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + boundedTtl).toISOString(),
    nonce: String(nonce),
  };
  const body = encoded(canonicalJson(payload));
  const signature = crypto
    .createHmac("sha256", key.material)
    .update(body)
    .digest("base64url");
  key.material.fill(0);
  return `${body}.${signature}`;
}

function authorizeInvocation({
  credential,
  serviceIdentity,
  tool,
  args = {},
  manifest = {},
  now = Date.now(),
  keyDescriptor,
  consume = true,
} = {}) {
  try {
    const [body, signature, extra] = String(credential || "").split(".");
    if (!body || !signature || extra) throw new Error("malformed");
    const payload = JSON.parse(decoded(body));
    const key = signingKey(keyDescriptor);
    if (payload.keyId !== key.keyId) throw new Error("key_mismatch");
    const expected = crypto
      .createHmac("sha256", key.material)
      .update(body)
      .digest();
    key.material.fill(0);
    const actual = Buffer.from(signature, "base64url");
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    )
      throw new Error("signature_invalid");
    if (payload.version !== TOKEN_VERSION) throw new Error("version_invalid");
    if (payload.audience !== String(serviceIdentity))
      throw new Error("audience_invalid");
    if (payload.tool !== String(tool)) throw new Error("tool_invalid");
    if (payload.argsHash !== sha256(canonicalJson(args)))
      throw new Error("arguments_invalid");
    if (payload.capabilityHash !== sha256(canonicalJson(manifest)))
      throw new Error("manifest_invalid");
    const expiresAt = Date.parse(payload.expiresAt);
    const issuedAt = Date.parse(payload.issuedAt);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(issuedAt))
      throw new Error("time_invalid");
    if (
      issuedAt > now + 5_000 ||
      expiresAt <= now ||
      expiresAt - issuedAt > MAX_TTL_MS
    )
      throw new Error("expired");
    pruneConsumed(now);
    if (consumedNonces.has(payload.nonce)) throw new Error("replayed");
    if (consume) consumedNonces.set(payload.nonce, expiresAt);
    return payload;
  } catch (cause) {
    const error = new Error("plugin_capability_credential_denied");
    error.code = "PLUGIN_CAPABILITY_CREDENTIAL_DENIED";
    error.reason = cause?.message || "invalid";
    throw error;
  }
}

function resetCapabilityBrokerForTests() {
  consumedNonces.clear();
}

module.exports = {
  authorizeInvocation,
  issueInvocationCredential,
  resetCapabilityBrokerForTests,
  _internals: { canonicalJson, sha256 },
};
