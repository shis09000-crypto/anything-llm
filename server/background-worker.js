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
const { shutdownStandaloneRuntime } = require("./utils/runtimeCoordinator");

const port = Number(process.env.BACKGROUND_WORKER_PORT || 3012);
const runtime = new BackgroundWorkerRuntime();
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[BackgroundWorker] ${signal} received; draining.`);
  const result = await shutdownStandaloneRuntime({
    name: "background-worker",
    stop: async () => {
      await runtime.stop();
      await shutdownOpenTelemetry();
    },
  });
  process.exit(result.timedOut ? 1 : 0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

runtime.startHealthServer({ port });
bootstrapSecurityContext({ runtimeRole: "background-worker" })
  .then(async (security) => {
    if (security.quarantined) {
      console.error(
        "[BackgroundWorker] key custody quarantined",
        security.reason
      );
      return runtime.fail(
        new Error(security.reason || "key_custody_quarantined")
      );
    }
    const { DataAccessCenter } = require("./utils/dataAccess");
    await DataAccessCenter.runtimeLifecycle.databaseReadiness();
    return runtime.start();
  })
  .then((snapshot) => console.log("[BackgroundWorker] started", snapshot))
  .catch((error) => {
    runtime.fail(error);
    console.error("[BackgroundWorker] failed to start", error);
    process.exitCode = 1;
  });
