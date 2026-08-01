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

function identityUrl(env = process.env) {
  return bounded(env.ATHENA_IDENTITY_URL, 512).replace(/\/+$/, "");
}

function remoteIdentityOperationsEnabled(env = process.env) {
  return (
    distributedTopology(env) &&
    callerRole(env) !== "identity" &&
    Boolean(identityUrl(env))
  );
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
    url: `${identityUrl(env)}/internal/v1/client-identity/attach`,
    body: { token, client: safeClientMetadata(context) },
    env,
    timeoutMs: Number(env.ATHENA_IDENTITY_TIMEOUT_MS || 10_000),
  });
}

async function consumeRealtimeTicketViaIdentity(ticket, env = process.env) {
  const value = bounded(ticket, 512);
  if (!value) return null;
  const response = await requestInternalService({
    callerRole: callerRole(env),
    url: `${identityUrl(env)}/internal/v1/realtime/tickets/consume`,
    body: { ticket: value },
    env,
    timeoutMs: Number(env.ATHENA_IDENTITY_TIMEOUT_MS || 10_000),
  });
  return response?.entry || null;
}

module.exports = {
  attachClientContextViaIdentity,
  bearerToken,
  callerRole,
  consumeRealtimeTicketViaIdentity,
  identityUrl,
  remoteIdentityOperationsEnabled,
  safeClientMetadata,
};
