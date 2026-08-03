const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "browser-egress";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { browserEgressRuntime } = require("./utils/browserEgress/runtime");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  secureDatabaseStart,
} = require("./utils/microModules");

const host = new MicroModuleServiceHost({
  manifestId: "browser-egress",
  role: "browser-egress",
  port: Number(process.env.BROWSER_EGRESS_PORT || 3033),
  jsonLimit: "256kb",
  readiness: () => browserEgressRuntime.status(),
  onStart: async () => {
    await secureDatabaseStart("browser-egress");
    if (process.env.ATHENA_BROWSER_EGRESS_ENABLED === "true")
      await browserEgressRuntime.renderGatewayConfig();
  },
  onDrain: async () => browserEgressRuntime.drain(),
  registerRoutes: (app) => {
    app.post(
      "/internal/v1/browser-egress/dispatch",
      async (request, response) => {
        const operation = String(request.body?.operation || "");
        const input = request.body?.input || {};
        const handlers = {
          status: () => browserEgressRuntime.status(),
          issue: (payload) => browserEgressRuntime.issue(payload),
          renew: (payload) => browserEgressRuntime.renew(payload),
          revoke: (payload) => browserEgressRuntime.revoke(payload),
          revokeDevice: (payload) => browserEgressRuntime.revokeDevice(payload),
          resolve: (payload) => browserEgressRuntime.resolve(payload),
          recordHealth: (payload) => browserEgressRuntime.recordHealth(payload),
        };
        const handler = handlers[operation];
        if (!handler)
          return response.status(400).json({
            success: false,
            error: "browser_egress_operation_unknown",
          });
        response.json({ success: true, result: await handler(input) });
      }
    );
  },
});

installStandaloneShutdown(host, { name: "BrowserEgress" });
host
  .start()
  .then((snapshot) =>
    console.log(`[BrowserEgress] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[BrowserEgress] failed to start", error);
    process.exitCode = 1;
  });
