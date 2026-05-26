const fs = require("fs");
const net = require("net");
const path = require("path");

const SCHEMA_VERSION = "desktop-runtime-v1";
const APP_DIR_NAME = "向量知识库";
const DEFAULT_SERVER_PORT = 3001;
const DEFAULT_COLLECTOR_PORT = 8888;

function appDataRoot(app) {
  return path.join(app.getPath("appData"), APP_DIR_NAME);
}

function runtimePath(app) {
  return path.join(appDataRoot(app), "desktop-runtime.json");
}

function logsDir(app) {
  return path.join(appDataRoot(app), "logs");
}

function defaultStorageDir(app) {
  if (process.platform === "win32") {
    const drive = fs.existsSync("D:\\") ? "D:" : "C:";
    return path.join(`${drive}\\`, APP_DIR_NAME, "data");
  }
  return path.join(appDataRoot(app), "data");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeRuntimeConfig(app, config) {
  ensureDir(appDataRoot(app));
  const nextConfig = {
    schemaVersion: SCHEMA_VERSION,
    installDir: config.installDir,
    storageDir: config.storageDir,
    serverPort: Number(config.serverPort),
    collectorPort: Number(config.collectorPort),
    onboarding: config.onboarding || {},
  };
  fs.writeFileSync(runtimePath(app), JSON.stringify(nextConfig, null, 2));
  return nextConfig;
}

async function canListen(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(Number(port), "127.0.0.1");
  });
}

async function findAvailablePort(preferredPort) {
  const preferred = Number(preferredPort);
  if (await canListen(preferred)) return preferred;
  for (let port = preferred + 1; port < preferred + 200; port += 1) {
    if (await canListen(port)) return port;
  }
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.listen(0, "127.0.0.1");
  });
}

function verifyStorageDir(storageDir) {
  const requiredDirs = ["sqlite", "uploads", "cache", "models"];
  ensureDir(storageDir);
  for (const name of requiredDirs) ensureDir(path.join(storageDir, name));
  const probePath = path.join(storageDir, ".write-test");
  fs.writeFileSync(probePath, String(Date.now()));
  fs.unlinkSync(probePath);
}

async function loadRuntimeConfig(app) {
  ensureDir(appDataRoot(app));
  ensureDir(logsDir(app));
  const file = runtimePath(app);
  const existing = readJson(file, null);
  const installDir = app.isPackaged
    ? path.dirname(process.execPath)
    : path.resolve(__dirname, "..");

  if (existing && existing.schemaVersion !== SCHEMA_VERSION) {
    const backupPath = `${file}.${Date.now()}.bak`;
    fs.copyFileSync(file, backupPath);
  }

  const base = {
    schemaVersion: SCHEMA_VERSION,
    installDir: existing?.installDir || installDir,
    storageDir: existing?.storageDir || defaultStorageDir(app),
    serverPort: existing?.serverPort || DEFAULT_SERVER_PORT,
    collectorPort: existing?.collectorPort || DEFAULT_COLLECTOR_PORT,
    onboarding: existing?.onboarding || {},
  };

  base.serverPort = await findAvailablePort(base.serverPort);
  base.collectorPort = await findAvailablePort(base.collectorPort);
  verifyStorageDir(base.storageDir);
  return writeRuntimeConfig(app, base);
}

function runtimeSummary(config, logDirectory) {
  return {
    schemaVersion: config.schemaVersion,
    installDir: config.installDir,
    storageDir: config.storageDir,
    serverPort: config.serverPort,
    collectorPort: config.collectorPort,
    onboarding: config.onboarding,
    logsDir: logDirectory,
  };
}

module.exports = {
  APP_DIR_NAME,
  SCHEMA_VERSION,
  appDataRoot,
  defaultStorageDir,
  findAvailablePort,
  loadRuntimeConfig,
  logsDir,
  runtimePath,
  runtimeSummary,
  verifyStorageDir,
  writeRuntimeConfig,
};
