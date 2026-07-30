/* eslint-env jest */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  AnomalyArchive,
  BinanceMicrostructureCollector,
  _internals,
} = require("../../../utils/cryptoForecasting/microstructureCollector");
const {
  CryptoForecastStore,
} = require("../../../utils/cryptoForecasting/store");

class ConnectingSocket {
  constructor() {
    this.readyState = 0;
    this.handlers = new Map();
    this.terminate = jest.fn();
    this.close = jest.fn();
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  removeAllListeners() {
    this.handlers.clear();
  }
}

describe("BinanceMicrostructureCollector", () => {
  let root;
  let store;
  let now;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-micro-"));
    now = 1_800_000_000_000;
    store = new CryptoForecastStore({ root, now: () => now });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("aggregates taker flow and one-second order book samples by minute", () => {
    const collector = new BinanceMicrostructureCollector({
      store,
      root,
      symbols: ["BTC"],
      now: () => now,
      archive: { record: jest.fn(), prune: () => 0 },
    });
    const state = collector.states.get("BTC");
    state.book.synchronized = true;
    state.book.lastUpdateId = 10;
    state.book.bids = new Map([
      [99.9, 3],
      [99.8, 4],
    ]);
    state.book.asks = new Map([
      [100.1, 2],
      [100.2, 5],
    ]);
    collector.handleTrade(state, { p: "100", q: "2", m: false }, now);
    collector.handleTrade(state, { p: "100", q: "1", m: true }, now);
    collector.sampleBook(state, { b: "99.9", B: "3", a: "100.1", A: "2" }, now);
    now = state.bucket.minuteMs + 60_001;
    collector.rollMinute(state, now);
    const [row] = store.microstructureMinutes({
      symbol: "BTC",
      sinceMs: 0,
    });
    expect(row).toMatchObject({
      takerBuyQuote: 200,
      takerSellQuote: 100,
      tradeCount: 2,
      cumulativeVolumeDelta: 100,
      gapCount: 0,
      resyncCount: 0,
    });
    expect(row.spreadBpsMean).toBeCloseTo(20, 5);
    expect(row.depth["25bps"]).toMatchObject({
      bid: expect.any(Number),
      ask: expect.any(Number),
      imbalance: expect.any(Number),
    });
    expect(store.microstructureCoverage()[0]).toMatchObject({
      symbol: "BTC",
      modelInputEligible: false,
      role: "supporting_only",
    });
  });

  it("rejects a depth sequence gap and requests a fresh snapshot", () => {
    const archive = { record: jest.fn(), prune: () => 0 };
    const collector = new BinanceMicrostructureCollector({
      store,
      root,
      symbols: ["BTC"],
      now: () => now,
      archive,
    });
    const state = collector.states.get("BTC");
    state.book.synchronized = true;
    state.book.lastUpdateId = 100;
    collector.resync = jest.fn();
    collector.handleDepth(state, { U: 102, u: 104, b: [], a: [] }, now);
    expect(state.book.synchronized).toBe(false);
    expect(state.bucket.gapCount).toBe(1);
    expect(archive.record).toHaveBeenCalledWith(
      "BTC",
      "depth_sequence_gap",
      expect.objectContaining({ expected: 101, first: 102, final: 104 })
    );
    expect(collector.resync).toHaveBeenCalledWith("BTC", "sequence_gap");
  });

  it("rebuilds a buffered depth stream from the REST update id", async () => {
    const collector = new BinanceMicrostructureCollector({
      store,
      root,
      symbols: ["BTC"],
      now: () => now,
      archive: { record: jest.fn(), prune: () => 0 },
      fetchImpl: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          lastUpdateId: 100,
          bids: [["99", "2"]],
          asks: [["101", "3"]],
        }),
      }),
    });
    collector.running = true;
    const state = collector.states.get("BTC");
    state.book.buffered = [
      { U: 101, u: 101, b: [["99", "4"]], a: [["101", "0"]] },
    ];
    await collector.resync("BTC", "sequence_gap");
    expect(state.book).toMatchObject({
      synchronized: true,
      lastUpdateId: 101,
    });
    expect(state.book.bids.get(99)).toBe(4);
    expect(state.book.asks.has(101)).toBe(false);
    expect(state.bucket.resyncCount).toBe(1);
  });

  it("bounds anomaly files and removes expired windows", () => {
    const archive = new AnomalyArchive({
      root,
      now: () => now,
      maxBytes: 120,
      retentionMs: 1_000,
    });
    archive.record("BTC", "gap", { value: "x".repeat(200) });
    expect(archive.prune()).toBeLessThanOrEqual(120);
    now += 2_000;
    expect(archive.prune()).toBe(0);
  });

  it("computes stable depth imbalance and percentile values", () => {
    const book = {
      bids: new Map([[99, 2]]),
      asks: new Map([[101, 1]]),
    };
    expect(_internals.depthAt(book, 100, 200)).toMatchObject({
      bid: 198,
      ask: 101,
      imbalance: expect.closeTo((198 - 101) / 299, 8),
    });
    expect(_internals.percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
  });

  it("terminates a WebSocket that is still connecting during shutdown", () => {
    const collector = new BinanceMicrostructureCollector({
      store,
      root,
      symbols: ["BTC"],
      now: () => now,
      WebSocketImpl: ConnectingSocket,
      archive: { record: jest.fn(), prune: () => 0 },
    });
    collector.start();
    const socket = collector.socket;
    expect(socket.readyState).toBe(0);
    expect(() => collector.stop()).not.toThrow();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalled();
  });
});
