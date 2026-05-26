const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  findAvailablePort,
  loadRuntimeConfig,
  logsDir,
  runtimeSummary,
  verifyStorageDir,
  writeRuntimeConfig,
} = require("./runtime.cjs");

let mainWindow;
let runtimeConfig;
let serverProcess;
let collectorProcess;
let startupError = null;
const repoRoot = app.isPackaged ? __dirname : path.resolve(__dirname, "..");
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_LOGS = 5;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function logFile(name) {
  const dir = logsDir(app);
  ensureDir(dir);
  const file = path.join(dir, name);
  rotateLogIfNeeded(file);
  return file;
}

function rotateLogIfNeeded(file) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < MAX_LOG_BYTES) return;
    for (let index = MAX_ROTATED_LOGS - 1; index >= 1; index -= 1) {
      const from = `${file}.${index}`;
      const to = `${file}.${index + 1}`;
      if (fs.existsSync(to)) fs.rmSync(to, { force: true });
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {}
}

function isPermissionError(error) {
  return ["EACCES", "EPERM"].includes(error?.code) || /EACCES|EPERM/i.test(error?.message || "");
}

function relaunchElevated() {
  if (process.platform !== "win32") return false;
  const { spawn } = require("child_process");
  const exe = process.execPath.replace(/'/g, "''");
  spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Start-Process -FilePath '${exe}' -Verb RunAs`,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  appendDesktopLog("Requested elevated relaunch for storage permissions");
  app.quit();
  return true;
}

function appendDesktopLog(message, meta = null) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    message,
    ...(meta ? { meta } : {}),
  });
  fs.appendFileSync(logFile("desktop.log"), `${line}\n`);
}

function nodeExecutable() {
  return process.env.DESKTOP_DEV_NODE_BIN || process.execPath;
}

function childEnv() {
  const logDirectory = logsDir(app);
  const runtimeConfigPath = path.join(
    app.getPath("appData"),
    "向量知识库",
    "desktop-runtime.json"
  );
  return {
    ...process.env,
    NODE_ENV: "production",
    ELECTRON_RUN_AS_NODE: "1",
    STORAGE_DIR: runtimeConfig.storageDir,
    SERVER_PORT: String(runtimeConfig.serverPort),
    COLLECTOR_PORT: String(runtimeConfig.collectorPort),
    COLLECTOR_ENDPOINT: `http://127.0.0.1:${runtimeConfig.collectorPort}`,
    DESKTOP_RUNTIME_CONFIG_PATH: runtimeConfigPath,
    DESKTOP_LOG_DIR: logDirectory,
    DESKTOP_ENV_PATH: path.join(runtimeConfig.storageDir, "desktop.env"),
  };
}

function spawnNodeScript(scriptPath, logName) {
  const out = fs.openSync(logFile(logName), "a");
  return spawn(nodeExecutable(), [scriptPath], {
    cwd: path.dirname(scriptPath),
    env: childEnv(),
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
}

function waitForHttp(url, timeoutMs = 20_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve(true);
      } catch {}
      if (Date.now() - startedAt > timeoutMs)
        return reject(new Error(`Timed out waiting for ${url}`));
      setTimeout(check, 500);
    };
    check();
  });
}

async function startServices() {
  const startedAt = Date.now();
  startupError = null;
  appendDesktopLog("Starting desktop services", runtimeSummary(runtimeConfig, logsDir(app)));

  collectorProcess = spawnNodeScript(
    path.join(repoRoot, "collector", "index.js"),
    "collector.log"
  );
  serverProcess = spawnNodeScript(path.join(repoRoot, "server", "index.js"), "server.log");

  collectorProcess.once("exit", (code) =>
    appendDesktopLog("Collector exited", { code })
  );
  serverProcess.once("exit", (code) => appendDesktopLog("Server exited", { code }));

  await waitForHttp(`http://127.0.0.1:${runtimeConfig.collectorPort}/accepts`);
  await waitForHttp(`http://127.0.0.1:${runtimeConfig.serverPort}/api/ping`);
  appendDesktopLog("Services started", { elapsedMs: Date.now() - startedAt });
}

function stopServices() {
  for (const child of [serverProcess, collectorProcess]) {
    if (child && !child.killed) child.kill();
  }
}

function recentLogTail(filename, maxBytes = 6000) {
  try {
    const file = logFile(filename);
    if (!fs.existsSync(file)) return "";
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch (error) {
    return error.message;
  }
}

function recoveryPayload() {
  return {
    runtime: runtimeConfig
      ? runtimeSummary(runtimeConfig, logsDir(app))
      : { logsDir: logsDir(app) },
    error: startupError?.message || "unknown_startup_error",
    logs: {
      desktop: recentLogTail("desktop.log"),
      server: recentLogTail("server.log"),
      collector: recentLogTail("collector.log"),
    },
  };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: "向量知识库",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  try {
    runtimeConfig = await loadRuntimeConfig(app);
    await startServices();
    await mainWindow.loadURL(`http://127.0.0.1:${runtimeConfig.serverPort}`);
  } catch (error) {
    if (isPermissionError(error) && relaunchElevated()) return;
    startupError = error;
    appendDesktopLog("Startup failed", {
      error: error.message,
      stack: error.stack,
      runtime: runtimeConfig,
    });
    await mainWindow.loadFile(path.join(__dirname, "recovery.html"));
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow.webContents.send("desktop-startup-error", recoveryPayload());
    });
  }
}

ipcMain.handle("desktop:get-startup-error", () => recoveryPayload());

ipcMain.handle("desktop:retry-start", async () => {
  stopServices();
  if (!runtimeConfig) runtimeConfig = await loadRuntimeConfig(app);
  runtimeConfig.serverPort = await findAvailablePort(runtimeConfig.serverPort);
  runtimeConfig.collectorPort = await findAvailablePort(runtimeConfig.collectorPort);
  runtimeConfig = writeRuntimeConfig(app, runtimeConfig);
  await startServices();
  await mainWindow.loadURL(`http://127.0.0.1:${runtimeConfig.serverPort}`);
  return { success: true };
});

ipcMain.handle("desktop:choose-storage-dir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "重新选择数据目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths?.[0]) return { success: false };
  const storageDir = result.filePaths[0];
  try {
    verifyStorageDir(storageDir);
  } catch (error) {
    if (isPermissionError(error) && relaunchElevated()) return { success: false };
    throw error;
  }
  if (!runtimeConfig) runtimeConfig = await loadRuntimeConfig(app);
  runtimeConfig.storageDir = storageDir;
  runtimeConfig = writeRuntimeConfig(app, runtimeConfig);
  stopServices();
  runtimeConfig.serverPort = await findAvailablePort(runtimeConfig.serverPort);
  runtimeConfig.collectorPort = await findAvailablePort(runtimeConfig.collectorPort);
  runtimeConfig = writeRuntimeConfig(app, runtimeConfig);
  await startServices();
  await mainWindow.loadURL(`http://127.0.0.1:${runtimeConfig.serverPort}`);
  return { success: true, runtime: runtimeSummary(runtimeConfig, logsDir(app)) };
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  stopServices();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", stopServices);
