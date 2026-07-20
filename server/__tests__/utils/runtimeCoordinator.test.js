const mockDisconnectDatabases = jest.fn(async () => ({
  disconnected: true,
}));
jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    runtimeLifecycle: { disconnectDatabases: mockDisconnectDatabases },
  },
}));

const { RuntimeCoordinator } = require("../../utils/runtimeCoordinator");

describe("RuntimeCoordinator", () => {
  it("starts only after HTTP attachment and stops in declared order", async () => {
    const calls = [];
    const server = {
      close: jest.fn((callback) => callback()),
      closeAllConnections: jest.fn(),
    };
    const coordinator = new RuntimeCoordinator();
    coordinator
      .register({
        name: "outbox",
        order: 10,
        start: async () => calls.push("start:outbox"),
        stop: async () => calls.push("stop:outbox"),
      })
      .register({
        name: "background",
        order: 30,
        start: async () => calls.push("start:background"),
        stop: async () => calls.push("stop:background"),
      })
      .attachServer(server);

    await coordinator.start();
    expect(coordinator.snapshot()).toMatchObject({
      status: "running",
      ready: true,
      components: ["outbox", "background"],
    });
    await coordinator.shutdown();
    expect(calls).toEqual([
      "start:outbox",
      "start:background",
      "stop:outbox",
      "stop:background",
    ]);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    expect(mockDisconnectDatabases).toHaveBeenCalledTimes(1);
  });

  it("rolls back already-started components when startup fails", async () => {
    const stop = jest.fn(async () => {});
    const coordinator = new RuntimeCoordinator();
    coordinator.register({ name: "first", order: 1, stop });
    coordinator.register({
      name: "broken",
      order: 2,
      start: async () => {
        throw new Error("boom");
      },
    });

    await expect(coordinator.start()).rejects.toThrow("boom");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({
      status: "failed",
      ready: false,
      lastError: "boom",
    });
  });

  it("coalesces concurrent startup calls so components start exactly once", async () => {
    let releaseStart;
    const start = jest.fn(
      () => new Promise((resolve) => (releaseStart = resolve))
    );
    const coordinator = new RuntimeCoordinator();
    coordinator.register({ name: "singleton", start });

    const first = coordinator.start();
    const second = coordinator.start();
    expect(start).toHaveBeenCalledTimes(1);

    releaseStart();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({
      status: "running",
      ready: true,
      components: ["singleton"],
    });
  });

  it("rejects duplicate or late component registration", async () => {
    const coordinator = new RuntimeCoordinator();
    coordinator.register({ name: "singleton" });
    expect(() => coordinator.register({ name: "singleton" })).toThrow(
      "Runtime component already registered"
    );

    await coordinator.start();
    expect(() => coordinator.register({ name: "late" })).toThrow(
      "must be registered before startup"
    );
  });

  it("does not become ready when shutdown interrupts component startup", async () => {
    let releaseStart;
    const stop = jest.fn(async () => {});
    const server = {
      close: jest.fn((callback) => callback()),
      closeAllConnections: jest.fn(),
    };
    const coordinator = new RuntimeCoordinator();
    coordinator
      .register({
        name: "slow-start",
        start: () => new Promise((resolve) => (releaseStart = resolve)),
        stop,
      })
      .attachServer(server);

    const startup = coordinator.start();
    const shutdown = coordinator.shutdown({ timeoutMs: 5_000 });
    releaseStart();

    await expect(startup).rejects.toMatchObject({
      code: "RUNTIME_STARTUP_ABORTED",
    });
    await expect(shutdown).resolves.toMatchObject({
      status: "stopped",
      ready: false,
      timedOut: false,
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("drains ingress and producers before stopping durable consumers", async () => {
    const calls = [];
    let releaseHttp;
    const server = {
      close: jest.fn((callback) => {
        calls.push("http:draining");
        releaseHttp = callback;
      }),
      closeAllConnections: jest.fn(),
    };
    const coordinator = new RuntimeCoordinator();
    coordinator
      .register({
        name: "producer",
        order: 1,
        stopOrder: 10,
        stop: async () => calls.push("stop:producer"),
      })
      .register({
        name: "outbox",
        order: 2,
        stopOrder: 80,
        stop: async () => calls.push("stop:outbox"),
      })
      .register({
        name: "broadcast",
        order: 3,
        stopOrder: 90,
        stop: async () => calls.push("stop:broadcast"),
      })
      .attachServer(server);
    await coordinator.start();

    const shutdown = coordinator.shutdown({ timeoutMs: 5_000 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["http:draining", "stop:producer"]);

    releaseHttp();
    await shutdown;
    expect(calls).toEqual([
      "http:draining",
      "stop:producer",
      "stop:outbox",
      "stop:broadcast",
    ]);
  });
});
