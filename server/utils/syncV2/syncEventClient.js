const { requestInternalService } = require("../microModules/internalClient");
const { distributedTopology } = require("../microModules/serviceHost");
const { parseEndpointMap } = require("../operations/moduleHealthMonitor");

const CAPABILITY = "sync.events.append";
const PATH = "/internal/v1/sync/events/append";

const MODULE_BY_ROLE = Object.freeze({
  api: "athena-api",
  "athena-api": "athena-api",
  identity: "authentication",
  authentication: "authentication",
  "reader-worker": "reader-worker",
  "realtime-gateway": "sync-v2",
});

function endpointBase(endpoint) {
  if (typeof endpoint === "string") return endpoint.replace(/\/+$/, "");
  return String(endpoint?.url || "").replace(/\/+$/, "");
}

function realtimeGatewayUrl(env = process.env) {
  return endpointBase(
    parseEndpointMap(env)["sync-v2"] || env.ATHENA_REALTIME_UPSTREAM
  );
}

function runtimeRole(env = process.env) {
  return String(env.ATHENA_RUNTIME_ROLE || "api").trim() || "api";
}

function moduleIdForRole(role) {
  return MODULE_BY_ROLE[role] || role;
}

function remoteSyncEventAppendEnabled(env = process.env) {
  return distributedTopology(env) && runtimeRole(env) !== "realtime-gateway";
}

function priorityForEvent(event = {}) {
  if (event.eventPriority === "critical") return "P0";
  if (event.eventPriority === "background") return "P4";
  return "P2";
}

function coordinationContextForEvent(event = {}, now = Date.now()) {
  const eventId = String(event.eventId || "");
  return {
    coordinationRunId: eventId,
    stepId: "sync-event-append",
    correlationId: eventId,
    center: "data",
    priority: priorityForEvent(event),
    deadlineAt: new Date(now + 5_000).toISOString(),
    causationId:
      event.origin?.requestId || event.origin?.actionId || eventId || null,
  };
}

async function appendSyncEventViaCapability(event = {}, env = process.env) {
  if (!remoteSyncEventAppendEnabled(env)) {
    const { DataAccessCenter } = require("../dataAccess");
    return DataAccessCenter.syncEvent.persist(event);
  }

  const baseUrl = realtimeGatewayUrl(env);
  if (!baseUrl) {
    const error = new Error("sync_event_capability_unavailable");
    error.code = "sync_event_capability_unavailable";
    error.httpStatus = 503;
    throw error;
  }

  const role = runtimeRole(env);
  const result = await requestInternalService({
    callerRole: role,
    callerModule: moduleIdForRole(role),
    targetModule: "sync-v2",
    capability: CAPABILITY,
    contractVersion: "1.0",
    url: `${baseUrl}${PATH}`,
    method: "POST",
    body: { event },
    idempotencyKey: event.eventId,
    coordinationContext: coordinationContextForEvent(event),
    env,
    timeoutMs: Number(env.ATHENA_SYNC_EVENT_APPEND_TIMEOUT_MS || 5_000),
  });
  return result.event || event;
}

module.exports = {
  CAPABILITY,
  PATH,
  appendSyncEventViaCapability,
  coordinationContextForEvent,
  moduleIdForRole,
  remoteSyncEventAppendEnabled,
  realtimeGatewayUrl,
};
