const {
  computePortfolioRisk,
  mergePortfolio,
  mergeSpotDetail,
  simulateRebalance,
} = require("../../utils/cryptoAccount/portfolioSnapshot");

describe("crypto consolidated portfolio", () => {
  const supplemental = [
    { symbol: "USDT", quantity: "15000", costBasisUsd: "15000" },
    { symbol: "BTC", quantity: "0.19069896", costBasisUsd: "13235.08" },
    { symbol: "ETH", quantity: "5.89370466", costBasisUsd: "13235.08" },
  ];

  test("merges Gate and supplemental holdings through one conserved total", () => {
    const result = mergePortfolio({
      gateTotalUsd: 68_529.84,
      gateAllocation: {
        totalValueUsd: "60000",
        items: [
          {
            symbol: "USDT",
            totalAmount: "10000",
            valueUsd: "10000",
            priceUsd: "1",
          },
          {
            symbol: "BTC",
            totalAmount: "0.5",
            valueUsd: "50000",
            priceUsd: "100000",
          },
        ],
      },
      supplementalHoldings: supplemental,
      priceBySymbol: { BTC: 100_000, ETH: 2_000 },
      asOf: 100,
    });

    expect(result.gate.totalValueUsd).toBe("68529.84");
    expect(result.supplemental.totalValueUsd).toBe("45857.31");
    expect(result.totalValueUsd).toBe("114387.15");
    expect(result.invariant.valid).toBe(true);
    expect(result.items.find((item) => item.symbol === "BTC")).toMatchObject({
      totalAmount: "0.690698960000",
      source: "mixed",
    });
    expect(result.items.find((item) => item.symbol === "OTHER").valueUsd).toBe(
      "8529.84"
    );
  });

  test("does not use cost basis as live market value when a price is missing", () => {
    const result = mergePortfolio({
      gateTotalUsd: 100,
      gateAllocation: { items: [] },
      supplementalHoldings: [
        { symbol: "BTC", quantity: "1", costBasisUsd: "5" },
      ],
      priceBySymbol: {},
    });
    expect(result.totalValueUsd).toBe("100.00");
    expect(result.supplemental.unpricedSymbols).toEqual(["BTC"]);
    expect(result.connectionStatus).toBe("degraded");
  });

  test("normalizes stale Gate allocation without creating a negative asset", () => {
    const result = mergePortfolio({
      gateTotalUsd: 90,
      gateAllocation: {
        items: [
          { symbol: "BTC", totalAmount: "1", valueUsd: "100", priceUsd: "100" },
        ],
      },
      supplementalHoldings: [],
    });
    expect(result.gate.normalizationApplied).toBe(true);
    expect(result.items.find((item) => item.symbol === "BTC").valueUsd).toBe(
      "90.00"
    );
    expect(result.items.some((item) => Number(item.valueUsd) < 0)).toBe(false);
    expect(result.invariant).toMatchObject({
      valid: true,
      itemTotalUsd: "90.00",
      expectedTotalUsd: "90.00",
    });
  });

  test("combines Gate and supplemental cost basis for spot detail", () => {
    const portfolio = mergePortfolio({
      gateTotalUsd: 100_000,
      gateAllocation: {
        items: [
          {
            symbol: "BTC",
            totalAmount: "0.5",
            valueUsd: "50000",
            priceUsd: "100000",
          },
        ],
      },
      supplementalHoldings: [supplemental[1]],
      priceBySymbol: { BTC: 100_000 },
    });
    const detail = mergeSpotDetail({
      detail: { averageBuyPriceQuote: "60000" },
      portfolio,
      symbol: "BTC",
    });
    expect(Number(detail.averageBuyPriceQuote)).toBeCloseTo(62_596.13, 2);
    expect(detail.holdingAmountBase).toBe("0.69069896");
  });

  test("uses deterministic risk thresholds and reference-only liquidation wording", () => {
    const portfolio = {
      asOf: 1_000,
      items: [
        { symbol: "BTC", valueUsd: "80000", percentage: "80" },
        { symbol: "USDT", valueUsd: "20000", percentage: "20" },
      ],
    };
    const risk = computePortfolioRisk({
      portfolio,
      positions: {
        summary: {
          totalNotionalUsd: "25000",
          initialMarginToCrossAvailablePct: "85",
          marginRatioSemantics: "reference_only",
        },
        positions: [{ liquidationDistancePct: "8" }],
      },
      equityHistory: {
        history: {
          points: [{ value: 100 }, { value: 88 }],
          freshness: { latestSnapshotAt: 1_000 },
        },
      },
      connectionStatus: "connected",
      now: 2_000,
    });
    expect(risk.level).toBe("danger");
    expect(risk.metrics.maxDrawdownPct).toBe(12);
    expect(risk.metrics.liquidationReferenceOnly).toBe(true);
    expect(risk.alerts.map((alert) => alert.rule)).toEqual(
      expect.arrayContaining([
        "asset_concentration",
        "margin_pressure",
        "liquidation_distance",
        "drawdown",
      ])
    );
  });

  test("rebalance simulation is explicitly non executable", () => {
    const result = simulateRebalance({
      portfolio: {
        totalValueUsd: "100000",
        items: [
          { symbol: "BTC", valueUsd: "60000" },
          { symbol: "USDT", valueUsd: "40000" },
        ],
      },
      targets: { BTC: 50, USDT: 50 },
    });
    expect(result.executable).toBe(false);
    expect(result.items.find((item) => item.symbol === "BTC").deltaUsd).toBe(
      -10000
    );
  });
});
