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

const { ReaderWorkerRuntime } = require("./utils/readerWorker/runtime");

const port = Number(process.env.READER_WORKER_PORT || 3011);
const runtime = new ReaderWorkerRuntime();

runtime.startHealthServer({ port });
runtime.startQueuePolling();
console.log("[ReaderWorker] started", runtime.snapshot());
