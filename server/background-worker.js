const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "background-worker";

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
const { BackgroundWorkerRuntime } = require("./utils/backgroundWorker/runtime");
const { MicroModuleServiceHost } = require("./utils/microModules/serviceHost");
const { shutdownStandaloneRuntime } = require("./utils/runtimeCoordinator");

const runtime = new BackgroundWorkerRuntime();
const host = new MicroModuleServiceHost({
  manifestId: "background-worker",
  role: "background-worker",
  port: Number(process.env.BACKGROUND_WORKER_PORT || 3012),
  readiness: () => runtime.snapshot(),
  onStart: async () => {
    const security = await bootstrapSecurityContext({
      runtimeRole: "background-worker",
    });
    if (security.quarantined)
      throw new Error(security.reason || "key_custody_quarantined");
    const { DataAccessCenter } = require("./utils/dataAccess");
    await DataAccessCenter.runtimeLifecycle.databaseReadiness();
    await runtime.start();
  },
  onDrain: async () => runtime.stop(),
  onCheckpoint: async () => ({
    status: runtime.status,
    jobs: runtime.service?.jobs?.().map((job) => job.name) || [],
  }),
  onResume: async () => runtime.start(),
  onStop: async () => runtime.stop(),
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[BackgroundWorker] ${signal} received; draining.`);
  const result = await shutdownStandaloneRuntime({
    name: "background-worker",
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
  .then((snapshot) => console.log("[BackgroundWorker] started", snapshot))
  .catch((error) => {
    runtime.fail(error);
    console.error("[BackgroundWorker] failed to start", error);
    process.exitCode = 1;
  });
