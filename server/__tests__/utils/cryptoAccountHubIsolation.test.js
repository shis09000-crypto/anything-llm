const {
  AccountCryptoHubRegistry,
} = require("../../utils/cryptoAccount/accountHub");

function binding(authUserId, connectionId, credentialVersion, apiKey) {
  return {
    connection: {
      id: connectionId,
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
