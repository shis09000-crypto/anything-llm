const {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} = require("../encryption");
const { health } = require(".");

const RPC_VERSION = "athena-key-custody-rpc:v1";
const MAX_MATERIAL_BYTES = 64 * 1024;
const CALLER_PURPOSES = Object.freeze({
  "crypto-account": new Set(["crypto-account-dek"]),
  "athena-api": new Set(["crypto-account-dek"]),
  "browser-worker": new Set(["browser-profile-dek"]),
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
  return match ? match[1] : "";
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

function material(value, label) {
  const bytes = Buffer.byteLength(String(value || ""), "utf8");
  if (bytes < 1 || bytes > MAX_MATERIAL_BYTES) {
    const error = new Error(`${label}_invalid`);
    error.code = `${label}_invalid`;
    error.httpStatus = 400;
    throw error;
  }
  return String(value);
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
    const value = material(wrapped, "key_custody_wrapped_value");
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
  authorizePurpose,
  callerRole,
  custodyStatus,
  normalizedContext,
  unwrapMaterial,
  wrapMaterial,
};
