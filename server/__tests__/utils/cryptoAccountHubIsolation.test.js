const {
  AccountCryptoHubRegistry,
} = require("../../utils/cryptoAccount/accountHub");

function binding(authUserId, connectionId, credentialVersion, apiKey) {
  return {
    connection: {
      id: connectionId,
      userId: authUserId,
      authUserId,
      credentialVersion,
    },
    credentials: {
      apiKey,
      apiSecret: `${apiKey}-secret`,
      env: "production",
    },
  };
}

function equityProtection(payload = null) {
  return {
    status: jest.fn(() => ({ running: true, protected: true })),
    start: jest.fn(async () => ({ running: true, protected: true })),
    stop: jest.fn(async () => ({ running: false, protected: true })),
    today: jest.fn(async () => payload),
  };
}

describe("account crypto hub isolation", () => {
  test("partitions clients and private caches by auth user and connection", () => {
    const registry = new AccountCryptoHubRegistry();
    const first = registry.get(binding(10, "connection-a", 1, "key-a"));
    const second = registry.get(binding(20, "connection-b", 1, "key-b"));
    first.cache.set("overview", { owner: "a" });
    second.cache.set("overview", { owner: "b" });
    expect(first).not.toBe(second);
    expect(first.credentials.apiKey).toBe("key-a");
    expect(second.credentials.apiKey).toBe("key-b");
    expect(first.cache.get("overview")).toEqual({ owner: "a" });
    expect(second.cache.get("overview")).toEqual({ owner: "b" });
    expect(registry.size()).toBe(2);
  });

  test("credential rotation destroys the old connection instance", () => {
    const registry = new AccountCryptoHubRegistry();
    const first = registry.get(binding(10, "connection-a", 1, "key-a"));
    first.cache.set("private", { value: "old" });
    const rotated = registry.get(
      binding(10, "connection-a", 2, "key-a-rotated")
    );
    expect(rotated).not.toBe(first);
    expect(rotated.credentials.apiKey).toBe("key-a-rotated");
    expect(rotated.cache.get("private")).toBeNull();
    expect(first.credentials.apiKey).toBe("");
  });

  test("returns an existing hub only for the same connection version", () => {
    const registry = new AccountCryptoHubRegistry();
    const hub = registry.get(binding(10, "connection-a", 1, "key-a"));

    expect(
      registry.getExisting({
        authUserId: 10,
        connectionId: "connection-a",
        credentialVersion: 1,
      })
    ).toBe(hub);
    expect(
      registry.getExisting({
        authUserId: 10,
        connectionId: "connection-a",
        credentialVersion: 2,
      })
    ).toBeNull();
  });

  test("initialization starts protected sampling without blocking on overview", async () => {
    const protection = equityProtection();
    const registry = new AccountCryptoHubRegistry({
      equityProtectionFactory: () => protection,
    });
    const hub = registry.get(binding(10, "connection-a", 1, "key-a"));
    hub.overview = jest.fn(async () => ({ success: true }));

    await expect(hub.init()).resolves.toMatchObject({ success: true });
    expect(protection.start).toHaveBeenCalledTimes(1);
    expect(hub.overview).not.toHaveBeenCalled();
  });

  test("serves account-scoped equity history with the page contract", async () => {
    const payload = {
      success: true,
      accountScoped: true,
      history: {
        incremental: false,
        latestEquityUsd: 57693.4,
        yesterdayBaselineUsd: 57693.4,
        accountScoped: true,
        pnlStatus: "initializing_protected_history",
        points: [
          {
            value: 57693.4,
            totalEquityUsd: 57693.4,
            source: "protected_sampler",
            equityMode: "api_total",
          },
        ],
      },
    };
    const protection = equityProtection(payload);
    const registry = new AccountCryptoHubRegistry({
      equityProtectionFactory: () => protection,
    });
    const hub = registry.get(binding(10, "connection-a", 1, "key-a"));

    const result = await hub.getEquityHistory();

    expect(result).toMatchObject({
      success: true,
      accountScoped: true,
      history: {
        incremental: false,
        latestEquityUsd: 57693.4,
        yesterdayBaselineUsd: 57693.4,
        accountScoped: true,
        pnlStatus: "initializing_protected_history",
      },
    });
    expect(result.history.points).toHaveLength(1);
    expect(result.history.points[0]).toMatchObject({
      value: 57693.4,
      totalEquityUsd: 57693.4,
      source: "protected_sampler",
      equityMode: "api_total",
    });
    expect(protection.today).toHaveBeenCalledWith({});
  });

  test("uses the account credential-bound service for pair detail", async () => {
    const registry = new AccountCryptoHubRegistry();
    const hub = registry.get(binding(10, "connection-a", 1, "key-a"));
    hub.tradingPairDetails.detail = jest.fn().mockResolvedValue({
      success: true,
      gateCurrencyPair: "BTC_USDT",
      holdingValueUsd: "15860.23",
    });

    await expect(
      hub.getTradingPairDetail({ pair: "BTC_USDT", market: "spot" })
    ).resolves.toMatchObject({
      success: true,
      holdingValueUsd: "15860.23",
    });
    expect(hub.tradingPairDetails.detail).toHaveBeenCalledWith({
      pair: "BTC_USDT",
      market: "spot",
    });
  });

  test("projects agent results without misleading legacy aliases", async () => {
    const registry = new AccountCryptoHubRegistry();
    const hub = registry.get(binding(10, "connection-a", 1, "key-a"));
    hub.overview = jest.fn().mockResolvedValue({
      success: true,
      allocation: {
        holdingScope: "spot_and_earn",
        combinedValueUsd: "12500.00",
        spotValueUsd: "150.00",
        earnValueUsd: "12350.00",
        items: [
          {
            symbol: "BTC",
            amount: "0.25000000",
            totalAmount: "0.25000000",
            spotAmount: "0.00300000",
            earnAmount: "0.24700000",
            valueUsd: "12500.00",
            spotValueUsd: "150.00",
            earnValueUsd: "12350.00",
            percentage: "100.00",
            holdingSources: ["spot", "earn"],
            priceUsd: "50000.00000000",
            change24hPct: "1.2",
          },
        ],
      },
      positions: {
        count: 1,
        summary: {
          marginMode: "cross",
          totalUnrealizedPnlUsd: "-10.00",
          totalNotionalUsd: "1000.00",
          accountInitialMarginUsd: "10.00",
          accountMaintenanceMarginUsd: "5.00",
          crossAvailableUsd: "1000.00",
          initialMarginToCrossAvailablePct: "1.00",
          weightedPnlPct: null,
          weightedPnlPctUnavailableReason: "cross_margin_shared_collateral",
          riskAssessment: "insufficient_fields_for_account_liquidation_safety",
          accountEquityUsd: "1000.00",
          marginRatioPct: "1.00",
        },
        items: [
          {
            symbol: "BTCUSDT",
            side: "long",
            marginMode: "cross",
            leverage: 100,
            configuredLeverage: 100,
            effectiveLeverage: null,
            leverageScope:
              "configured_position_leverage_not_effective_account_leverage",
            contractSize: "100",
            contractSizeUnit: "contracts",
            baseEquivalentAmount: "0.01",
            quantitySemantics: "mark_price_base_equivalent",
            notionalUsd: "1000.00",
            unrealizedPnlUsd: "-10.00",
            pnlPct: null,
          },
        ],
      },
      reportingGuidance: {},
    });

    const projected = await hub.toolOverview();

    expect(projected.allocation.items[0]).toMatchObject({
      totalAmount: "0.25000000",
      spotAmount: "0.00300000",
      earnAmount: "0.24700000",
    });
    expect(projected.allocation.items[0]).not.toHaveProperty("amount");
    expect(projected.positions.summary).not.toHaveProperty("accountEquityUsd");
    expect(projected.positions.summary).not.toHaveProperty("marginRatioPct");
    expect(projected.positions.items[0]).toMatchObject({
      configuredLeverage: 100,
      effectiveLeverage: null,
      pnlPct: null,
    });
    expect(projected.positions.items[0]).not.toHaveProperty("leverage");
  });
});
