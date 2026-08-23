const {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} = require("../encryption");
const crypto = require("crypto");
const { health, resolveActiveKey, resolveKey } = require(".");

const RPC_VERSION = "athena-key-custody-rpc:v1";
const MAX_MATERIAL_BYTES = 64 * 1024;
// AES-GCM envelopes base64-encode the ciphertext, so a valid wrapped value is
// necessarily larger than the plaintext accepted by wrapMaterial. Keep a
// separate bounded limit for envelopes; sharing MAX_MATERIAL_BYTES made the
// largest successfully wrapped values impossible to unwrap.
const MAX_WRAPPED_MATERIAL_BYTES = 96 * 1024;
const CALLER_PURPOSES = Object.freeze({
  "crypto-account": new Set(["crypto-account-dek"]),
  "athena-api": new Set([
    "crypto-account-dek",
    "security-audit-checkpoint",
    "secret-store",
    "chat-conversation-key",
  ]),
  "chat-runtime": new Set(["secret-store", "chat-conversation-key"]),
  "agent-runtime": new Set(["chat-conversation-key", "agent-run-event"]),
  "responses-runtime": new Set(["responses-state"]),
  identity: new Set([
    "security-audit-checkpoint",
    "mcp-access-token",
    "user-state:chat-draft",
  ]),
  "browser-worker": new Set(["browser-profile-dek"]),
  "browser-egress": new Set(["browser-egress-credential"]),
});

function observe(operation, outcome) {
  try {
    const { metrics } = require("../../observability/metrics");
    metrics.keyCustodyOperations.inc({
      operation,
      outcome,
      runtime_role: "key-custody",
    });
  } catch {
    // Metrics must never expose or block key material operations.
  }
}

function bounded(value, max = 160) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function callerRole(caller = "") {
  if (caller === "local") return "local";
  const value = bounded(caller, 512);
  const match = value.match(/^spiffe:\/\/athena\/[^/]+\/([^/]+)$/);
  const role = match ? match[1] : "";
  return role === "api" ? "athena-api" : role;
}

function normalizedContext(context = {}) {
  const purpose = bounded(context.purpose || context.domain, 128);
  const domain = bounded(context.domain || purpose, 128);
  if (!purpose || !domain) {
    const error = new Error("key_custody_context_invalid");
    error.code = "key_custody_context_invalid";
    error.httpStatus = 400;
    throw error;
  }
  return {
    purpose,
    domain,
    resource: bounded(context.resource, 256) || null,
    operation: bounded(context.operation, 128) || null,
  };
}

function authorizePurpose(caller, context, env = process.env) {
  const role = callerRole(caller);
  if (role === "local" && env.NODE_ENV !== "production") return role;
  if (!CALLER_PURPOSES[role]?.has(context.purpose)) {
    const error = new Error("key_custody_purpose_denied");
    error.code = "key_custody_purpose_denied";
    error.httpStatus = 403;
    throw error;
  }
  return role;
}

function material(value, label, maxBytes = MAX_MATERIAL_BYTES) {
  const bytes = Buffer.byteLength(String(value || ""), "utf8");
  if (bytes < 1 || bytes > maxBytes) {
    const error = new Error(`${label}_invalid`);
    error.code = `${label}_invalid`;
    error.httpStatus = 400;
    throw error;
  }
  return String(value);
}

function auditPayload(value) {
  const encoded = material(value, "key_custody_audit_payload");
  let payload;
  try {
    payload = Buffer.from(encoded, "base64");
  } catch {
    payload = Buffer.alloc(0);
  }
  if (!payload.length || payload.length > 8 * 1024) {
    const error = new Error("key_custody_audit_payload_invalid");
    error.code = "key_custody_audit_payload_invalid";
    error.httpStatus = 400;
    throw error;
  }
  const text = payload.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const { ledgerCanonical } = require("../auditLedger")._internals;
  if (
    !parsed ||
    parsed.format !== "athena-audit-checkpoint-payload:v2" ||
    parsed.chainId !== "security-v1" ||
    !Number.isSafeInteger(Number(parsed.throughSequence)) ||
    Number(parsed.throughSequence) < 1 ||
    !/^[a-f0-9]{64}$/.test(String(parsed.throughHash || "")) ||
    ledgerCanonical(parsed) !== text
  ) {
    const error = new Error("key_custody_audit_payload_invalid");
    error.code = "key_custody_audit_payload_invalid";
    error.httpStatus = 400;
    throw error;
  }
  return payload;
}

const ED25519_PKCS8_SEED_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);

function mcpSigningKey(keyId = null) {
  const descriptor = keyId ? resolveKey(keyId) : resolveActiveKey();
  if (!descriptor?.material || !descriptor?.keyId) {
    const error = new Error("mcp_access_token_signing_key_unavailable");
    error.code = "mcp_access_token_signing_key_unavailable";
    error.httpStatus = 503;
    throw error;
  }
  const seed = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      descriptor.material,
      Buffer.from("athena-mcp-access-token-v1", "utf8"),
      Buffer.from(descriptor.keyId, "utf8"),
      32
    )
  );
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return {
    keyId: descriptor.keyId,
    privateKey,
    publicKey: crypto
      .createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

function mcpAccessTokenDescriptor(
  { keyId = null, context } = {},
  { caller, env } = {}
) {
  const normalized = normalizedContext(context);
  authorizePurpose(caller, normalized, env);
  const key = mcpSigningKey(keyId);
  observe("mcp_token_descriptor", "success");
  return {
    version: RPC_VERSION,
    key: {
      keyId: key.keyId,
      algorithm: "Ed25519",
      publicKey: key.publicKey,
    },
  };
}

function mcpSigningInput(value, expectedKeyId) {
  const signingInput = material(value, "mcp_access_token_signing_input", 8192);
  const parts = signingInput.split(".");
  if (parts.length !== 2) throw new Error("mcp_access_token_payload_invalid");
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("mcp_access_token_payload_invalid");
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    header?.alg !== "EdDSA" ||
    header?.typ !== "at+jwt" ||
    header?.kid !== expectedKeyId ||
    payload?.typ !== "athena-mcp-access" ||
    payload?.aud !== "athena-external-mcp" ||
    !String(payload?.iss || "").trim() ||
    !String(payload?.client_id || "").trim() ||
    !String(payload?.grant_id || "").trim() ||
    !Number.isSafeInteger(payload?.iat) ||
    !Number.isSafeInteger(payload?.exp) ||
    payload.iat > now + 30 ||
    payload.exp <= now ||
    payload.exp - payload.iat > 660
  ) {
    const error = new Error("mcp_access_token_payload_invalid");
    error.code = "mcp_access_token_payload_invalid";
    error.httpStatus = 400;
    throw error;
  }
  return signingInput;
}

