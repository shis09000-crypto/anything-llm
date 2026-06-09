const {
  GateOpenFuturesPositionsService,
  normalizePosition,
  summarizePositions,
} = require("../../../utils/cryptoGate/openFuturesPositions");

function service() {
  return new GateOpenFuturesPositionsService({
    restClientFactory: jest.fn(),
    wsManager: {
      status: () => ({ futuresUsdt: { status: "connected" } }),
      addPrivateEventListener: jest.fn(() => jest.fn()),
      start: jest.fn(),
    },
  });
}

describe("Gate open futures positions", () => {
  test("normalizes Gate futures position payloads for the component", () => {
    const position = normalizePosition({
      contract: "BTC_USDT",
      size: "2",
      value: "1000",
      margin: "100",
      entry_price: "45000",
      mark_price: "50000",
      liq_price: "42000",
      unrealised_pnl: "40",
      pos_margin_mode: "isolated",
      lever: "10",
    });

    expect(position).toMatchObject({
      id: "BTC_USDT:long",
      symbol: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USD",
      side: "long",
      leverage: 10,
      marginMode: "isolated",
      positionValueUsd: "1000.00",
      unrealizedPnlUsd: "40.00",
      pnlPct: "40.00",
    });
    expect(position.quantity).toBe("0.02 BTC");
    expect(position.quantityAmount).toBe("0.02");
    expect(position.liquidationDistancePct).toBe("16.00");
    expect(position.liquidationRiskLevel).toBe("safe");
  });

  test("normalizes liquidation distance as an absolute two-decimal string", () => {
    const long = normalizePosition({
      contract: "BTC_USDT",
      size: "2",
      value: "200",
      margin: "20",
      mark_price: "100",
      liq_price: "90",
      pos_margin_mode: "isolated",
    });
    const short = normalizePosition({
      contract: "ETH_USDT",
      size: "-2",
      value: "200",
      margin: "20",
      mark_price: "100",
      liq_price: "110",
      pos_margin_mode: "isolated",
    });

    expect(long).toMatchObject({
      side: "long",
      liquidationDistancePct: "10.00",
      liquidationRiskLevel: "watch",
    });
    expect(short).toMatchObject({
      side: "short",
      liquidationDistancePct: "10.00",
      liquidationRiskLevel: "watch",
    });
  });

  test("falls back to legacy risk when liquidation distance cannot be calculated", () => {
    const missingLiquidation = normalizePosition({
      contract: "BTC_USDT",
      size: "2",
      value: "1000",
      margin: "100",
      mark_price: "50000",
      unrealised_pnl: "40",
      pos_margin_mode: "isolated",
      lever: "10",
    });
    const invalidMark = normalizePosition({
      contract: "ETH_USDT",
      size: "-4",
      value: "500",
      margin: "50",
      mark_price: "0",
      liq_price: "2500",
      unrealised_pnl: "-10",
      pos_margin_mode: "isolated",
      lever: "3",
    });

    expect(missingLiquidation).toMatchObject({
      riskLevel: "watch",
      liquidationDistancePct: null,
      liquidationRiskLevel: "danger",
    });
    expect(invalidMark).toMatchObject({
      riskLevel: "safe",
      liquidationDistancePct: null,
      liquidationRiskLevel: "safe",
    });
  });

  test("uses Gate position margin for leveraged return percent in cross mode", () => {
    const short = normalizePosition({
      contract: "BTC_USDT",
      size: "-6947",
      mode: "dual_short",
      pos_margin_mode: "cross",
      value: "42672.57273",
      margin: "0",
      initial_margin: "459.050201142975",
      maintenance_margin: "202.6947204675",
      entry_price: "71311.710199588619",
      mark_price: "61195.07",
      unrealised_pnl: "6867.672345654214",
      lever: "100",
    });
    const long = normalizePosition({
      contract: "BTC_USDT",
      size: "3702",
      mode: "dual_long",
      pos_margin_mode: "cross",
      value: "22739.86818",
      margin: "0",
      initial_margin: "244.453582935",
      maintenance_margin: "108.014373855",
      entry_price: "79960.685733656191",
      mark_price: "61195.07",
      unrealised_pnl: "-6861.577678599522",
      lever: "100",
    });

    expect(short).toMatchObject({
      marginUsd: "534.57",
      pnlPct: "1284.72",
    });
    expect(long).toMatchObject({
      marginUsd: "319.42",
      pnlPct: "-2148.16",
    });
  });

  test("keeps dual long and dual short positions for the same contract", () => {
    const openPositions = service();
    const payload = openPositions.applyRestSnapshot([
      {
        contract: "BTC_USDT",
        size: "3702",
        mode: "dual_long",
        value: "22654.41",
        margin: "0",
        initial_margin: "244.45",
        entry_price: "79960.69",
        mark_price: "61195.07",
        unrealised_pnl: "-6947.03",
        lever: "100",
      },
      {
        contract: "BTC_USDT",
        size: "-6947",
        mode: "dual_short",
        value: "42512.22",
        margin: "0",
        initial_margin: "459.05",
        entry_price: "71311.71",
        mark_price: "61195.07",
        unrealised_pnl: "7028.03",
        lever: "100",
      },
    ]);

    expect(payload.positions).toHaveLength(2);
    expect(payload.positions.map((item) => item.id).sort()).toEqual([
      "BTC_USDT:long",
      "BTC_USDT:short",
    ]);
    expect(
      payload.positions.find((item) => item.id === "BTC_USDT:long")
    ).toMatchObject({
      symbol: "BTCUSDT",
      side: "long",
      unrealizedPnlUsd: "-6947.03",
    });
    expect(
      payload.positions.find((item) => item.id === "BTC_USDT:short")
    ).toMatchObject({
      symbol: "BTCUSDT",
      side: "short",
      unrealizedPnlUsd: "7028.03",
    });
  });

  test("summarizes normalized positions", () => {
    const positions = [
      normalizePosition({
        contract: "BTC_USDT",
        size: "2",
        value: "1000",
        margin: "100",
        pos_margin_mode: "isolated",
        mark_price: "50000",
        unrealised_pnl: "40",
      }),
      normalizePosition({
        contract: "ETH_USDT",
        size: "-4",
        value: "500",
        margin: "50",
        pos_margin_mode: "isolated",
        mark_price: "2500",
        unrealised_pnl: "-10",
      }),
    ];

    expect(summarizePositions(positions, { cross_available: "2000" })).toEqual({
      totalUnrealizedPnlUsd: "30.00",
      weightedPnlPct: "20.00",
      totalMarginUsd: "150.00",
      accountEquityUsd: "2000.00",
      marginRatioPct: "7.50",
    });
  });

  test("uses futures cross available as account equity", () => {
    expect(
      summarizePositions([], {
        cross_available: "43963.12",
        available: "35121.70",
        cross_initial_margin: "536.66",
        cross_unrealised_pnl: "-1678.82",
      }).accountEquityUsd
    ).toBe("43963.12");
  });

  test("falls back to futures cross margin balance when cross available is absent", () => {
    expect(
      summarizePositions([], {
        cross_margin_balance: "44507.57",
        available: "35121.70",
      }).accountEquityUsd
    ).toBe("44507.57");
  });

  test("derives account equity from futures account fields as final fallback", () => {
    expect(
      summarizePositions([], {
        total: "0.000000002471",
        available: "35032.21626",
        cross_initial_margin: "533.920881450475",
        unrealised_pnl: "-1606.380142945309",
      }).accountEquityUsd
    ).toBe("33959.76");
  });

  test("merges partial WS updates without clearing other positions", () => {
    const openPositions = service();
    openPositions.applyRestSnapshot([
      {
        contract: "BTC_USDT",
        size: "2",
        value: "1000",
        margin: "100",
        pos_margin_mode: "isolated",
        mark_price: "50000",
        unrealised_pnl: "40",
      },
      {
        contract: "ETH_USDT",
        size: "-4",
        value: "500",
        margin: "50",
        pos_margin_mode: "isolated",
        mark_price: "2500",
        unrealised_pnl: "-10",
      },
    ]);

    const payload = openPositions.applyWsPositionUpdate({
      result: {
        contract: "BTC_USDT",
        size: "3",
        value: "1800",
        margin: "180",
        pos_margin_mode: "isolated",
        mark_price: "60000",
        unrealised_pnl: "90",
      },
    });

    expect(payload.positions).toHaveLength(2);
    expect(
      payload.positions.find((item) => item.id === "BTC_USDT:long")
    ).toMatchObject({
      quantity: "0.03 BTC",
      quantityAmount: "0.03",
      positionValueUsd: "1800.00",
      unrealizedPnlUsd: "90.00",
    });
    expect(
      payload.positions.find((item) => item.id === "ETH_USDT:short")
    ).toBeTruthy();
  });

  test("preserves existing position fields when WS update is partial", () => {
    const openPositions = service();
    openPositions.applyRestSnapshot([
      {
        contract: "BTC_USDT",
        size: "-2",
        mode: "dual_short",
        value: "1000",
        margin: "100",
        pos_margin_mode: "isolated",
        entry_price: "55000",
        mark_price: "50000",
        unrealised_pnl: "40",
      },
    ]);

    const payload = openPositions.applyWsPositionUpdate({
      result: {
        contract: "BTC_USDT",
        mode: "dual_short",
        mark_price: "49000",
        unrealised_pnl: "60",
      },
    });

    expect(payload.positions).toHaveLength(1);
    expect(payload.positions[0]).toMatchObject({
      id: "BTC_USDT:short",
      entryPrice: "55000.00000000",
      markPrice: "49000.00000000",
      marginUsd: "100.00",
      unrealizedPnlUsd: "60.00",
      pnlPct: "60.00",
    });
  });

  test("removes positions when WS update has size zero or holding false", () => {
    const openPositions = service();
    openPositions.applyRestSnapshot([
      {
        contract: "BTC_USDT",
        size: "2",
        value: "1000",
        margin: "100",
        pos_margin_mode: "isolated",
        mark_price: "50000",
        unrealised_pnl: "40",
      },
      {
        contract: "ETH_USDT",
        size: "-4",
        value: "500",
        margin: "50",
        pos_margin_mode: "isolated",
        mark_price: "2500",
        unrealised_pnl: "-10",
      },
    ]);

    openPositions.applyWsPositionUpdate({
      result: { contract: "BTC_USDT", size: "0", mode: "dual_long" },
    });
    const payload = openPositions.applyWsPositionUpdate({
      result: { contract: "ETH_USDT", size: "-4", holding: false },
    });

    expect(payload.positions).toHaveLength(0);
    expect(payload.summary.totalUnrealizedPnlUsd).toBe("0.00");
  });

  test("throttles stream broadcasts and keeps REST fallback from clearing positions", async () => {
    jest.useFakeTimers();
    const restClient = {
      getFuturesUsdtAccountRaw: jest
        .fn()
        .mockResolvedValue({ success: true, data: { available: "1000" } }),
      getFuturesUsdtPositionsRaw: jest.fn().mockResolvedValue({
        success: true,
        data: [
          {
            contract: "BTC_USDT",
            size: "2",
            value: "1000",
            margin: "100",
            pos_margin_mode: "isolated",
            mark_price: "50000",
            unrealised_pnl: "40",
          },
          {
            contract: "ETH_USDT",
            size: "-4",
            value: "500",
            margin: "50",
            pos_margin_mode: "isolated",
            mark_price: "2500",
            unrealised_pnl: "-10",
          },
        ],
      }),
    };
    const openPositions = new GateOpenFuturesPositionsService({
      restClientFactory: () => restClient,
      wsManager: {
        status: () => ({ futuresUsdt: { status: "disconnected" } }),
        addPrivateEventListener: jest.fn(() => jest.fn()),
        start: jest.fn(),
      },
    });
    openPositions.broadcast = jest.fn();
    openPositions.subscribers.set("test", {});

    await openPositions.runFallbackRefresh();
    expect(openPositions.positionsMap.size).toBe(2);
    expect(openPositions.broadcast).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);
    expect(openPositions.broadcast).toHaveBeenCalledTimes(1);
    expect(openPositions.broadcast.mock.calls[0][1].positions).toHaveLength(2);

    jest.useRealTimers();
  });
});
