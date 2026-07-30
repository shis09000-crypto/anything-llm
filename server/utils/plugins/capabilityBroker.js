const crypto = require("crypto");
const { resolveActiveKey } = require("../security/keyCustody");
const {
  signCapabilityEnvelope,
  verifyCapabilityEnvelope,
} = require("../security/pluginCapabilityHybrid");

const LEGACY_TOKEN_VERSION = "athena-plugin-capability:v1";
const HYBRID_TOKEN_VERSION = "athena-plugin-capability:v2";
const HYBRID_TOKEN_PREFIX = "pc2";
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

function durableNonceStore(env = process.env) {
  return (
    ["distributed", "micro-modules"].includes(
      String(env.ATHENA_RUNTIME_TOPOLOGY || "")
        .trim()
        .toLowerCase()
    ) && env.ATHENA_DATABASE_PROVIDER === "postgresql"
  );
}

async function consumeNonce(payload, { toolInvocationId = null } = {}) {
  if (!durableNonceStore()) {
    pruneConsumed();
    if (consumedNonces.has(payload.nonce)) throw new Error("replayed");
    consumedNonces.set(payload.nonce, Date.parse(payload.expiresAt));
    return;
  }
  const { DataAccessCenter } = require("../dataAccess");
  try {
    await DataAccessCenter.toolInvocation.consumeCapabilityNonce({
      nonce: payload.nonce,
      toolInvocationId,
      audience: payload.audience,
      toolName: payload.tool,
      argsHash: payload.argsHash,
      capabilityHash: payload.capabilityHash,
      expiresAt: payload.expiresAt,
    });
  } catch (error) {
    if (error?.code === "PLUGIN_CAPABILITY_NONCE_REPLAYED")
      throw new Error("replayed");
    throw error;
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
  requireHybrid = false,
  hybridSigners = null,
  env = process.env,
} = {}) {
  if (!serviceIdentity || !tool) {
    const error = new Error("plugin_capability_subject_and_tool_required");
    error.code = "PLUGIN_CAPABILITY_INVALID_REQUEST";
    throw error;
  }
  const boundedTtl = Math.max(1_000, Math.min(Number(ttlMs), MAX_TTL_MS));
  const key = requireHybrid ? null : signingKey(keyDescriptor);
  const payload = {
    version: requireHybrid ? HYBRID_TOKEN_VERSION : LEGACY_TOKEN_VERSION,
    ...(key ? { keyId: key.keyId } : {}),
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
  if (requireHybrid) {
    const envelope = signCapabilityEnvelope(Buffer.from(decoded(body)), {
      env,
      signers: hybridSigners,
      now: new Date(payload.issuedAt),
    });
    return `${HYBRID_TOKEN_PREFIX}.${body}.${encoded(canonicalJson(envelope))}`;
  }
  const signature = crypto
    .createHmac("sha256", key.material)
    .update(body)
    .digest("base64url");
  key.material.fill(0);
  return `${body}.${signature}`;
}

async function authorizeInvocation({
  credential,
  serviceIdentity,
  tool,
  args = {},
  manifest = {},
  now = Date.now(),
  keyDescriptor,
  consume = true,
  toolInvocationId = null,
  requireHybrid = false,
  hybridTrustedKeys = null,
  env = process.env,
} = {}) {
  try {
    const parts = String(credential || "").split(".");
    const isHybrid = parts[0] === HYBRID_TOKEN_PREFIX;
    let body;
    let payload;
    if (isHybrid) {
      if (parts.length !== 3 || !parts[1] || !parts[2])
        throw new Error("malformed");
      body = parts[1];
      payload = JSON.parse(decoded(body));
      if (payload.version !== HYBRID_TOKEN_VERSION)
        throw new Error("version_invalid");
      const envelope = JSON.parse(decoded(parts[2]));
      const verification = verifyCapabilityEnvelope(
        Buffer.from(decoded(body)),
        envelope,
        {
          env,
          trustedKeys: hybridTrustedKeys,
        }
      );
      if (!verification.valid) {
        throw new Error(
          `hybrid_invalid:${verification.findings.join(",")}`.slice(0, 240)
        );
      }
    } else {
      if (requireHybrid) throw new Error("hybrid_required");
      const [legacyBody, signature, extra] = parts;
      if (!legacyBody || !signature || extra) throw new Error("malformed");
      body = legacyBody;
      payload = JSON.parse(decoded(body));
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
      if (payload.version !== LEGACY_TOKEN_VERSION)
        throw new Error("version_invalid");
    }
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
    if (consume) await consumeNonce(payload, { toolInvocationId });
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
  _internals: {
    canonicalJson,
    durableNonceStore,
    sha256,
    HYBRID_TOKEN_PREFIX,
    HYBRID_TOKEN_VERSION,
    LEGACY_TOKEN_VERSION,
  },
};
