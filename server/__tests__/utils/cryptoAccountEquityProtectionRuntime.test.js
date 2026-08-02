const {
  AccountEquityProtectionRuntime,
} = require("../../utils/cryptoAccount/equityProtectionRuntime");

describe("account equity protection runtime", () => {
  test("restores active account recorders without a browser request", async () => {
    const protection = {
      start: jest.fn(async () => ({ running: true })),
      stop: jest.fn(async () => ({ running: false })),
      status: jest.fn(() => ({ running: true })),
    };
    const registry = {
      hubs: new Map(),
      get: jest.fn((resolved) => {
        const hub = {
          connectionId: resolved.connection.id,
          equityProtection: protection,
        };
        registry.hubs.set(resolved.connection.id, hub);
        return hub;
      }),
      invalidateConnection: jest.fn(),
      protectedCount: jest.fn(() => 1),
      size: jest.fn(() => 1),
      stopProtectedRecorders: jest.fn(async () => protection.stop()),
    };
    const connection = {
      id: "conn-a",
      userId: 1,
      authUserId: 10,
      provider: "gate",
      credentialVersion: 2,
      rootKeyId: "root-a",
      domainKeyVersion: 3,
    };
    const runtime = new AccountEquityProtectionRuntime({
      registry,
      listConnections: jest.fn(async () => [connection]),
      resolveConnection: jest.fn(async () => ({
        connection,
        credentials: { apiKey: "key", apiSecret: "secret" },
      })),
      reconcileIntervalMs: 60_000,
    });

    const status = await runtime.start();

    expect(registry.get).toHaveBeenCalledTimes(1);
    expect(protection.start).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      running: true,
      protected: true,
      priority: "P2",
      sampleIntervalMs: 1_500,
      activeRecorders: 1,
    });
    await runtime.stop();
    expect(registry.stopProtectedRecorders).toHaveBeenCalledTimes(1);
  });
});