function signMcpAccessToken(
  { keyId = null, signingInput, context } = {},
  { caller, env } = {}
) {
  try {
    const normalized = normalizedContext(context);
    authorizePurpose(caller, normalized, env);
    const key = mcpSigningKey(keyId);
    const input = mcpSigningInput(signingInput, key.keyId);
    const signature = crypto
      .sign(null, Buffer.from(input, "utf8"), key.privateKey)
      .toString("base64url");
    observe("mcp_token_sign", "success");
    return {
      version: RPC_VERSION,
      keyId: key.keyId,
      algorithm: "Ed25519",
      signature,
    };
  } catch (error) {
    observe("mcp_token_sign", error?.httpStatus === 403 ? "denied" : "failed");
    throw error;
  }
}

function auditKeyDescriptor(
  { keyId = null, context } = {},
  { caller, env } = {}
) {
  const normalized = normalizedContext(context);
  authorizePurpose(caller, normalized, env);
  const { signingKey } = require("../auditLedger")._internals;
  const key = signingKey(keyId || null);
  observe("audit_descriptor", "success");
  return {
    version: RPC_VERSION,
    key: {
      keyId: key.keyId,
      parameterSet: key.parameterSet,
      keyOrigin: key.keyOrigin,
      hardwareProtection: key.hardwareProtection,
      publicKey: key.publicKey,
    },
  };
}

function signAuditCheckpoint(
  { keyId = null, payloadBase64, context } = {},
  { caller, env } = {}
) {
  try {
    const normalized = normalizedContext(context);
    authorizePurpose(caller, normalized, env);
    const payload = auditPayload(payloadBase64);
    const {
      auditHybridMode,
      classicalCheckpointSignature,
      postQuantumCheckpointSignature,
      signingKey,
    } = require("../auditLedger")._internals;
    const signedAt = new Date();
    const signature = classicalCheckpointSignature({
      key: signingKey(keyId || null),
      payload,
      signedAt,
    });
    const signatures = [signature];
    if (auditHybridMode(env) !== "off")
      signatures.push(postQuantumCheckpointSignature({ payload, signedAt }));
    observe("audit_sign", "success");
    return { version: RPC_VERSION, signature, signatures };
  } catch (error) {
    observe("audit_sign", error?.httpStatus === 403 ? "denied" : "failed");
    throw error;
  }
}

function wrapMaterial({ plaintext, context } = {}, { caller, env } = {}) {
  try {
    const normalized = normalizedContext(context);
    authorizePurpose(caller, normalized, env);
    const value = material(plaintext, "key_custody_plaintext");
    const wrapped = encryptSecret(value, normalized);
    if (!wrapped.startsWith("enc:v2:")) {
      const error = new Error("key_custody_legacy_write_blocked");
      error.code = "key_custody_legacy_write_blocked";
      error.httpStatus = 503;
      throw error;
    }
    observe("wrap", "success");
    return { version: RPC_VERSION, wrapped };
  } catch (error) {
    observe("wrap", error?.httpStatus === 403 ? "denied" : "failed");
    throw error;
  }
}

function unwrapMaterial({ wrapped, context } = {}, { caller, env } = {}) {
  try {
    const normalized = normalizedContext(context);
    authorizePurpose(caller, normalized, env);
    const value = material(
      wrapped,
      "key_custody_wrapped_value",
      MAX_WRAPPED_MATERIAL_BYTES
    );
    if (!isEncryptedSecret(value)) {
      const error = new Error("key_custody_wrapped_value_invalid");
      error.code = "key_custody_wrapped_value_invalid";
      error.httpStatus = 400;
      throw error;
    }
    const plaintext = decryptSecret(value, normalized);
    observe("unwrap", "success");
    return {
      version: RPC_VERSION,
      plaintext,
    };
  } catch (error) {
    observe("unwrap", error?.httpStatus === 403 ? "denied" : "failed");
    throw error;
  }
}

function custodyStatus() {
  const state = health();
  return {
    version: RPC_VERSION,
    ok: state.ok === true,
    providerType: state.providerType || null,
    mutable: state.mutable === true,
    attested: state.attested === true,
    leaseExpiresAt: state.expiresAt || null,
    decryptOnlyKeyCount: Number(state.decryptOnlyKeyCount || 0),
  };
}

module.exports = {
  CALLER_PURPOSES,
  RPC_VERSION,
  auditKeyDescriptor,
  authorizePurpose,
  callerRole,
  custodyStatus,
  mcpAccessTokenDescriptor,
  normalizedContext,
  signAuditCheckpoint,
  signMcpAccessToken,
  unwrapMaterial,
  wrapMaterial,
};
