const crypto = require("crypto");
const { requestInternalService } = require("../../microModules/internalClient");

function bounded(value, max = 160) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function callerRole(env = process.env) {
  const role = bounded(env.ATHENA_RUNTIME_ROLE || "api", 80);
  // The client identity loader validates the certificate's actual SPIFFE SAN
  // (`.../api`). Key Custody maps that authenticated peer to the policy alias
  // `athena-api` after TLS verification; using the alias here would request a
  // certificate identity that does not and must not exist.
  if (role === "athena-api") return "api";
  if (role === "worker") return "background-worker";
  return role;
}

function callerModule(env = process.env) {
  const role = callerRole(env);
  if (role === "api") return "athena-api";
  if (role === "crypto-account") return "crypto-account-access";
  if (role === "identity") return "authentication";
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
    callerModule: callerModule(env),
    url: `${keyCustodyUrl(env)}/internal/v1/keys/wrap`,
    body: {
      plaintext: String(value),
      context: normalizedContext,
    },
    idempotencyKey: idempotencyKey("wrap", value, normalizedContext),
    targetModule: "key-custody",
    capability: "key-custody.wrap",
    contractVersion: "1.0",
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
    callerModule: callerModule(env),
    url: `${keyCustodyUrl(env)}/internal/v1/keys/unwrap`,
    body: {
      wrapped: String(value),
      context: normalizedContext,
    },
    idempotencyKey: idempotencyKey("unwrap", value, normalizedContext),
    targetModule: "key-custody",
    capability: "key-custody.unwrap",
    contractVersion: "1.0",
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
    callerModule: callerModule(env),
    targetModule: "key-custody",
    capability: "key-custody.audit-descriptor",
    contractVersion: "1.0",
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

function auditContext({
  chainId = "security-v1",
  throughSequence = null,
} = {}) {
  return {
    purpose: "security-audit-checkpoint",
    domain: "security-audit",
    resource:
      throughSequence === null
        ? chainId
        : `${bounded(chainId, 64)}:${Number(throughSequence)}`,
    operation: "checkpoint-signature",
  };
}

async function remoteAuditKeyDescriptor(
  keyId,
  { chainId = "security-v1", throughSequence = null } = {},
  env = process.env
) {
  const context = auditContext({ chainId, throughSequence });
  const response = await requestInternalService({
    callerRole: callerRole(env),
    callerModule: callerModule(env),
    targetModule: "key-custody",
    capability: "key-custody.audit-descriptor",
    contractVersion: "1.0",
    url: `${keyCustodyUrl(env)}/internal/v1/keys/audit-descriptor`,
    body: { keyId: bounded(keyId, 160) || null, context },
    env,
    timeoutMs: Number(env.ATHENA_KEY_CUSTODY_TIMEOUT_MS || 10_000),
  });
  const key = response?.key;
  if (
    !key?.keyId ||
    !key?.parameterSet ||
    !key?.keyOrigin ||
    !key?.hardwareProtection ||
    !key?.publicKey
  ) {
    const error = new Error("key_custody_audit_descriptor_invalid");
    error.code = "key_custody_audit_descriptor_invalid";
    throw error;
  }
  return key;
}

async function remoteSignAuditCheckpoint(
  { keyId = null, payload, chainId = "security-v1", throughSequence = null },
  env = process.env
) {
  if (
    !Buffer.isBuffer(payload) ||
    !payload.length ||
    payload.length > 8 * 1024
  ) {
    const error = new Error("key_custody_audit_payload_invalid");
    error.code = "key_custody_audit_payload_invalid";
    throw error;
  }
  const context = auditContext({ chainId, throughSequence });
  const payloadBase64 = payload.toString("base64");
  const response = await requestInternalService({
    callerRole: callerRole(env),
    callerModule: callerModule(env),
    targetModule: "key-custody",
    capability: "key-custody.audit-sign",
    contractVersion: "1.0",
    url: `${keyCustodyUrl(env)}/internal/v1/keys/audit-sign`,
    body: {
      keyId: bounded(keyId, 160) || null,
      payloadBase64,
      context,
    },
    idempotencyKey: idempotencyKey("audit-sign", payloadBase64, context),
    env,
    timeoutMs: Number(env.ATHENA_KEY_CUSTODY_TIMEOUT_MS || 10_000),
  });
  const signature = response?.signature;
  if (
    !signature?.suiteId ||
    !signature?.keyId ||
    !signature?.publicKey ||
    !signature?.signature ||
    signature?.postQuantum !== false
  ) {
    const error = new Error("key_custody_audit_signature_invalid");
    error.code = "key_custody_audit_signature_invalid";
    throw error;
  }
  const additionalSignatures = Array.isArray(response?.signatures)
    ? response.signatures.filter(
        (entry) =>
          entry?.suiteId &&
          entry?.keyId &&
          entry?.publicKey &&
          entry?.signature &&
          entry?.postQuantum === true
      )
    : [];
  if (additionalSignatures.length > 1) {
    const error = new Error("key_custody_audit_signature_bundle_invalid");
    error.code = "key_custody_audit_signature_bundle_invalid";
    throw error;
  }
  return { ...signature, additionalSignatures };
}

module.exports = {
  callerModule,
  callerRole,
  keyCustodyUrl,
  remoteAuditKeyDescriptor,
  remoteCustodyStatus,
  remoteKeyCustodyEnabled,
  remoteSignAuditCheckpoint,
  safeContext,
  unwrapMaterial,
  wrapMaterial,
};
