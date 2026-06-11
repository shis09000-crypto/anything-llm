const {
  SystemSettingsTradeCycleMemoryStore,
  buildTradeCycles,
  serializeCycleForMemory,
} = require("../../../utils/cryptoGate/tradeRecordCycles");
const { isSecretEncrypted, readSecret } = require("../../../utils/security");

const baseTs = 1_800_000_000_000;
const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const originalEncryptionMasterKey = process.env.ENCRYPTION_MASTER_KEY;
const historyCoverage = {
  requestedFrom: Math.floor((baseTs - 24 * 60 * 60 * 1000) / 1000),
  requestedTo: Math.floor((baseTs + 24 * 60 * 60 * 1000) / 1000),
  loadedFrom: Math.floor((baseTs - 24 * 60 * 60 * 1000) / 1000),
  loadedTo: Math.floor((baseTs + 24 * 60 * 60 * 1000) / 1000),
  effectiveTo: Math.floor((baseTs + 24 * 60 * 60 * 1000) / 1000),
  batchLimit: 50,
  hasMoreBefore: false,
};

function futuresRecord({
  id,
  ts,
  action,
  quantity,
  symbol = "BTCUSDT",
  baseAsset = "BTC",
  quoteAsset = "USDT",
  contractType = "perpetual",
  price = "100",
  orderId = id,
  realizedPnlUsd = "0.00",
  fillIds,
}) {
  return {
    id,
    ts,
    marketType: "futures",
    symbol,
    baseAsset,
    quoteAsset,
    contractType,
    action,
    quantity,
    price,
    notionalUsd: "100.00",
    feeUsd: "0.1000",
    feeAmount: "0.1",
    feeCurrency: "USDT",
    feeSource: "asset",
    pointFeeAmount: "0",
    gtFeeAmount: "0",
    feeDisplayAmount: "0.1",
    feeDisplayCurrency: "USDT",
    realizedPnlUsd,
    orderId,
    fillIds,
  };
}

function build(records, options = {}) {
  return buildTradeCycles({
    records,
    historyCoverage,
    openPositions: [],
    cycleMemory: [],
    ...options,
  });
}

