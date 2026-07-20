const {
  GateTradeRecordsService,
} = require("../../../utils/cryptoGate/tradeRecords");
const {
  GateTradeRecordsFeeSummaryService,
} = require("../../../utils/cryptoGate/feeSummary");

const nowSec = Math.floor(Date.now() / 1000);

function serviceFor({
  spotTrades = [],
  futuresTrades = [],
  futuresContracts = {},
  futuresOrders = {},
  futuresPositions = [],
  futuresPositionCloses = [],
  tickers = [],
  cycleMemory = [],
} = {}) {
  const cycleMemoryStore = {
    load: jest.fn(async () => cycleMemory),
    saveCompleteCycles: jest.fn(async (cycles) => cycles),
  };
  const fakeClient = {
    getSpotMyTradesRaw: jest.fn(async () => ({
      success: true,
      data: spotTrades,
    })),
    getFuturesUsdtMyTradesRaw: jest.fn(async () => ({
      success: true,
      data: futuresTrades,
    })),
    getFuturesUsdtPositionCloseRaw: jest.fn(async () => ({
      success: true,
      data: futuresPositionCloses,
    })),
    getFuturesUsdtContractRaw: jest.fn(async ({ contract } = {}) => {
      const data = futuresContracts[contract];
      return data
        ? { success: true, data }
        : {
            success: false,
            safeErrorMessage: `missing contract ${contract}`,
          };
    }),
    getFuturesUsdtOrderRaw: jest.fn(async ({ contract, orderId } = {}) => {
      const data = futuresOrders[`${contract}:${orderId}`];
      return data
        ? { success: true, data }
        : {
            success: false,
            safeErrorMessage: `missing order ${orderId}`,
          };
    }),
    getFuturesUsdtPositionsRaw: jest.fn(async () => ({
      success: true,
      data: futuresPositions,
    })),
    getSpotTickersRaw: jest.fn(async () => ({
      success: true,
      data: tickers,
    })),
  };

  return {
    fakeClient,
    service: new GateTradeRecordsService({
      restClientFactory: () => fakeClient,
      now: () => nowSec * 1000,
      wsManager: {
        addPrivateEventListener: jest.fn(() => jest.fn()),
        start: jest.fn(),
      },
      cycleMemoryStore,
    }),
    cycleMemoryStore,
  };
}

function spotTrade(overrides = {}) {
  return {
    id: "spot-fee-test",
    create_time: String(nowSec),
    currency_pair: "BTC_USDT",
    side: "buy",
    amount: "0.001",
    price: "63310.7",
    fee: "0",
    fee_currency: "BTC",
    point_fee: "0",
    gt_fee: "0",
    order_id: "order-1",
    ...overrides,
  };
}

async function firstRecord(options) {
  const { service, fakeClient } = serviceFor(options);
  const payload = await service.snapshot({
    from: nowSec - 60,
    to: nowSec + 60,
    limit: 10,
    debugFeeFields: true,
  });
  return { record: payload.records[0], payload, fakeClient };
}

function futuresTrade(overrides = {}) {
  return {
    id: "futures-test",
    create_time: String(nowSec),
    contract: "CL_USDT",
    order_id: "futures-order-1",
    size: "-149",
    close_size: "0",
    price: "94",
    fee: "0.028012",
    role: "taker",
    ...overrides,
  };
}

async function futuresRecords(options, snapshotOptions = {}) {
  const { service, fakeClient } = serviceFor(options);
  const payload = await service.snapshot({
    from: nowSec - 60,
    to: nowSec + 60,
    limit: 10,
    ...snapshotOptions,
  });
  return {
    records: payload.records.filter(
      (record) => record.marketType === "futures"
    ),
    payload,
    fakeClient,
  };
}

