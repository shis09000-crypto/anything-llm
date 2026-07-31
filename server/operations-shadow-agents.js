const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "operations-shadow-agents";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
} = require("./utils/microModules");
const {
  OperationsShadowRuntime,
} = require("./utils/operations/shadowAgents/runtime");
const { remoteOperationsAccess } = require("./utils/operations/access");

const plane = {
  async timeline(filters = {}) {
    const response = await remoteOperationsAccess.timeline(filters);
    return response.events || [];
  },
};
const runtime = new OperationsShadowRuntime({ plane });

const host = new MicroModuleServiceHost({
  manifestId: "operations-shadow-agents",
  role: "operations-shadow-agents",
  port: Number(process.env.OPERATIONS_SHADOW_AGENTS_PORT || 3029),
  readiness: () => {
    const snapshot = runtime.snapshot();
    return {
      ...snapshot,
      ready: snapshot.status === "running",
    };
  },
  onStart: async () => {
    const snapshot = await runtime.start();
    if (!["running", "degraded"].includes(snapshot.status))
      throw new Error(
        snapshot.lastError || "operations_shadow_agents_not_ready"
      );
  },
  onDrain: () => runtime.stop(),
  registerRoutes: (app) => {
    app.get("/internal/v1/operations/shadow", (_request, response) => {
      response.json({ success: true, ...runtime.snapshot() });
    });
    app.get(
      "/internal/v1/operations/shadow/evaluations/latest",
      (_request, response) => {
        response.json({ success: true, report: runtime.evaluation() });
      }
    );
    app.get(
      "/internal/v1/operations/shadow/evaluations/corpus",
      (_request, response) => {
        response.json({ success: true, manifest: runtime.corpus() });
      }
    );
  },
});

installStandaloneShutdown(host, { name: "OperationsShadowAgents" });
host
  .start()
  .then((snapshot) =>
    console.log(`[OperationsShadowAgents] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[OperationsShadowAgents] failed to start", error);
    process.exitCode = 1;
  });