describe("Futures trade cycle matching", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalEncryptionMasterKey === undefined) {
      delete process.env.ENCRYPTION_MASTER_KEY;
    } else {
      process.env.ENCRYPTION_MASTER_KEY = originalEncryptionMasterKey;
    }
  });

  test("matches only within symbol, contract type, and long or short side pools", () => {
    const result = build([
      futuresRecord({
        id: "btc-long-open",
        ts: baseTs,
        action: "futures_open_long",
        quantity: "1",
        orderId: "btc-long-open-order",
      }),
      futuresRecord({
        id: "btc-short-open",
        ts: baseTs + 1,
        action: "futures_open_short",
        quantity: "2",
        orderId: "btc-short-open-order",
      }),
      futuresRecord({
        id: "eth-long-open",
        ts: baseTs + 2,
        action: "futures_open_long",
        quantity: "3",
        symbol: "ETHUSDT",
        baseAsset: "ETH",
        orderId: "eth-long-open-order",
      }),
      futuresRecord({
        id: "btc-long-close",
        ts: baseTs + 3,
        action: "futures_close_long",
        quantity: "1",
        orderId: "btc-long-close-order",
      }),
      futuresRecord({
        id: "btc-short-close",
        ts: baseTs + 4,
        action: "futures_close_short",
        quantity: "2",
        orderId: "btc-short-close-order",
      }),
      futuresRecord({
        id: "eth-long-close",
        ts: baseTs + 5,
        action: "futures_close_long",
        quantity: "3",
        symbol: "ETHUSDT",
        baseAsset: "ETH",
        orderId: "eth-long-close-order",
      }),
    ]);

    const completeCycles = result.cycles.filter(
      (cycle) => cycle.cycleConfidence === "complete"
    );
    expect(completeCycles).toHaveLength(3);
    expect(
      new Set(completeCycles.map((cycle) => `${cycle.symbol}:${cycle.side}`))
    ).toEqual(new Set(["BTCUSDT:long", "BTCUSDT:short", "ETHUSDT:long"]));
  });

  test("keeps add-ons and partial closes in one FIFO cycle until flat", () => {
    const result = build([
      futuresRecord({
        id: "open-1",
        ts: baseTs,
        action: "futures_open_long",
        quantity: "1",
        price: "100",
      }),
      futuresRecord({
        id: "open-2",
        ts: baseTs + 1,
        action: "futures_open_long",
        quantity: "2",
        price: "110",
      }),
      futuresRecord({
        id: "close-1",
        ts: baseTs + 2,
        action: "futures_close_long",
        quantity: "1.5",
        price: "120",
      }),
      futuresRecord({
        id: "close-2",
        ts: baseTs + 3,
        action: "futures_close_long",
        quantity: "1.5",
        price: "130",
      }),
    ]);

    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toMatchObject({
      status: "closed",
      cycleConfidence: "complete",
      totalOpenedQty: "3",
      totalClosedQty: "3",
      remainingQty: "0",
    });
    expect(result.cycles[0].matches).toHaveLength(3);
    expect(new Set(result.records.map((record) => record.cycleId)).size).toBe(
      1
    );
    expect(
      result.records.every((record) => record.cycleStatus === "closed")
    ).toBe(true);
  });

  test("starts a new cycle after the position returns to zero", () => {
    const result = build([
      futuresRecord({
        id: "cycle-1-open",
        ts: baseTs,
        action: "futures_open_long",
        quantity: "1",
      }),
      futuresRecord({
        id: "cycle-1-close",
        ts: baseTs + 1,
        action: "futures_close_long",
        quantity: "1",
      }),
      futuresRecord({
        id: "cycle-2-open",
        ts: baseTs + 2,
        action: "futures_open_long",
        quantity: "1",
      }),
    ]);

    expect(result.cycles).toHaveLength(2);
    const closed = result.cycles.find((cycle) => cycle.status === "closed");
    const open = result.cycles.find((cycle) => cycle.status === "open");
    expect(closed.cycleConfidence).toBe("complete");
    expect(open.cycleConfidence).toBe("partial_history");
    expect(closed.id).not.toBe(open.id);
  });

  test("does not match a close at the window start to a later open", () => {
    const result = build([
      futuresRecord({
        id: "first-close",
        ts: baseTs,
        action: "futures_close_long",
        quantity: "1",
      }),
      futuresRecord({
        id: "later-open",
        ts: baseTs + 1,
        action: "futures_open_long",
        quantity: "1",
      }),
    ]);

    const firstClose = result.records.find(
      (record) => record.id === "first-close"
    );
    const laterOpen = result.records.find(
      (record) => record.id === "later-open"
    );
    expect(firstClose).toMatchObject({
      cycleConfidence: "unmatched",
      matchRole: "unmatched_close",
      matchWarning: "missing_open_before_window",
      matchedQty: "0",
    });
    expect(laterOpen.cycleId).not.toBe(firstClose.cycleId);
  });

  test("marks close quantity above available open lots as partial history", () => {
    const result = build([
      futuresRecord({
        id: "open",
        ts: baseTs,
        action: "futures_open_long",
        quantity: "1",
      }),
      futuresRecord({
        id: "oversized-close",
        ts: baseTs + 1,
        action: "futures_close_long",
        quantity: "1.5",
      }),
    ]);

    const close = result.records.find(
      (record) => record.id === "oversized-close"
    );
    expect(result.cycles[0]).toMatchObject({
      status: "partial",
      cycleConfidence: "partial_history",
      unmatchedCloseQty: "0.5",
    });
    expect(close).toMatchObject({
      matchedQty: "1",
      matchRole: "unmatched_close",
      matchWarning: "unmatched_close",
    });
  });

  test("creates a boundary cycle when current positions predate the loaded window", () => {
    const result = build([], {
      openPositions: [
        {
          symbol: "SOLUSDT",
          contractType: "perpetual",
          side: "long",
          quantityAmount: "2.5",
          entryPrice: "160",
        },
      ],
    });

    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toMatchObject({
      symbol: "SOLUSDT",
      status: "partial",
      cycleConfidence: "partial_history",
      remainingQty: "2.5",
      boundaryReason: "position_existed_before_window",
    });
    expect(result.memoryUpdates).toEqual([]);
  });

  test("stores only complete cycles and caps SystemSettings memory", async () => {
    const updates = [];
    const settings = {
      get: jest.fn(async () => ({ value: JSON.stringify({ cycles: [] }) })),
      _updateSettings: jest.fn(async (payload) => {
        updates.push(payload);
        return { success: true };
      }),
    };
    const store = new SystemSettingsTradeCycleMemoryStore({
      settings,
      maxItems: 1,
    });
    const completeResult = build([
      futuresRecord({
        id: "complete-open",
        ts: baseTs,
        action: "futures_open_long",
        quantity: "1",
      }),
      futuresRecord({
        id: "complete-close",
        ts: baseTs + 1,
        action: "futures_close_long",
        quantity: "1",
      }),
    ]);
    const partialResult = build([
      futuresRecord({
        id: "partial-open",
        ts: baseTs + 2,
        action: "futures_open_long",
        quantity: "1",
      }),
    ]);

    const saved = await store.saveCompleteCycles([
      completeResult.cycles[0],
      partialResult.cycles[0],
    ]);

    expect(saved).toHaveLength(1);
    const storedValue = Object.values(updates[0])[0];
    expect(isSecretEncrypted(storedValue)).toBe(true);
    expect(JSON.parse(readSecret(storedValue)).cycles).toHaveLength(1);
    expect(saved[0].cycleId).toBe(completeResult.cycles[0].id);
  });

  test("loads old plaintext complete-cycle memory", async () => {
    const completeResult = build([
      futuresRecord({
        id: "legacy-open",
        ts: baseTs,
        action: "futures_open_long",
        quantity: "1",
      }),
      futuresRecord({
        id: "legacy-close",
        ts: baseTs + 1,
        action: "futures_close_long",
        quantity: "1",
      }),
    ]);
    const legacyMemory = serializeCycleForMemory(completeResult.cycles[0]);
    const store = new SystemSettingsTradeCycleMemoryStore({
      settings: {
        get: jest.fn(async () => ({
          value: JSON.stringify({
            version: 1,
            cycles: [legacyMemory],
          }),
        })),
      },
    });

    await expect(store.load()).resolves.toEqual([legacyMemory]);
  });

  test("restores a remembered cycle id from complete-cycle memory", () => {
    const records = [
      futuresRecord({
        id: "remembered-open",
        ts: baseTs,
        action: "futures_open_long",
        quantity: "1",
        orderId: "remembered-open-order",
      }),
      futuresRecord({
        id: "remembered-close",
        ts: baseTs + 1,
        action: "futures_close_long",
        quantity: "1",
        orderId: "remembered-close-order",
      }),
    ];
    const first = build(records);
    const memory = {
      ...serializeCycleForMemory(first.cycles[0]),
      cycleId: "cycle:remembered:stable",
    };
    const second = build(records, { cycleMemory: [memory] });

    expect(second.cycles[0].id).toBe("cycle:remembered:stable");
    expect(
      second.records.every(
        (record) => record.cycleId === "cycle:remembered:stable"
      )
    ).toBe(true);
    expect(
      second.records.every((record) => record.cycleConfidence === "complete")
    ).toBe(true);
  });

  test("uses memory to recover cycle context when only one side is loaded", () => {
    const completeRecords = [
      futuresRecord({
        id: "memory-open",
        ts: baseTs,
        action: "futures_open_long",
        quantity: "1",
        orderId: "memory-open-order",
      }),
      futuresRecord({
        id: "memory-close",
        ts: baseTs + 1,
        action: "futures_close_long",
        quantity: "1",
        orderId: "memory-close-order",
      }),
    ];
    const complete = build(completeRecords);
    const memory = {
      ...serializeCycleForMemory(complete.cycles[0]),
      cycleId: "cycle:memory:partial-window",
    };
    const partialWindow = build([completeRecords[1]], {
      cycleMemory: [memory],
    });

    expect(partialWindow.records[0]).toMatchObject({
      cycleId: "cycle:memory:partial-window",
      cycleStatus: "closed",
      cycleConfidence: "complete",
      matchRole: "close",
      matchWarning: "window_boundary",
    });
    expect(partialWindow.cycles[0]).toMatchObject({
      id: "cycle:memory:partial-window",
      isMemoryBacked: true,
      isPartialInWindow: true,
    });
    expect(partialWindow.memoryUpdates).toHaveLength(1);
  });
});