describe("Gate trade records fee normalization", () => {
  test("converts base-asset spot fee with the trade price", async () => {
    const { record } = await firstRecord({
      spotTrades: [
        spotTrade({
          fee: "0.000000065",
          fee_currency: "BTC",
        }),
      ],
    });

    expect(record).toMatchObject({
      feeUsd: "0.0041",
      feeAmount: "0.000000065",
      feeCurrency: "BTC",
      feeSource: "asset",
      feeDisplayAmount: "0.000000065",
      feeDisplayCurrency: "BTC",
    });
  });

  test("keeps quote-asset spot fee as USD equivalent for USDT pairs", async () => {
    const { record } = await firstRecord({
      spotTrades: [
        spotTrade({
          fee: "0.25",
          fee_currency: "USDT",
        }),
      ],
    });

    expect(record).toMatchObject({
      feeUsd: "0.2500",
      feeAmount: "0.25",
      feeCurrency: "USDT",
      feeSource: "asset",
      feeDisplayAmount: "0.25",
      feeDisplayCurrency: "USDT",
    });
  });

  test("shows point fee as a distinct unpriced deduction source", async () => {
    const { record } = await firstRecord({
      spotTrades: [
        spotTrade({
          fee: "0",
          point_fee: "0.0041",
          fee_currency: "BTC",
        }),
      ],
    });

    expect(record).toMatchObject({
      feeUsd: "0.0000",
      feeAmount: "0",
      feeCurrency: "BTC",
      feeSource: "point",
      pointFeeAmount: "0.0041",
      feeDisplayAmount: "0.0041",
      feeDisplayCurrency: "点卡抵扣",
    });
  });

  test("converts GT fee with GT_USDT ticker price", async () => {
    const { record, fakeClient } = await firstRecord({
      spotTrades: [
        spotTrade({
          fee: "0",
          gt_fee: "2",
          fee_currency: "BTC",
        }),
      ],
      tickers: [{ currency_pair: "GT_USDT", last: "1.55" }],
    });

    expect(fakeClient.getSpotTickersRaw).toHaveBeenCalledTimes(1);
    expect(record).toMatchObject({
      feeUsd: "3.1000",
      feeAmount: "0",
      feeCurrency: "BTC",
      feeSource: "gt",
      gtFeeAmount: "2",
      feeDisplayAmount: "2",
      feeDisplayCurrency: "GT",
    });
  });

  test("keeps zero spot fee distinct from point or GT deductions", async () => {
    const { record } = await firstRecord({
      spotTrades: [spotTrade()],
    });

    expect(record).toMatchObject({
      feeUsd: "0.0000",
      feeAmount: "0",
      feeCurrency: "BTC",
      feeSource: "zero",
      feeDisplayAmount: "0",
      feeDisplayCurrency: "BTC",
    });
  });

  test("returns safe fee debug fields when requested", async () => {
    const { payload } = await firstRecord({
      spotTrades: [
        spotTrade({
          fee: "0",
          point_fee: "0.0041",
          gt_fee: "0",
        }),
      ],
    });

    expect(payload.debugFeeFields).toEqual([
      {
        currency_pair: "BTC_USDT",
        order_id: "order-1",
        fee: "0",
        fee_currency: "BTC",
        point_fee: "0.0041",
        gt_fee: "0",
      },
    ]);
  });
});

