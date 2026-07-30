/* eslint-env jest */

process.env.NODE_ENV = "test";

const {
  GateSpotEvidenceCollector,
  GateSpotEvidenceCollectorManager,
  _internals,
  clearMarketEvidenceCaches,
  fetchDerivativesEvidence,
} = require("../../../utils/cryptoGate/marketEvidence");

describe("public crypto market supporting evidence", () => {
  afterEach(() => clearMarketEvidenceCaches());

  it("computes taker flow, CVD, microprice, and depth imbalance", () => {
    const now = 1_800_000_000_000;
    const trades = [
      {
        timestampMs: now - 2_000,
        side: "buy",
        quoteNotional: 300,
      },
      {
        timestampMs: now - 1_000,
        side: "sell",
        quoteNotional: 100,
      },
    ];
    expect(_internals.tradeWindow(trades, 60_000, now)).toMatchObject({
      tradeCount: 2,
      buyQuoteNotional: 300,
      sellQuoteNotional: 100,
      takerBuyRatio: 0.75,
      cumulativeVolumeDelta: 200,
      averageTradeQuote: 200,
    });

    expect(
      _internals.depthMetrics({
        timestampMs: now,
        bids: [
          [100, 3],
          [99.9, 1],
        ],
        asks: [
          [100.1, 1],
          [100.2, 1],
        ],
      })
    ).toMatchObject({
      spreadBps: expect.any(Number),
      microPrice: 100.075,
      depth: {
        "25bps": {
          bidQuoteNotional: 399.9,
          askQuoteNotional: 200.3,
          imbalance: expect.any(Number),
        },
      },
    });
  });

  it("rebuilds the order book when an update sequence has a gap", async () => {
    const client = {
      getSpotOrderBookRaw: jest.fn().mockResolvedValue({
        success: true,
        data: {
          id: 11,
          bids: [["100", "2"]],
          asks: [["101", "1"]],
        },
      }),
    };
    const collector = new GateSpotEvidenceCollector({
      pair: "BTC_USDT",
      client,
      WebSocketImpl: class {},
      now: () => 1_800_000_000_000,
    });
    collector.bookId = 10;

    expect(
      collector.applyDepthUpdate({
        U: 12,
        u: 12,
        b: [["100", "3"]],
        a: [],
      })
    ).toBe(false);
    await collector.resyncPromise;

    expect(client.getSpotOrderBookRaw).toHaveBeenCalledWith({
      currencyPair: "BTC_USDT",
      limit: 100,
      withId: true,
    });
    expect(collector.bookId).toBe(12);
    expect(collector.lastError).toBeNull();
    collector.stop();
  });

  it("samples only synchronized order books on the fixed cadence", () => {
    jest.useFakeTimers();
    const collector = new GateSpotEvidenceCollector({
      pair: "BTC_USDT",
      WebSocketImpl: class {},
      now: () => Date.now(),
    });
    collector.bids = new Map([[100, 2]]);
    collector.asks = new Map([[101, 1]]);
    collector.startSampling();

    jest.advanceTimersByTime(2_000);
    expect(collector.depthSamples).toHaveLength(0);

    collector.bookId = 10;
    jest.advanceTimersByTime(3_000);
    expect(collector.depthSamples).toHaveLength(3);

    collector.bookId = null;
    jest.advanceTimersByTime(2_000);
    expect(collector.depthSamples).toHaveLength(3);
    collector.stop();
    jest.useRealTimers();
  });

  it("retries a resync when the first fetched baseline cannot bridge the buffer", async () => {
    const client = {
      getSpotOrderBookRaw: jest
        .fn()
        .mockResolvedValueOnce({
          success: true,
          data: {
            id: 20,
            bids: [["100", "2"]],
            asks: [["101", "1"]],
          },
        })
        .mockResolvedValueOnce({
          success: true,
          data: {
            id: 29,
            bids: [["100", "2"]],
            asks: [["101", "1"]],
          },
        }),
    };
    const collector = new GateSpotEvidenceCollector({
      pair: "BTC_USDT",
      client,
      WebSocketImpl: class {},
      now: () => 1_800_000_000_000,
    });
    collector.bookId = 10;
    collector.applyDepthUpdate({
      U: 30,
      u: 30,
      b: [["100", "3"]],
      a: [],
    });

    await collector.resyncPromise;
    await new Promise((resolve) => setImmediate(resolve));
    await collector.resyncPromise;

    expect(client.getSpotOrderBookRaw).toHaveBeenCalledTimes(2);
    expect(collector.bookId).toBe(30);
    expect(collector.lastError).toBeNull();
    collector.stop();
  });

  it("evicts the least recently used hot pair", () => {
    let access = 0;
    const stopped = [];
    const manager = new GateSpotEvidenceCollectorManager({
      maxPairs: 2,
      idleMs: 60_000,
      collectorFactory: ({ pair }) => ({
        pair,
        lastAccessAt: ++access,
        touch() {
          this.lastAccessAt = ++access;
        },
        stop() {
          stopped.push(pair);
        },
      }),
      now: () => access,
    });

    manager.get("BTC_USDT");
    manager.get("ETH_USDT");
    manager.get("BTC_USDT");
    manager.get("SOL_USDT");

    expect([...manager.collectors.keys()].sort()).toEqual([
      "BTC_USDT",
      "SOL_USDT",
    ]);
    expect(stopped).toContain("ETH_USDT");
    manager.stop();
  });

  it("computes public perpetual OI, funding, positioning, basis, and liquidation evidence", async () => {
    const now = 1_800_000_000_000;
    const stats = Array.from({ length: 289 }, (_, index) => ({
      time: Math.floor((now - (288 - index) * 5 * 60_000) / 1_000),
      open_interest_usd: String(100 + index),
      lsr_taker: "1.2",
      lsr_account: "1.1",
      top_lsr_account: "1.3",
      top_lsr_size: "0.9",
      long_liq_usd_new: index >= 277 ? "10" : "0",
      short_liq_usd_new: index >= 277 ? "20" : "0",
      mark_price: "101",
    }));
    const funding = Array.from({ length: 30 }, (_, index) => ({
      t: Math.floor((now - (29 - index) * 8 * 60 * 60_000) / 1_000),
      r: String(index / 1_000_000),
    }));
    const client = {
      getFuturesUsdtContractRaw: jest.fn().mockResolvedValue({
        success: true,
        data: { last_price: "101", mark_price: "101", index_price: "100.5" },
      }),
      getFuturesUsdtContractStatsRaw: jest.fn().mockResolvedValue({
        success: true,
        data: stats,
      }),
      getFuturesUsdtFundingRatesRaw: jest.fn().mockResolvedValue({
        success: true,
        data: funding,
      }),
    };

    const result = await fetchDerivativesEvidence({
      pair: "BTC_USDT",
      spotPrice: 100,
      client,
      now,
    });

    expect(result).toMatchObject({
      status: "complete",
      market: {
        markVsSpotBasisPct: 1,
        markVsIndexPremiumPct: expect.any(Number),
      },
      openInterest: {
        currentUsd: 388,
        changePct: {
          "1h": expect.any(Number),
          "4h": expect.any(Number),
          "24h": 288,
        },
      },
      funding: {
        latestRate: 0.000029,
        sampleCount: 30,
        zScore30: expect.any(Number),
      },
      positioning: { takerLongShortRatio: 1.2 },
      liquidations: {
        "1h": {
          longLiquidationUsd: 120,
          shortLiquidationUsd: 240,
        },
      },
    });
    expect(client.getFuturesUsdtContractStatsRaw).toHaveBeenCalledWith({
      contract: "BTC_USDT",
      interval: "5m",
      limit: 300,
      from: Math.floor((now - (24 * 60 * 60 + 10 * 60) * 1_000) / 1_000),
    });
  });
});
