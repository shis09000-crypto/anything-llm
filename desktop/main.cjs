const { app, BrowserWindow, dialog, ipcMain, session, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  DesktopProcessSupervisor,
} = require("./process-supervisor.cjs");
const {
  browserWindowOptions,
  isRecoveryRendererUrl,
  isSafeExternalUrl,
  isTrustedRendererUrl,
} = require("./security-policy.cjs");
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
let serviceSupervisor;
let startupError = null;
let quitting = false;
let shutdownComplete = false;
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
  return (
    ["EACCES", "EPERM"].includes(error?.code) ||
    /EACCES|EPERM/i.test(error?.message || "")
  );
}

function relaunchElevated() {
  if (process.platform !== "win32") return false;
  const exe = process.execPath.replace(/'/g, "''");
  spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Start-Process -FilePath '${exe}' -Verb RunAs`,
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }
  ).unref();
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

function spawnNodeScript({ scriptPath, logName }) {
  const outputFd = fs.openSync(logFile(logName), "a");
  const child = spawn(nodeExecutable(), [scriptPath], {
    cwd: path.dirname(scriptPath),
    env: childEnv(),
    stdio: ["ignore", outputFd, outputFd],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  child.once("exit", () => {
    try {
      fs.closeSync(outputFd);
    } catch {}
  });
  return child;
}

function serviceSpecs() {
  return [
    {
      name: "collector",
      scriptPath: path.join(repoRoot, "collector", "index.js"),
      logName: "collector.log",
    },
    {
      name: "server",
      scriptPath: path.join(repoRoot, "server", "index.js"),
      logName: "server.log",
    },
  ];
}

function ensureServiceSupervisor() {
  if (serviceSupervisor) return serviceSupervisor;
  serviceSupervisor = new DesktopProcessSupervisor({
    spawnProcess: spawnNodeScript,
    log: appendDesktopLog,
    onFatal: async ({ name, code, signal, restarts }) => {
      const error = new Error(`Desktop service ${name} repeatedly exited.`);
      error.code = "desktop_service_crash_loop";
      error.details = { name, code, signal, restarts };
      await showRecovery(error);
    },
  });
  return serviceSupervisor;
}

function waitForHttp(url, timeoutMs = 20_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
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
  appendDesktopLog(
    "Starting desktop services",
    runtimeSummary(runtimeConfig, logsDir(app))
  );
  await ensureServiceSupervisor().start(serviceSpecs());
  await Promise.all([
    waitForHttp(`http://127.0.0.1:${runtimeConfig.collectorPort}/accepts`),
    waitForHttp(`http://127.0.0.1:${runtimeConfig.serverPort}/api/ping`),
  ]);
  appendDesktopLog("Services started", {
    elapsedMs: Date.now() - startedAt,
    processes: serviceSupervisor.snapshot(),
  });
}

async function stopServices() {
  if (!serviceSupervisor) return;
  await serviceSupervisor.stop();
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

async function showRecovery(error) {
  startupError = error;
  appendDesktopLog("Desktop runtime entered recovery", {
    code: error?.code || "desktop_runtime_failed",
    message: error?.message,
    details: error?.details || null,
  });
  await stopServices();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadFile(path.join(__dirname, "recovery.html"));
  mainWindow.webContents.send("desktop-startup-error", recoveryPayload());
}

function configureRendererSecurity(window) {
  const webContents = window.webContents;
  webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url, runtimeConfig?.serverPort)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.on("render-process-gone", (_event, details) => {
    appendDesktopLog("Desktop renderer process exited", {
      reason: details?.reason,
      exitCode: details?.exitCode,
    });
  });
}

function assertTrustedIpc(event) {
  const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
  if (isRecoveryRendererUrl(senderUrl)) return;
  const error = new Error("desktop_ipc_forbidden");
  error.code = "desktop_ipc_forbidden";
  throw error;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: "向量知识库",
    webPreferences: browserWindowOptions(path.join(__dirname, "preload.cjs")),
  });
  configureRendererSecurity(mainWindow);

  try {
    runtimeConfig = await loadRuntimeConfig(app);
    await startServices();
    await mainWindow.loadURL(`http://127.0.0.1:${runtimeConfig.serverPort}`);
  } catch (error) {
    if (isPermissionError(error) && relaunchElevated()) return;
    await showRecovery(error);
  }
}

ipcMain.handle("desktop:get-startup-error", (event) => {
  assertTrustedIpc(event);
  return recoveryPayload();
});

ipcMain.handle("desktop:retry-start", async (event) => {
  assertTrustedIpc(event);
  await stopServices();
  if (!runtimeConfig) runtimeConfig = await loadRuntimeConfig(app);
  runtimeConfig.serverPort = await findAvailablePort(runtimeConfig.serverPort);
  runtimeConfig.collectorPort = await findAvailablePort(
    runtimeConfig.collectorPort
  );
  runtimeConfig = writeRuntimeConfig(app, runtimeConfig);
  try {
    await startServices();
    await mainWindow.loadURL(`http://127.0.0.1:${runtimeConfig.serverPort}`);
    return { success: true };
  } catch (error) {
    await showRecovery(error);
    throw error;
  }
});

ipcMain.handle("desktop:choose-storage-dir", async (event) => {
  assertTrustedIpc(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "重新选择数据目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths?.[0]) return { success: false };
  const storageDir = result.filePaths[0];
  try {
    verifyStorageDir(storageDir);
  } catch (error) {
    if (isPermissionError(error) && relaunchElevated())
      return { success: false };
    throw error;
  }
  if (!runtimeConfig) runtimeConfig = await loadRuntimeConfig(app);
  runtimeConfig.storageDir = storageDir;
  runtimeConfig = writeRuntimeConfig(app, runtimeConfig);
  await stopServices();
  runtimeConfig.serverPort = await findAvailablePort(runtimeConfig.serverPort);
  runtimeConfig.collectorPort = await findAvailablePort(
    runtimeConfig.collectorPort
  );
  runtimeConfig = writeRuntimeConfig(app, runtimeConfig);
  try {
    await startServices();
    await mainWindow.loadURL(`http://127.0.0.1:${runtimeConfig.serverPort}`);
    return {
      success: true,
      runtime: runtimeSummary(runtimeConfig, logsDir(app)),
    };
  } catch (error) {
    await showRecovery(error);
    throw error;
  }
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) =>
      callback(
        isTrustedRendererUrl(
          webContents?.getURL?.() || "",
          runtimeConfig?.serverPort
        ) &&
          ["media", "notifications", "clipboard-sanitized-write"].includes(
            permission
          )
      )
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) =>
      isTrustedRendererUrl(
        webContents?.getURL?.() || "",
        runtimeConfig?.serverPort
      ) &&
      ["media", "notifications", "clipboard-sanitized-write"].includes(
        permission
      )
  );
  await createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void stopServices().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