describe("Gate futures trade records normalization", () => {
  test("uses quanto multiplier for CL_USDT quantity and notional", async () => {
    const { records } = await futuresRecords({
      futuresTrades: [futuresTrade({ size: "-149", close_size: "0" })],
      futuresContracts: {
        CL_USDT: { name: "CL_USDT", quanto_multiplier: "0.01" },
      },
      futuresOrders: {
        "CL_USDT:futures-order-1": {
          id: "futures-order-1",
          contract: "CL_USDT",
          size: "-988",
          is_reduce_only: false,
          is_close: false,
        },
      },
    });

    expect(records[0]).toMatchObject({
      symbol: "CLUSDT",
      action: "futures_open_short",
      quantity: "1.49",
      price: "94",
      notionalUsd: "140.06",
    });
  });

  test("aggregates CL_USDT split fills into one order-level row", async () => {
    const { records, payload } = await futuresRecords({
      futuresTrades: [
        futuresTrade({
          id: "cl-fill-1",
          order_id: "cl-order",
          size: "-149",
          close_size: "0",
        }),
        futuresTrade({
          id: "cl-fill-2",
          order_id: "cl-order",
          size: "-839",
          close_size: "0",
        }),
      ],
      futuresContracts: {
        CL_USDT: { name: "CL_USDT", quanto_multiplier: "0.01" },
      },
      futuresOrders: {
        "CL_USDT:cl-order": {
          id: "cl-order",
          contract: "CL_USDT",
          size: "-988",
          is_reduce_only: false,
          is_close: false,
        },
      },
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "futures:order:cl-order:CLUSDT:futures_open_short:perpetual",
      quantity: "9.88",
      price: "94",
      notionalUsd: "928.72",
      feeUsd: "0.0560",
      fillCount: 2,
      fillIds: ["futures:cl-fill-1", "futures:cl-fill-2"],
      isAggregated: true,
    });
    expect(payload.summary.futuresNotionalUsd).toBe("928.72");
    expect(payload.summary.tradeCount).toBe(1);
    expect(payload.hasMoreHistory).toBe(false);
  });

  test("keeps pagination cursor based on raw fills after order aggregation", async () => {
    const { payload } = await futuresRecords(
      {
        futuresTrades: [
          futuresTrade({
            id: "cl-fill-1",
            order_id: "cl-order",
            create_time: String(nowSec),
            size: "-149",
            close_size: "0",
          }),
          futuresTrade({
            id: "cl-fill-2",
            order_id: "cl-order",
            create_time: String(nowSec - 1),
            size: "-839",
            close_size: "0",
          }),
        ],
        futuresContracts: {
          CL_USDT: { name: "CL_USDT", quanto_multiplier: "0.01" },
        },
        futuresOrders: {
          "CL_USDT:cl-order": {
            id: "cl-order",
            contract: "CL_USDT",
            size: "-988",
            is_reduce_only: false,
            is_close: false,
          },
        },
      },
      { limit: 2 }
    );

    expect(payload.records).toHaveLength(1);
    expect(payload.hasMoreHistory).toBe(true);
    expect(payload.nextCursorTs).toBe((nowSec - 1) * 1000 - 1);
  });

  test("uses close_size to show close-short and close-long trades", async () => {
    const { records } = await futuresRecords({
      futuresTrades: [
        futuresTrade({
          id: "close-short",
          order_id: "close-short-order",
          size: "4",
          close_size: "4",
        }),
        futuresTrade({
          id: "close-long",
          order_id: "close-long-order",
          size: "-3",
          close_size: "-3",
        }),
      ],
      futuresContracts: {
        CL_USDT: { name: "CL_USDT", quanto_multiplier: "0.01" },
      },
      futuresOrders: {
        "CL_USDT:close-short-order": {
          id: "close-short-order",
          contract: "CL_USDT",
        },
        "CL_USDT:close-long-order": {
          id: "close-long-order",
          contract: "CL_USDT",
        },
      },
    });

    expect(records.map((record) => record.action)).toEqual([
      "futures_close_short",
      "futures_close_long",
    ]);
  });

  test("uses order metadata as close fallback when close_size is absent", async () => {
    const { records } = await futuresRecords({
      futuresTrades: [
        futuresTrade({
          id: "auto-close-short",
          order_id: "auto-close-short-order",
          size: "4",
          close_size: "0",
        }),
        futuresTrade({
          id: "auto-close-long",
          order_id: "auto-close-long-order",
          size: "-3",
          close_size: "0",
        }),
      ],
      futuresContracts: {
        CL_USDT: { name: "CL_USDT", quanto_multiplier: "0.01" },
      },
      futuresOrders: {
        "CL_USDT:auto-close-short-order": {
          id: "auto-close-short-order",
          contract: "CL_USDT",
          auto_size: "close_short",
          is_reduce_only: true,
          is_close: true,
        },
        "CL_USDT:auto-close-long-order": {
          id: "auto-close-long-order",
          contract: "CL_USDT",
          auto_size: "close_long",
          is_reduce_only: true,
          is_close: true,
        },
      },
    });

    expect(records.map((record) => record.action)).toEqual([
      "futures_close_short",
      "futures_close_long",
    ]);
  });

  test("hydrates close records with position_close pnl and backend pnl percent", async () => {
    const { records, payload, fakeClient } = await futuresRecords({
      futuresTrades: [
        futuresTrade({
          id: "cl-open-fill",
          order_id: "cl-open-order",
          create_time: String(nowSec - 30),
          size: "-988",
          close_size: "0",
          price: "94",
        }),
        futuresTrade({
          id: "cl-close-fill",
          order_id: "cl-close-order",
          create_time: String(nowSec),
          size: "988",
          close_size: "988",
          price: "90.9938",
          fee: "0.40455828",
        }),
      ],
      futuresContracts: {
        CL_USDT: { name: "CL_USDT", quanto_multiplier: "0.01" },
      },
      futuresOrders: {
        "CL_USDT:cl-open-order": {
          id: "cl-open-order",
          contract: "CL_USDT",
          size: "-988",
          is_reduce_only: false,
          is_close: false,
        },
        "CL_USDT:cl-close-order": {
          id: "cl-close-order",
          contract: "CL_USDT",
          auto_size: "close_short",
          is_reduce_only: true,
          is_close: true,
        },
      },
      futuresPositionCloses: [
        {
          time: nowSec,
          contract: "CL_USDT",
          side: "short",
          pnl: "29.70",
          margin: "19.285",
          long_price: "90.9938",
          short_price: "94",
          accum_size: "988",
        },
      ],
    });

    const closeRecord = records.find(
      (record) => record.action === "futures_close_short"
    );
    expect(closeRecord).toMatchObject({
      realizedPnlUsd: "29.70",
      realizedPnlPct: "154.01",
      realizedPnlSource: "position_close",
    });
    expect(payload.summary.totalRealizedPnlUsd).toBe("29.70");
    expect(payload.summary.winRatePct).toBe("100.00");
    expect(fakeClient.getFuturesUsdtPositionCloseRaw).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, from: nowSec - 60, to: nowSec })
    );
  });

  test("does not apply unmatched position_close pnl to unrelated close records", async () => {
    const { records, payload } = await futuresRecords({
      futuresTrades: [
        futuresTrade({
          id: "cl-close-fill",
          order_id: "cl-close-order",
          size: "988",
          close_size: "988",
          price: "90.9938",
        }),
      ],
      futuresContracts: {
        CL_USDT: { name: "CL_USDT", quanto_multiplier: "0.01" },
      },
      futuresOrders: {
        "CL_USDT:cl-close-order": {
          id: "cl-close-order",
          contract: "CL_USDT",
          auto_size: "close_short",
          is_reduce_only: true,
          is_close: true,
        },
      },
      futuresPositionCloses: [
        {
          time: nowSec,
          contract: "BTC_USDT",
          side: "short",
          pnl: "29.70",
          margin: "19.285",
          long_price: "90.9938",
          short_price: "94",
        },
      ],
    });

    const closeRecord = records.find(
      (record) => record.action === "futures_close_short"
    );
    expect(closeRecord.realizedPnlUsd).toBeNull();
    expect(closeRecord.realizedPnlPct).toBeNull();
    expect(closeRecord.realizedPnlSource).toBeNull();
    expect(payload.summary.totalRealizedPnlUsd).toBe("0.00");
  });

  test("uses cycle-estimated pnl as final fallback for matched close records", async () => {
    const { records, payload } = await futuresRecords({
      futuresTrades: [
        futuresTrade({
          id: "cl-open-fill",
          order_id: "cl-open-order",
          create_time: String(nowSec - 30),
          size: "-988",
          close_size: "0",
          price: "94",
        }),
        futuresTrade({
          id: "cl-close-fill",
          order_id: "cl-close-order",
          create_time: String(nowSec),
          size: "988",
          close_size: "988",
          price: "90.9938",
        }),
      ],
      futuresContracts: {
        CL_USDT: { name: "CL_USDT", quanto_multiplier: "0.01" },
      },
      futuresOrders: {
        "CL_USDT:cl-open-order": {
          id: "cl-open-order",
          contract: "CL_USDT",
          size: "-988",
          is_reduce_only: false,
          is_close: false,
        },
        "CL_USDT:cl-close-order": {
          id: "cl-close-order",
          contract: "CL_USDT",
          auto_size: "close_short",
          is_reduce_only: true,
          is_close: true,
        },
      },
    });

    const closeRecord = records.find(
      (record) => record.action === "futures_close_short"
    );
    expect(closeRecord).toMatchObject({
      realizedPnlUsd: "29.70",
      realizedPnlPct: null,
      realizedPnlSource: "cycle_estimated",
    });
    expect(payload.summary.totalRealizedPnlUsd).toBe("29.70");
  });

  test("falls back safely when futures contract metadata is missing", async () => {
    const { records, payload } = await futuresRecords({
      futuresTrades: [futuresTrade({ size: "-149", close_size: "0" })],
      futuresContracts: {},
      futuresOrders: {
        "CL_USDT:futures-order-1": {
          id: "futures-order-1",
          contract: "CL_USDT",
        },
      },
    });

    expect(records[0]).toMatchObject({
      quantity: "149",
      notionalUsd: "14006.00",
      action: "futures_open_short",
    });
    expect(payload.connectionStatus).toBe("degraded");
    expect(payload.partialFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "futures_contract_metadata" }),
      ])
    );
  });
});

