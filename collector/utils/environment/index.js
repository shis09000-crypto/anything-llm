const fs = require("fs");
const path = require("path");

const VALID_APP_ENVS = new Set(["production", "development"]);
const STORAGE_BASE_ENV = "ANYTHINGLLM_STORAGE_BASE_DIR";
const STORAGE_APPLIED_ENV = "ANYTHINGLLM_ENV_STORAGE_APPLIED";

function appEnvironment() {
  const fallback =
    process.env.NODE_ENV === "production" ? "production" : "development";
  const value = String(process.env.APP_ENV || fallback)
    .trim()
    .toLowerCase();
  if (!VALID_APP_ENVS.has(value)) {
    throw new Error(
      `Invalid APP_ENV "${process.env.APP_ENV}". Expected production or development.`
    );
  }
  return value;
}

function defaultStorageBase() {
  return path.resolve(__dirname, "../../../server/storage");
}

function storageBaseDir() {
  if (process.env[STORAGE_BASE_ENV])
    return path.resolve(process.env[STORAGE_BASE_ENV]);
  if (process.env[STORAGE_APPLIED_ENV] === "true" && process.env.STORAGE_DIR)
    return path.dirname(path.resolve(process.env.STORAGE_DIR));
  return process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR)
    : defaultStorageBase();
}

function storageRoot() {
  if (process.env[STORAGE_APPLIED_ENV] === "true" && process.env.STORAGE_DIR)
    return path.resolve(process.env.STORAGE_DIR);
  return path.join(storageBaseDir(), appEnvironment());
}

function applyEnvironmentStorage() {
  const base = storageBaseDir();
  process.env[STORAGE_BASE_ENV] = base;
  process.env.STORAGE_DIR = path.join(base, appEnvironment());
  process.env[STORAGE_APPLIED_ENV] = "true";
  fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });
  return process.env.STORAGE_DIR;
}

function storagePath(...segments) {
  return path.join(storageRoot(), ...segments);
}

module.exports = {
  appEnvironment,
  applyEnvironmentStorage,
  storagePath,
  storageRoot,
};
