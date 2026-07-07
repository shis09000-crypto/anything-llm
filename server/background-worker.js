const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();

const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const { BackgroundWorkerRuntime } = require("./utils/backgroundWorker/runtime");

const port = Number(process.env.BACKGROUND_WORKER_PORT || 3012);
const runtime = new BackgroundWorkerRuntime();

runtime.startHealthServer({ port });
runtime
  .start()
  .then((snapshot) => console.log("[BackgroundWorker] started", snapshot))
  .catch((error) => {
    console.error("[BackgroundWorker] failed to start", error);
    process.exitCode = 1;
  });