describe("Gate trade records order aggregation", () => {
  test("aggregates split spot fills from the same order", async () => {
    const { payload } = await firstRecord({
      spotTrades: [
        spotTrade({
          id: "spot-fill-1",
          order_id: "spot-order",
          amount: "0.000218",
          price: "59769.5",
          fee: "0",
          gt_fee: "0.01",
        }),
        spotTrade({
          id: "spot-fill-2",
          order_id: "spot-order",
          amount: "0.0002",
          price: "59769.5",
          fee: "0",
          gt_fee: "0.02",
        }),
      ],
      tickers: [{ currency_pair: "GT_USDT", last: "1.55" }],
    });

    expect(payload.records).toHaveLength(1);
    expect(payload.records[0]).toMatchObject({
      id: "spot:order:spot-order:BTCUSDT:spot_buy:spot",
      quantity: "0.000418",
      price: "59769.5",
      notionalUsd: "24.98",
      feeUsd: "0.0465",
      gtFeeAmount: "0.03",
      fillCount: 2,
      fillIds: ["spot:spot-fill-1", "spot:spot-fill-2"],
    });
    expect(payload.summary.tradeCount).toBe(1);
  });

  test("does not aggregate records with different actions under the same order id", async () => {
    const { payload } = await firstRecord({
      spotTrades: [
        spotTrade({
          id: "spot-buy-fill",
          order_id: "same-order",
          side: "buy",
          amount: "0.001",
        }),
        spotTrade({
          id: "spot-sell-fill",
          order_id: "same-order",
          side: "sell",
          amount: "0.002",
        }),
      ],
    });

    expect(payload.records).toHaveLength(2);
    expect(payload.records.map((record) => record.action).sort()).toEqual([
      "spot_buy",
      "spot_sell",
    ]);
  });
});

