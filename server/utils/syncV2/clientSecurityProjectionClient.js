const crypto = require("crypto");
const { requestInternalService } = require("../microModules/internalClient");
const { distributedTopology } = require("../microModules/serviceHost");
const { parseEndpointMap } = require("../operations/moduleHealthMonitor");
const {
  normalizeClientDevicesProjection,
  reconcileClientSecurityProjection,
} = require("./clientSecurityProjection");

const CAPABILITY = "sync.security.clients.reconcile";
const PATH = "/internal/v1/sync/security/clients/reconcile";

function endpointBase(endpoint) {
  if (typeof endpoint === "string") return endpoint.replace(/\/+$/, "");
  return String(endpoint?.url || "").replace(/\/+$/, "");
}

async function reconcileClientSecurityProjectionViaCapability(
  options = {},
  env = process.env
) {
  const content = normalizeClientDevicesProjection(options.content);
  if (!distributedTopology(env))
    return reconcileClientSecurityProjection({ ...options, content });

  const baseUrl = endpointBase(parseEndpointMap(env)["sync-v2"]);
  if (!baseUrl) {
    const error = new Error("sync_projection_capability_unavailable");
    error.code = "sync_projection_capability_unavailable";
    throw error;
  }
  const payload = { ...options, content };
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 32);
  return requestInternalService({
    callerRole: "identity",
    callerModule: "authentication",
    url: `${baseUrl}${PATH}`,
    body: payload,
    idempotencyKey: `identity-client-projection:${Number(options.userId)}:${digest}`,
    targetModule: "sync-v2",
    capability: CAPABILITY,
    contractVersion: "1.0",
    env,
    timeoutMs: Number(env.ATHENA_SYNC_PROJECTION_TIMEOUT_MS || 2_000),
  });
}

module.exports = {
  CAPABILITY,
  PATH,
  reconcileClientSecurityProjectionViaCapability,
};
