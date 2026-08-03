const { requestInternalService } = require("../microModules/internalClient");
const { distributedTopology } = require("../microModules/serviceHost");

function bounded(value, max = 256) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function callerRole(env = process.env) {
  const role = bounded(env.ATHENA_RUNTIME_ROLE || "api", 80);
  if (role === "athena-api") return "api";
  if (role === "worker") return "background-worker";
  return role;
}

function callerModule(env = process.env) {
  const role = callerRole(env);
  if (role === "realtime-gateway") return "sync-v2";
  if (role === "api") return "athena-api";
  if (role === "identity") return "authentication";
  if (role === "crypto-account") return "crypto-account-access";
  if (role === "worker") return "background-worker";
  return role;
}

function identityUrl(env = process.env) {
  return bounded(env.ATHENA_IDENTITY_URL, 512).replace(/\/+$/, "");
}

function remoteIdentityOperationsEnabled(env = process.env) {
  return distributedTopology(env) && callerRole(env) !== "identity";
}

function requiredIdentityUrl(env = process.env) {
  const url = identityUrl(env);
  if (url) return url;
  const error = new Error("identity_capability_unavailable");
  error.code = "identity_capability_unavailable";
  error.httpStatus = 503;
  throw error;
}

function bearerToken(request) {
  const header =
    request?.header?.("Authorization") || request?.headers?.authorization;
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function safeClientMetadata(context = {}) {
  return {
    clientId: bounded(context.clientId, 256),
    platform: bounded(context.platform, 32),
    appVersion: bounded(context.appVersion, 128) || null,
    trustLevel: bounded(context.trustLevel, 32) || null,
    capabilitySource: bounded(context.capabilitySource, 32) || "unknown",
    capabilities:
      context.capabilities && typeof context.capabilities === "object"
        ? context.capabilities
        : null,
  };
}

async function attachClientContextViaIdentity({
  request,
  context,
  env = process.env,
} = {}) {
  const token = bearerToken(request);
  if (!token) {
    const error = new Error("identity_attach_session_required");
    error.code = "identity_attach_session_required";
    throw error;
  }
  return requestInternalService({
    callerRole: callerRole(env),
    callerModule: callerModule(env),
    url: `${requiredIdentityUrl(env)}/internal/v1/client-identity/attach`,
    body: { token, client: safeClientMetadata(context) },
    idempotencyKey: `identity-client-attach:${context.clientId}`,
    targetModule: "authentication",
    capability: "identity.client.attach",
    contractVersion: "1.0",
    env,
    timeoutMs: Number(env.ATHENA_IDENTITY_TIMEOUT_MS || 10_000),
  });
}

async function consumeRealtimeTicketViaIdentity(ticket, env = process.env) {
  const value = bounded(ticket, 512);
  if (!value) return null;
  const response = await requestInternalService({
    callerRole: callerRole(env),
    callerModule: callerModule(env),
    url: `${requiredIdentityUrl(env)}/internal/v1/realtime/tickets/consume`,
    body: { ticket: value },
    idempotencyKey: `identity-realtime-ticket:${value.slice(0, 48)}`,
    targetModule: "authentication",
    capability: "identity.realtime-ticket.consume",
    contractVersion: "1.0",
    env,
    timeoutMs: Number(env.ATHENA_IDENTITY_TIMEOUT_MS || 10_000),
  });
  return response?.entry || null;
}

const IDENTITY_CAPABILITIES = Object.freeze({
  "identity.assert": "/internal/v1/principal/assert",
  "identity.client.attach": "/internal/v1/client-identity/attach",
  "identity.request-signing.verify": "/internal/v1/request-signing/verify",
  "identity.session.validate": "/internal/v1/session/validate",
  "identity.session.touch": "/internal/v1/session/touch",
  "identity.audit.append": "/internal/v1/audit/append",
  "identity.user-domain-wrap.queue": "/internal/v1/user-domain-wraps/queue",
  "identity.user-state.read": "/internal/v1/user-state/read",
  "identity.user-state.upsert": "/internal/v1/user-state/upsert",
  "identity.user-state.delete": "/internal/v1/user-state/delete",
});
const CORE_IDENTITY_CAPABILITIES = Object.freeze([
  "identity.request-signing.verify",
  "identity.session.validate",
  "identity.session.touch",
  "identity.audit.append",
]);

async function callIdentityCapability({
  capability,
  body,
  idempotencyKey = null,
  env = process.env,
} = {}) {
  const path = IDENTITY_CAPABILITIES[capability];
  if (!path) {
    const error = new Error("identity_capability_unknown");
    error.code = "identity_capability_unknown";
    throw error;
  }
  try {
    const baseUrl = requiredIdentityUrl(env);
    return await requestInternalService({
      callerRole: callerRole(env),
      callerModule: callerModule(env),
      url: `${baseUrl}${path}`,
      body,
      idempotencyKey,
      targetModule: "authentication",
      capability,
      contractVersion: "1.0",
      env,
      timeoutMs: Number(env.ATHENA_IDENTITY_TIMEOUT_MS || 10_000),
    });
  } catch (cause) {
    if (Number(cause?.httpStatus) >= 400 && Number(cause?.httpStatus) < 500) {
      throw cause;
    }
    const error = new Error("identity_capability_unavailable");
    error.code = "identity_capability_unavailable";
    error.httpStatus = 503;
    error.capability = capability;
    error.cause = cause;
    throw error;
  }
}

function sessionProof({ request = null, claims = null } = {}) {
  const token = request ? bearerToken(request) : null;
  return token ? { token } : { claims };
}

async function assertPrincipalViaIdentity({
  request,
  client = null,
  authoritative = false,
  env = process.env,
} = {}) {
  const token = bearerToken(request);
  if (!token) {
    return {
      success: true,
      active: false,
      reasonCode: "session_missing",
    };
  }
  return callIdentityCapability({
    capability: "identity.assert",
    body: {
      token,
      client: safeClientMetadata(client || {}),
      authoritative: authoritative === true,
    },
    env,
  });
}

async function validateSessionViaIdentity(options = {}) {
  return callIdentityCapability({
    capability: "identity.session.validate",
    body: sessionProof(options),
    env: options.env,
  });
}

async function touchSessionViaIdentity(options = {}) {
  return callIdentityCapability({
    capability: "identity.session.touch",
    body: sessionProof(options),
    idempotencyKey: options.idempotencyKey,
    env: options.env,
  });
}

async function verifyRequestSigningViaIdentity({
  request = null,
  claims = null,
  descriptor,
  idempotencyKey = null,
  env = process.env,
} = {}) {
  return callIdentityCapability({
    capability: "identity.request-signing.verify",
    body: { ...sessionProof({ request, claims }), descriptor },
    idempotencyKey,
    env,
  });
}

async function appendIdentityAuditViaIdentity({
  request = null,
  claims = null,
  descriptor,
  result,
  metadata,
  idempotencyKey = null,
  env = process.env,
} = {}) {
  return callIdentityCapability({
    capability: "identity.audit.append",
    body: {
      ...sessionProof({ request, claims }),
      descriptor,
      result,
      metadata,
    },
    idempotencyKey,
    env,
  });
}

async function appendIdentityEventViaIdentity({
  event,
  metadata = null,
  userId = null,
  occurredAt = null,
  idempotencyKey = null,
  env = process.env,
} = {}) {
  return callIdentityCapability({
    capability: "identity.audit.append",
    body: { event, metadata, userId, occurredAt },
    idempotencyKey,
    env,
  });
}

async function queueUserDomainWrapViaIdentity(
  {
    userId,
    authUserId,
    resourceType,
    resourceId,
    domain,
    platformWrappedValue = null,
    platformWrapVersion = null,
    platformKeyId = null,
    domainKeyVersion = null,
    createdByClientId = null,
    migrationJobId = null,
  } = {},
  env = process.env
) {
  return callIdentityCapability({
    capability: "identity.user-domain-wrap.queue",
    body: {
      userId,
      authUserId,
      resourceType,
      resourceId,
      domain,
      platformWrappedValue,
      platformWrapVersion,
      platformKeyId,
      domainKeyVersion,
      createdByClientId,
      migrationJobId,
    },
    idempotencyKey: `identity-user-domain-wrap:${Number(userId)}:${bounded(resourceType, 80)}:${bounded(resourceId, 256)}:${bounded(domain, 80)}`,
    env,
  });
}

async function readUserStateViaIdentity({
  request,
  namespaces,
  scopes,
  env,
} = {}) {
  const result = await callIdentityCapability({
    capability: "identity.user-state.read",
    body: { ...sessionProof({ request }), namespaces, scopes },
    env,
  });
  return requireActiveIdentitySession(result);
}

async function upsertUserStateViaIdentity({
  request,
  states,
  syncContext,
  idempotencyKey,
  env,
} = {}) {
  const result = await callIdentityCapability({
    capability: "identity.user-state.upsert",
    body: { ...sessionProof({ request }), states, syncContext },
    idempotencyKey,
    env,
  });
  return requireActiveIdentitySession(result);
}

async function deleteUserStateViaIdentity({
  request,
  namespace,
  scope,
  syncContext,
  idempotencyKey,
  env,
} = {}) {
  const result = await callIdentityCapability({
    capability: "identity.user-state.delete",
    body: { ...sessionProof({ request }), namespace, scope, syncContext },
    idempotencyKey,
    env,
  });
  return requireActiveIdentitySession(result);
}

function requireActiveIdentitySession(result) {
  if (result?.active !== false) return result;
  const reasonCode = bounded(result.reasonCode, 128) || "session_revoked";
  const error = new Error(reasonCode);
  error.code = reasonCode;
  error.httpStatus = 401;
  error.terminalAuthFailure = true;
  throw error;
}

async function probeIdentityCapabilities(
  env = process.env,
  capabilitiesToProbe = CORE_IDENTITY_CAPABILITIES
) {
  const entries = await Promise.all(
    capabilitiesToProbe.map(async (capability) => {
      try {
        const result = await callIdentityCapability({
          capability,
          body: { probe: true },
          env,
        });
        return [capability, result?.available === true ? "ready" : "missing"];
      } catch {
        return [capability, "missing"];
      }
    })
  );
  const capabilities = Object.fromEntries(entries);
  return {
    ready: Object.values(capabilities).every((value) => value === "ready"),
    capabilities,
  };
}

module.exports = {
  CORE_IDENTITY_CAPABILITIES,
  IDENTITY_CAPABILITIES,
  appendIdentityAuditViaIdentity,
  appendIdentityEventViaIdentity,
  assertPrincipalViaIdentity,
  attachClientContextViaIdentity,
  bearerToken,
  callIdentityCapability,
  callerModule,
  callerRole,
  consumeRealtimeTicketViaIdentity,
  deleteUserStateViaIdentity,
  identityUrl,
  remoteIdentityOperationsEnabled,
  safeClientMetadata,
  probeIdentityCapabilities,
  queueUserDomainWrapViaIdentity,
  readUserStateViaIdentity,
  touchSessionViaIdentity,
  upsertUserStateViaIdentity,
  validateSessionViaIdentity,
  verifyRequestSigningViaIdentity,
};
