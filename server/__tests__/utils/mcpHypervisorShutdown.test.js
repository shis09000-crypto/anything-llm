const EventEmitter = require("events");
const MCPHypervisor = require("../../utils/MCP/hypervisor");

function hypervisorWithChild(childProcess) {
  const hypervisor = Object.create(MCPHypervisor.prototype);
  hypervisor.mcps = {
    test: {
      close: jest.fn(async () => {}),
      transport: { _process: childProcess },
    },
  };
  hypervisor.mcpLoadingResults = { test: { status: "success" } };
  hypervisor.log = jest.fn();
  return hypervisor;
}

function childProcessThatExitsOn(signalToExit) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.kill = jest.fn((signal) => {
    if (signal === signalToExit) {
      child.exitCode = signal === "SIGTERM" ? 0 : 137;
      child.emit("exit", child.exitCode, signal);
    }
    return true;
  });
  return child;
}

describe("MCPHypervisor shutdown", () => {
  test("waits for a stdio child to exit after SIGTERM", async () => {
    const child = childProcessThatExitsOn("SIGTERM");
    const hypervisor = hypervisorWithChild(child);

    await hypervisor.shutdownMCPServers({ timeoutMs: 250 });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(hypervisor.mcps).toEqual({});
    expect(hypervisor.mcpLoadingResults).toEqual({});
  });

  test("force kills a stdio child that misses the drain deadline", async () => {
    const child = childProcessThatExitsOn("SIGKILL");
    const hypervisor = hypervisorWithChild(child);

    await hypervisor.shutdownMCPServers({ timeoutMs: 250 });

    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(hypervisor.log).toHaveBeenCalledWith(
      "Force killing MCP test after drain timeout",
      { pid: 1234 }
    );
  });
});
