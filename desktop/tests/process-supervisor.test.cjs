const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  DesktopProcessSupervisor,
} = require("../process-supervisor.cjs");

let nextPid = 900_000;

class FakeChild extends EventEmitter {
  constructor({ exitOnKill = true } = {}) {
    super();
    this.pid = nextPid++;
    this.exitCode = null;
    this.signals = [];
    this.exitOnKill = exitOnKill;
  }

  kill(signal) {
    this.signals.push(signal);
    if (this.exitOnKill) {
      setImmediate(() => {
        this.exitCode = 0;
        this.emit("exit", 0, signal);
      });
    }
    return true;
  }

  crash(code = 1) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

test("stop waits for children and does not schedule a restart", async () => {
  const children = [];
  const supervisor = new DesktopProcessSupervisor({
    spawnProcess: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    graceMs: 200,
  });
  await supervisor.start([{ name: "server" }, { name: "collector" }]);
  assert.equal(supervisor.snapshot().length, 2);

  await supervisor.stop();
  assert.equal(supervisor.snapshot().length, 0);
  assert.equal(children.length, 2);
  assert.equal(children.every((child) => child.signals.includes("SIGTERM")), true);
});

test("unexpected exits are bounded by the crash-loop policy", async () => {
  let fatal = null;
  let child;
  const supervisor = new DesktopProcessSupervisor({
    spawnProcess: () => {
      child = new FakeChild();
      return child;
    },
    restartLimit: 0,
    onFatal: (details) => {
      fatal = details;
    },
  });
  await supervisor.start([{ name: "server" }]);
  child.crash(9);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fatal, {
    name: "server",
    code: 9,
    signal: null,
    restarts: 1,
  });
  assert.equal(supervisor.snapshot().length, 0);
});