function feeSummaryServiceFor({
  spotAccountBook = [],
  futuresFeeAccountBook = [],
  futuresPointFeeAccountBook = [],
  tickers = [],
} = {}) {
  const fakeClient = {
    getSpotAccountBook: jest.fn(async () => ({
      success: true,
      data: spotAccountBook,
    })),
    getFuturesUsdtAccountBook: jest.fn(async ({ type } = {}) => ({
      success: true,
      data:
        type === "point_fee"
          ? futuresPointFeeAccountBook
          : futuresFeeAccountBook,
    })),
    getSpotTickersRaw: jest.fn(async () => ({
      success: true,
      data: tickers,
    })),
    getSpotMyTradesRaw: jest.fn(),
    getFuturesUsdtMyTradesRaw: jest.fn(),
  };

  return {
    fakeClient,
    service: new GateTradeRecordsFeeSummaryService({
      restClientFactory: () => fakeClient,
    }),
  };
}

function accountBookRecord(overrides = {}) {
  return {
    id: "book-1",
    time: nowSec * 1000,
    currency: "USDT",
    change: "-0.25",
    type: "fee",
    code: "151",
    text: "fee-test",
    ...overrides,
  };
}

async function feeSummarySnapshot(options) {
  const { service, fakeClient } = feeSummaryServiceFor(options);
  const payload = await service.snapshot({
    from: nowSec - 60,
    to: nowSec + 60,
    includeYear: false,
  });
  return { payload, fakeClient };
}

