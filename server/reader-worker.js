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
const { shutdownStandaloneRuntime } = require("./utils/runtimeCoordinator");

const port = Number(process.env.READER_WORKER_PORT || 3011);
const runtime = new ReaderWorkerRuntime();
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[ReaderWorker] ${signal} received; draining.`);
  const result = await shutdownStandaloneRuntime({
    name: "reader-worker",
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
bootstrapSecurityContext({ runtimeRole: "reader-worker" })
  .then(async (security) => {
    if (security.quarantined) {
      console.error("[ReaderWorker] key custody quarantined", security.reason);
      runtime.fail(
        Object.assign(new Error(security.reason || "key_custody_quarantined"), {
          code: "KEY_CUSTODY_QUARANTINED",
        })
      );
      return;
    }
    const { DataAccessCenter } = require("./utils/dataAccess");
    await DataAccessCenter.runtimeLifecycle.databaseReadiness();
    runtime.startQueuePolling();
    console.log("[ReaderWorker] started", runtime.snapshot());
  })
  .catch((error) => {
    runtime.fail(error);
    console.error("[ReaderWorker] security bootstrap failed", error);
    process.exitCode = 1;
  });
