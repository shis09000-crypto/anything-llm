const fs = require("fs");
const { storagePath } = require("../environment");

const SCHEMA_VERSION = "desktop-runtime-v1";

function readJson(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function runtimeConfig() {
  const config = readJson(process.env.DESKTOP_RUNTIME_CONFIG_PATH, {});
  return {
    schemaVersion: config.schemaVersion || SCHEMA_VERSION,
    installDir: config.installDir || null,
    storageDir: config.storageDir || process.env.STORAGE_DIR || null,
    serverPort: Number(config.serverPort || process.env.SERVER_PORT || 3001),
    collectorPort: Number(
      config.collectorPort || process.env.COLLECTOR_PORT || 8888
    ),
    onboarding: config.onboarding || {},
  };
}

function logsDirectory() {
  if (process.env.DESKTOP_LOG_DIR) return process.env.DESKTOP_LOG_DIR;
  return storagePath("logs");
}

function runtimeSummary() {
  return {
    ...runtimeConfig(),
    logsDir: logsDirectory(),
    nodeEnv: process.env.NODE_ENV,
    appVersion: process.env.npm_package_version || null,
  };
}

module.exports = {
  SCHEMA_VERSION,
  logsDirectory,
  runtimeConfig,
  runtimeSummary,
};
