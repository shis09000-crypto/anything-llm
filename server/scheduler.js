const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "scheduler";
const {
  shutdownOpenTelemetry,
  startOpenTelemetry,
} = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();
const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();
const { bootstrapSecurityContext } = require("./utils/security/keyLifecycle");
const { MicroModuleServiceHost } = require("./utils/microModules");
const { SchedulerRuntime } = require("./utils/scheduler");
const { disconnectRuntimeDatabases } = require("./utils/runtimeCoordinator");

const runtime = new SchedulerRuntime();
const port = Number(process.env.SCHEDULER_PORT || 3014);
const host = new MicroModuleServiceHost({
  manifestId: "scheduler",
  role: "scheduler",
  port,
  readiness: () => runtime.snapshot(),
  onStart: async () => {
    const security = await bootstrapSecurityContext({
      runtimeRole: "scheduler",
    });
    if (security.quarantined)
      throw new Error(security.reason || "key_custody_quarantined");
    const { DataAccessCenter } = require("./utils/dataAccess");
    await DataAccessCenter.runtimeLifecycle.databaseReadiness();
    await runtime.start();
  },
  onDrain: async () => runtime.stop(),
  onStop: async () => {
    await disconnectRuntimeDatabases();
    await shutdownOpenTelemetry();
  },
  registerRoutes: (app) => {
    app.post(
      "/internal/v1/scheduler/jobs/:jobId/sync",
      async (request, response) => {
        response.json({
          success: true,
          ...(await runtime.syncJob(request.params.jobId)),
        });
      }
    );
    app.delete(
      "/internal/v1/scheduler/jobs/:jobId",
      async (request, response) => {
        response.json({
          success: true,
          ...(await runtime.removeJob(request.params.jobId)),
        });
      }
    );
    app.post(
      "/internal/v1/scheduler/jobs/:jobId/trigger",
      async (request, response) => {
        const idempotencyKey = String(
          request.get("idempotency-key") || ""
        ).trim();
        if (!idempotencyKey)
          return response.status(400).json({
            success: false,
            error: "scheduler_idempotency_key_required",
          });
        response.json({
          success: true,
          ...(await runtime.triggerJob(request.params.jobId, {
            idempotencyKey,
          })),
        });
      }
    );
    app.post(
      "/internal/v1/scheduler/jobs/:jobId/runs/:runId/kill",
      async (request, response) => {
        response.json({
          success: true,
          ...(await runtime.killRun(
            request.params.jobId,
            request.params.runId
          )),
        });
      }
    );
  },
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[Scheduler] ${signal} received; draining.`);
  await host.stop();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

host
  .start()
  .then((snapshot) =>
    console.log(`[Scheduler] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[Scheduler] failed to start", error);
    process.exitCode = 1;
  });