describe("Gate trade records fee summary", () => {
  test("sums spot USDT account-book fee without trade history", async () => {
    const { payload, fakeClient } = await feeSummarySnapshot({
      spotAccountBook: [
        accountBookRecord({
          id: "spot-usdt-fee",
          currency: "USDT",
          change: "-0.25",
          code: "151",
        }),
      ],
    });

    expect(payload.totalFeeUsd).toBe("0.25");
    expect(payload.feeSources).toMatchObject({
      spotUsd: "0.25",
      futuresUsd: "0.00",
    });
    expect(fakeClient.getSpotAccountBook).toHaveBeenCalledWith(
      expect.objectContaining({ code: "151" })
    );
    expect(fakeClient.getSpotMyTradesRaw).not.toHaveBeenCalled();
    expect(fakeClient.getFuturesUsdtMyTradesRaw).not.toHaveBeenCalled();
  });

  test("does not count non-fee spot account-book rows if Gate returns unfiltered data", async () => {
    const { payload } = await feeSummarySnapshot({
      spotAccountBook: [
        accountBookRecord({
          id: "spot-buy-row",
          currency: "USDT",
          change: "-100",
          code: "102",
          type: "buy",
        }),
        accountBookRecord({
          id: "spot-real-fee",
          currency: "USDT",
          change: "-0.25",
          code: "151",
          type: "fee",
        }),
      ],
    });

    expect(payload.totalFeeUsd).toBe("0.25");
    expect(payload.feeSources.spotUsd).toBe("0.25");
  });

  test("converts spot GT account-book fee through GT_USDT", async () => {
    const { payload, fakeClient } = await feeSummarySnapshot({
      spotAccountBook: [
        accountBookRecord({
          id: "spot-gt-fee",
          currency: "GT",
          change: "-2",
          code: "151",
        }),
      ],
      tickers: [{ currency_pair: "GT_USDT", last: "1.55" }],
    });

    expect(fakeClient.getSpotTickersRaw).toHaveBeenCalledTimes(1);
    expect(payload.totalFeeUsd).toBe("3.10");
    expect(payload.feeSources.gtUsd).toBe("3.10");
  });

  test("converts non-stable asset fee through asset_USDT ticker", async () => {
    const { payload } = await feeSummarySnapshot({
      spotAccountBook: [
        accountBookRecord({
          id: "spot-btc-fee",
          currency: "BTC",
          change: "-0.001",
          code: "151",
        }),
      ],
      tickers: [{ currency_pair: "BTC_USDT", last: "63310.7" }],
    });

    expect(payload.totalFeeUsd).toBe("63.31");
    expect(payload.feeSources.spotUsd).toBe("63.31");
    expect(payload.partialFailures).toEqual([]);
  });

  test("sums futures USDT fee from futures account book", async () => {
    const { payload, fakeClient } = await feeSummarySnapshot({
      futuresFeeAccountBook: [
        accountBookRecord({
          id: "futures-usdt-fee",
          currency: "USDT",
          change: "-1.75",
          type: "fee",
        }),
      ],
    });

    expect(payload.totalFeeUsd).toBe("1.75");
    expect(payload.feeSources.futuresUsd).toBe("1.75");
    expect(fakeClient.getFuturesUsdtAccountBook).toHaveBeenCalledWith(
      expect.objectContaining({ type: "fee" })
    );
  });

  test("does not count non-fee futures account-book rows if Gate returns unfiltered data", async () => {
    const { payload } = await feeSummarySnapshot({
      futuresFeeAccountBook: [
        accountBookRecord({
          id: "futures-pnl-row",
          currency: "USDT",
          change: "200",
          type: "pnl",
        }),
        accountBookRecord({
          id: "futures-fund-row",
          currency: "USDT",
          change: "-3",
          type: "fund",
        }),
        accountBookRecord({
          id: "futures-real-fee",
          currency: "USDT",
          change: "-1.75",
          type: "fee",
        }),
      ],
    });

    expect(payload.totalFeeUsd).toBe("1.75");
    expect(payload.feeSources.futuresUsd).toBe("1.75");
  });

  test("keeps point fee out of USD total and marks source amount", async () => {
    const { payload } = await feeSummarySnapshot({
      futuresPointFeeAccountBook: [
        accountBookRecord({
          id: "futures-point-fee",
          currency: "POINT",
          change: "-0.0041",
          type: "point_fee",
        }),
      ],
    });

    expect(payload.totalFeeUsd).toBe("0.00");
    expect(payload.feeSources.pointAmount).toBe("0.00410000");
    expect(payload.connectionStatus).toBe("degraded");
    expect(payload.partialFailures).toEqual([
      {
        source: "futures_fee_summary_point_fee",
        message: "点卡抵扣手续费未确认等值单位，未计入 USD 手续费总额。",
      },
    ]);
  });

  test("marks missing ticker as partial failure instead of fabricating total", async () => {
    const { payload } = await feeSummarySnapshot({
      spotAccountBook: [
        accountBookRecord({
          id: "spot-unknown-fee",
          currency: "ABC",
          change: "-1",
          code: "151",
        }),
      ],
      tickers: [],
    });

    expect(payload.totalFeeUsd).toBe("0.00");
    expect(payload.connectionStatus).toBe("degraded");
    expect(payload.partialFailures).toEqual([
      {
        source: "spot_fee_summary_conversion",
        message: "手续费总额折算缺价格：ABC_USDT",
      },
    ]);
  });
});
