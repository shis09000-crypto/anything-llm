const crypto = require("crypto");
const { requestInternalService } = require("../../microModules/internalClient");

function bounded(value, max = 160) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function callerRole(env = process.env) {
  const role = bounded(env.ATHENA_RUNTIME_ROLE || "athena-api", 80);
  if (role === "api") return "athena-api";
  if (role === "worker") return "background-worker";
  return role;
}

function remoteKeyCustodyEnabled(env = process.env, context = {}) {
  const directFieldCutover =
    env.ATHENA_KEY_CUSTODY_DIRECT_FIELD_CUTOVER === "true" &&
    bounded(context.purpose || context.domain, 128) === "crypto-account-dek";
  return (
    (env.ATHENA_KEY_CUSTODY_CUTOVER === "true" || directFieldCutover) &&
    callerRole(env) !== "key-custody" &&
    Boolean(bounded(env.ATHENA_KEY_CUSTODY_URL, 512))
  );
}

function keyCustodyUrl(env = process.env) {
  return bounded(env.ATHENA_KEY_CUSTODY_URL, 512).replace(/\/+$/, "");
}

function safeContext(context = {}) {
  const purpose = bounded(context.purpose || context.domain, 128);
  if (!purpose) {
    const error = new Error("key_custody_purpose_required");
    error.code = "key_custody_purpose_required";
    throw error;
  }
  return {
    purpose,
    domain: bounded(context.domain || purpose, 128),
    resource: bounded(context.resource, 256) || null,
    operation: bounded(context.operation, 128) || null,
  };
}

function idempotencyKey(operation, value, context) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        version: "athena-key-custody-rpc:v1",
        operation,
        valueHash: crypto
          .createHash("sha256")
          .update(String(value))
          .digest("hex"),
        context,
      })
    )
    .digest("hex");
}

async function wrapMaterial(value, context = {}, env = process.env) {
  if (!remoteKeyCustodyEnabled(env, context)) {
    const { encryptSecret } = require("../encryption");
    return encryptSecret(value, context);
  }
  const normalizedContext = safeContext(context);
  const response = await requestInternalService({
    callerRole: callerRole(env),
    url: `${keyCustodyUrl(env)}/internal/v1/keys/wrap`,
    body: {
      plaintext: String(value),
      context: normalizedContext,
    },
    idempotencyKey: idempotencyKey("wrap", value, normalizedContext),
    env,
    timeoutMs: Number(env.ATHENA_KEY_CUSTODY_TIMEOUT_MS || 10_000),
  });
  if (!String(response?.wrapped || "").startsWith("enc:v2:")) {
    const error = new Error("key_custody_wrap_response_invalid");
    error.code = "key_custody_wrap_response_invalid";
    throw error;
  }
  return response.wrapped;
}

async function unwrapMaterial(value, context = {}, env = process.env) {
  if (!remoteKeyCustodyEnabled(env, context)) {
    const { decryptSecret } = require("../encryption");
    return decryptSecret(value, context);
  }
  const normalizedContext = safeContext(context);
  const response = await requestInternalService({
    callerRole: callerRole(env),
    url: `${keyCustodyUrl(env)}/internal/v1/keys/unwrap`,
    body: {
      wrapped: String(value),
      context: normalizedContext,
    },
    idempotencyKey: idempotencyKey("unwrap", value, normalizedContext),
    env,
    timeoutMs: Number(env.ATHENA_KEY_CUSTODY_TIMEOUT_MS || 10_000),
  });
  if (typeof response?.plaintext !== "string") {
    const error = new Error("key_custody_unwrap_response_invalid");
    error.code = "key_custody_unwrap_response_invalid";
    throw error;
  }
  return response.plaintext;
}

async function remoteCustodyStatus(env = process.env) {
  if (!remoteKeyCustodyEnabled(env)) {
    const error = new Error("remote_key_custody_not_enabled");
    error.code = "remote_key_custody_not_enabled";
    throw error;
  }
  const response = await requestInternalService({
    callerRole: callerRole(env),
    url: `${keyCustodyUrl(env)}/internal/v1/keys/status`,
    method: "GET",
    env,
    timeoutMs: Number(env.ATHENA_KEY_CUSTODY_TIMEOUT_MS || 10_000),
  });
  if (response?.ok !== true) {
    const error = new Error("remote_key_custody_unhealthy");
    error.code = "remote_key_custody_unhealthy";
    throw error;
  }
  return response;
}

module.exports = {
  callerRole,
  keyCustodyUrl,
  remoteCustodyStatus,
  remoteKeyCustodyEnabled,
  safeContext,
  unwrapMaterial,
  wrapMaterial,
};
