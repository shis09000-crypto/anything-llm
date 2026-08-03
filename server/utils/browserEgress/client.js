const { requestInternalService } = require("../microModules/internalClient");

function distributed(env = process.env) {
  return ["distributed", "micro-modules"].includes(
    String(env.ATHENA_RUNTIME_TOPOLOGY || "")
      .trim()
      .toLowerCase()
  );
}

function endpoint(env = process.env) {
  return String(
    env.ATHENA_BROWSER_EGRESS_URL || "http://127.0.0.1:3033"
  ).replace(/\/+$/, "");
}

const CAPABILITIES = Object.freeze({
  status: "browser-egress.health",
  issue: "browser-egress.grant.issue",
  renew: "browser-egress.grant.renew",
  revoke: "browser-egress.grant.revoke",
  revokeDevice: "browser-egress.grant.revoke",
  resolve: "browser-egress.route.resolve",
  recordHealth: "browser-egress.route.resolve",
});

async function dispatchBrowserEgress(operation, input = {}, options = {}) {
  if (!CAPABILITIES[operation])
    throw Object.assign(new Error("browser_egress_operation_unknown"), {
      code: "browser_egress_operation_unknown",
      httpStatus: 400,
    });
  if (!distributed()) {
    const { browserEgressRuntime } = require("./runtime");
    return browserEgressRuntime[operation](input);
  }
  const response = await requestInternalService({
    callerRole: options.callerRole || "browser-plane",
    callerModule: options.callerModule || "browser-plane",
    url: `${endpoint()}/internal/v1/browser-egress/dispatch`,
    targetModule: "browser-egress",
    capability: CAPABILITIES[operation],
    contractVersion: "1.0",
    body: { operation, input },
    idempotencyKey: options.idempotencyKey || null,
    env: process.env,
    timeoutMs: Number(options.timeoutMs || 15_000),
  });
  return response.result;
}

module.exports = { CAPABILITIES, dispatchBrowserEgress, distributed, endpoint };
