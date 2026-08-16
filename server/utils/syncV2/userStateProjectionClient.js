const crypto = require("crypto");
const { requestInternalService } = require("../microModules/internalClient");
const { distributedTopology } = require("../microModules/serviceHost");
const { parseEndpointMap } = require("../operations/moduleHealthMonitor");
const { reconcileUserStateProjection } = require("./userStateProjection");

const CAPABILITY = "sync.user-state.reconcile";
const PATH = "/internal/v1/sync/user-state/reconcile";

function endpointBase(endpoint) {
  if (typeof endpoint === "string") return endpoint.replace(/\/+$/, "");
  return String(endpoint?.url || "").replace(/\/+$/, "");
}

async function reconcileUserStateProjectionViaCapability(
  options = {},
  env = process.env
) {
  if (!distributedTopology(env)) return reconcileUserStateProjection(options);
  const baseUrl = endpointBase(parseEndpointMap(env)["sync-v2"]);
  // User-state persistence is owned by Identity. Sync V2 is an optional
  // projection layer, so a deployment without a remote Sync V2 endpoint must
  // not turn an otherwise successful preference write into a 503 response.
  if (!baseUrl) return reconcileUserStateProjection(options);
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(options))
    .digest("hex")
    .slice(0, 32);
  return requestInternalService({
    callerRole: "identity",
    callerModule: "authentication",
    url: `${baseUrl}${PATH}`,
    body: options,
    idempotencyKey: `identity-user-state:${Number(options.userId)}:${digest}`,
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
  reconcileUserStateProjectionViaCapability,
};
