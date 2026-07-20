const { spawn } = require("child_process");

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_RESTART_LIMIT = 3;
const DEFAULT_RESTART_WINDOW_MS = 60_000;

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function signalProcessTree(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null) return false;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return true;
    }
    return child.kill(signal);
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

async function forceKillProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" }
      );
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
    return;
  }
  signalProcessTree(child, "SIGKILL");
}

async function stopChild(child, graceMs = DEFAULT_GRACE_MS) {
  if (!child || child.exitCode !== null) return;
  signalProcessTree(child, "SIGTERM");
  if (await waitForExit(child, graceMs)) return;
  await forceKillProcessTree(child);
  await waitForExit(child, 1_000);
}

class DesktopProcessSupervisor {
  constructor({
    spawnProcess,
    log = () => {},
    onFatal = () => {},
    restartLimit = DEFAULT_RESTART_LIMIT,
    restartWindowMs = DEFAULT_RESTART_WINDOW_MS,
    graceMs = DEFAULT_GRACE_MS,
  } = {}) {
    if (typeof spawnProcess !== "function")
      throw new TypeError("desktop_spawn_process_required");
    this.spawnProcess = spawnProcess;
    this.log = log;
    this.onFatal = onFatal;
    this.restartLimit = Math.max(0, Number(restartLimit) || 0);
    this.restartWindowMs = Math.max(1_000, Number(restartWindowMs) || 0);
    this.graceMs = Math.max(100, Number(graceMs) || DEFAULT_GRACE_MS);
    this.records = new Map();
    this.stopping = false;
  }

  async start(specs = []) {
    await this.stop();
    this.stopping = false;
    for (const spec of specs) this.#spawn(spec, []);
    return this.snapshot();
  }

  #spawn(spec, restartHistory) {
    if (this.stopping) return null;
    const child = this.spawnProcess(spec);
    const record = {
      spec,
      child,
      expectedStop: false,
      restartHistory,
      restartTimer: null,
    };
    this.records.set(spec.name, record);
    child.once("error", (error) => {
      this.log("Desktop child process error", {
        name: spec.name,
        code: error?.code || "spawn_error",
      });
    });
    child.once("exit", (code, signal) =>
      this.#handleExit(record, code, signal)
    );
    this.log("Desktop child process started", {
      name: spec.name,
      pid: child.pid,
    });
    return child;
  }

  #handleExit(record, code, signal) {
    const current = this.records.get(record.spec.name);
    if (current !== record) return;
    this.records.delete(record.spec.name);
    this.log("Desktop child process exited", {
      name: record.spec.name,
      code,
      signal,
      expected: this.stopping || record.expectedStop,
    });
    if (this.stopping || record.expectedStop) return;

    const now = Date.now();
    const history = [...record.restartHistory, now].filter(
      (timestamp) => now - timestamp <= this.restartWindowMs
    );
    if (history.length > this.restartLimit) {
      void Promise.resolve(
        this.onFatal({ name: record.spec.name, code, signal, restarts: history.length })
      );
      return;
    }
    const delayMs = Math.min(500 * 2 ** Math.max(history.length - 1, 0), 5_000);
    record.restartTimer = setTimeout(() => {
      record.restartTimer = null;
      this.#spawn(record.spec, history);
    }, delayMs);
    this.records.set(record.spec.name, record);
    this.log("Desktop child process restart scheduled", {
      name: record.spec.name,
      delayMs,
      attempt: history.length,
    });
  }

  async stop() {
    this.stopping = true;
    const records = [...this.records.values()];
    for (const record of records) {
      record.expectedStop = true;
      if (record.restartTimer) clearTimeout(record.restartTimer);
    }
    await Promise.all(
      records.map((record) => stopChild(record.child, this.graceMs))
    );
    this.records.clear();
  }

  snapshot() {
    return [...this.records.values()].map((record) => ({
      name: record.spec.name,
      pid: record.child?.pid || null,
      running: record.child?.exitCode === null,
      restartCount: record.restartHistory.length,
    }));
  }
}

module.exports = {
  DEFAULT_GRACE_MS,
  DesktopProcessSupervisor,
  signalProcessTree,
  stopChild,
  waitForExit,
};
