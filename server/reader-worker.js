const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "reader-worker";

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
const { ReaderWorkerRuntime } = require("./utils/readerWorker/runtime");
const { MicroModuleServiceHost } = require("./utils/microModules/serviceHost");
const { shutdownStandaloneRuntime } = require("./utils/runtimeCoordinator");

const runtime = new ReaderWorkerRuntime();
const host = new MicroModuleServiceHost({
  manifestId: "reader-worker",
  role: "reader-worker",
  port: Number(process.env.READER_WORKER_PORT || 3011),
  readiness: () => runtime.snapshot(),
  onStart: async () => {
    const security = await bootstrapSecurityContext({
      runtimeRole: "reader-worker",
    });
    if (security.quarantined) {
      const error = new Error(security.reason || "key_custody_quarantined");
      error.code = "KEY_CUSTODY_QUARANTINED";
      throw error;
    }
    const { DataAccessCenter } = require("./utils/dataAccess");
    await DataAccessCenter.runtimeLifecycle.databaseReadiness();
    runtime.startQueuePolling();
  },
  onDrain: async () => runtime.stopQueuePolling(),
  onCheckpoint: async () => ({
    workerId: runtime.workerId,
    processing: runtime.processing,
    lastProcessedAt: runtime.lastProcessedAt,
  }),
  onResume: async () => {
    const { DataAccessCenter } = require("./utils/dataAccess");
    await DataAccessCenter.runtimeLifecycle.databaseReadiness();
    runtime.startQueuePolling();
  },
  onStop: async () => runtime.stop(),
  registerRoutes: (app) => {
    app.post("/drain-once", async (_request, response) => {
      if (process.env.READER_WORKER_DEBUG_HTTP !== "true")
        return response.status(404).json({
          success: false,
          error: "not_found",
        });
      const results = await runtime.drainOnce({ maxJobs: 5 });
      return response.json({ success: true, results });
    });
  },
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[ReaderWorker] ${signal} received; draining.`);
  const result = await shutdownStandaloneRuntime({
    name: "reader-worker",
    stop: async () => {
      await host.stop();
      await shutdownOpenTelemetry();
    },
  });
  process.exit(result.timedOut ? 1 : 0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

host
  .start()
  .then((snapshot) => console.log("[ReaderWorker] started", snapshot))
  .catch((error) => {
    runtime.fail(error);
    console.error("[ReaderWorker] failed to start", error);
    process.exitCode = 1;
  });
