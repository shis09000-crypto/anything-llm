const {
  AccountEquityProtectionService,
  SAMPLE_INTERVAL_MS,
  TASK_DESCRIPTOR,
} = require("../../utils/cryptoAccount/equityProtection");

function totalBalance(amount, unrealized = 0) {
  return {
    success: true,
    data: {
      total: { amount: String(amount), unrealised_pnl: String(unrealized) },
      details: { spot: { amount: String(amount) } },
    },
  };
}

describe("protected account equity history", () => {
  test("samples every 1.5 seconds but skips identical K-line points and writes", async () => {
    let now = Date.now();
    const responses = [
      totalBalance(100),
      totalBalance(100),
      totalBalance(101),
      totalBalance(102),
    ];
    const persisted = [];
    const service = new AccountEquityProtectionService({
      connection: { id: "conn-a", userId: 1, authUserId: 10 },
      restClientFactory: () => ({
        getTotalBalanceRaw: jest.fn(async () => responses.shift()),
      }),
      store: {
        loadWindow: jest.fn(async () => []),
        persist: jest.fn(async (entry) => persisted.push(entry)),
      },
      now: () => now,
    });

    await service.sample();
    now += SAMPLE_INTERVAL_MS;
    await service.sample();
    now += SAMPLE_INTERVAL_MS;
    await service.sample();

    expect(service.points.map((point) => point.equityUsd)).toEqual([100, 101]);
    expect(persisted).toHaveLength(1);
    expect(service.status()).toMatchObject({
      sampleIntervalMs: 1_500,
      pointCount: 2,
      lastSampleAt: now,
      lastSuccessAt: now,
    });
    expect(TASK_DESCRIPTOR).toMatchObject({
      priority: "P2",
      protected: true,
      preemptible: false,
    });

    now += 60_000;
    await service.sample();
    expect(persisted).toHaveLength(2);
    expect(persisted[1].point.equityUsd).toBe(102);
  });

  test("keeps the last trusted series available while sampling is degraded", async () => {
    const now = Date.now();
    const stored = {
      ts: now - 5_000,
      equityUsd: 125,
      source: "protected_checkpoint",
      persisted: true,
      equityMode: "api_total",
      equityBreakdown: {
        apiTotalUsd: 125,
        unrealizedPnlUsd: 0,
        netEquityUsd: 125,
        accountSumUsd: 125,
        accountAmounts: { spot: 125 },
      },
    };
    const service = new AccountEquityProtectionService({
      connection: { id: "conn-a", userId: 1, authUserId: 10 },
      restClientFactory: () => ({
        getTotalBalanceRaw: jest.fn(async () => {
          throw new Error("temporary provider failure");
        }),
      }),
      store: {
        loadWindow: jest.fn(async () => [stored]),
        persist: jest.fn(),
      },
      now: () => now,
    });

    await expect(service.sample()).rejects.toThrow(
      "temporary provider failure"
    );
    service.running = true;
    const result = await service.today();

    expect(result).toMatchObject({
      success: true,
      history: {
        latestEquityUsd: 125,
        connectionStatus: "degraded",
        points: [{ value: 125, persisted: true }],
      },
    });
    expect(result.history.freshness.lastError).toContain(
      "temporary provider failure"
    );
  });
});
