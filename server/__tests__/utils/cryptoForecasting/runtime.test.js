/* eslint-env jest */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CryptoForecastingRuntime,
} = require("../../../utils/cryptoForecasting/runtime");
const {
  CryptoForecastStore,
} = require("../../../utils/cryptoForecasting/store");

function minutes(symbol, start, count) {
  return Array.from({ length: count }, (_, index) => {
    const openTimeMs = start + index * 60_000;
    return {
      symbol,
      interval: "1m",
      openTimeMs,
      closeTimeMs: openTimeMs + 59_999,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 2,
      quoteVolume: 200,
      tradeCount: 3,
      takerBuyBaseVolume: 1,
      takerBuyQuoteVolume: 100,
      source: "test",
    };
  });
}

describe("CryptoForecastingRuntime", () => {
  let root;
  let store;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "crypto-forecast-runtime-"));
    store = new CryptoForecastStore({ root });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("persists only complete five-minute aggregates and keeps model absence non-fatal", async () => {
    const now = 1_800_000_608_123;
    const fetchKlines = jest.fn(async ({ symbol, startTime }) =>
      minutes(symbol, startTime, symbol === "ETH" ? 4 : 5)
    );
    const modelRuntime = {
      load: jest.fn().mockRejectedValue(
        Object.assign(new Error("missing"), {
          code: "forecast_model_manifest_missing",
        })
      ),
      snapshot: () => ({ loaded: false }),
    };
    const runtime = new CryptoForecastingRuntime({
      root,
      store,
      modelRuntime,
      fetchKlines,
      candidateCollectors: {
        gate: async () => ({ status: "test", observations: [] }),
        coinMetrics: async () => ({ status: "test", observations: [] }),
        defiLlama: async () => ({ status: "test", observations: [] }),
      },
      now: () => now,
      env: { NODE_ENV: "production" },
    });
    jest.spyOn(store, "capacity").mockReturnValue({
      allowed: true,
      storageBytes: 1_000,
      freeBytes: 20 * 1024 ** 3,
      maxStoreBytes: 2 * 1024 ** 3,
      minFreeBytes: 12 * 1024 ** 3,
      reason: null,
    });
    runtime.running = true;
    const result = await runtime.runTick();

    expect(result).toMatchObject({
      generated: {
        generated: 0,
        error: "forecast_model_manifest_missing",
      },
      resolved: { resolved: 0 },
    });
    expect(store.bars({ symbol: "BTC", interval: "5m" })).toHaveLength(1);
    expect(store.bars({ symbol: "ETH", interval: "5m" })).toHaveLength(0);
    expect(store.bars({ symbol: "SOL", interval: "5m" })).toHaveLength(1);
    for (const call of fetchKlines.mock.calls)
      expect(call[0].startTime % 60_000).toBe(0);
    expect(runtime.lastErrorCode).toBeNull();
  });

  it("does not enable the collector by default outside production", () => {
    const runtime = new CryptoForecastingRuntime({
      root,
      store,
      env: { NODE_ENV: "test" },
    });
    expect(runtime.start()).toEqual({ started: false, reason: "disabled" });
  });

  it("starts microstructure only while the single runtime lease is owned", async () => {
    const microstructureCollector = {
      start: jest.fn(),
      stop: jest.fn(),
      snapshot: jest.fn(() => ({
        status: "warming",
        anomalyArchiveBytes: 0,
        symbols: {
          BTC: {
            freshnessMs: 1_000,
            samplingCoverage: 0.5,
          },
        },
      })),
    };
    const runtime = new CryptoForecastingRuntime({
      root,
      store,
      microstructureCollector,
      fetchKlines: async () => [],
      candidateCollectors: {
        gate: async () => ({ status: "test", observations: [] }),
        coinMetrics: async () => ({ status: "test", observations: [] }),
        defiLlama: async () => ({ status: "test", observations: [] }),
      },
      modelRuntime: {
        load: jest.fn().mockRejectedValue(
          Object.assign(new Error("missing"), {
            code: "forecast_model_manifest_missing",
          })
        ),
        snapshot: () => ({ loaded: false }),
      },
      now: () => 1_800_000_000_000,
      env: {
        NODE_ENV: "production",
        ATHENA_CRYPTO_FORECAST_MICROSTRUCTURE_ENABLED: "true",
      },
    });
    jest.spyOn(store, "capacity").mockReturnValue({
      allowed: true,
      storageBytes: 1_000,
      freeBytes: 20 * 1024 ** 3,
      maxStoreBytes: 2 * 1024 ** 3,
      minFreeBytes: 12 * 1024 ** 3,
      reason: null,
    });
    runtime.running = true;
    await runtime.runTick();
    expect(microstructureCollector.start).toHaveBeenCalledTimes(1);
    jest.spyOn(store, "acquireLease").mockReturnValue(false);
    await runtime.runTick();
    expect(microstructureCollector.stop).toHaveBeenCalledTimes(1);
  });

  it("exposes persisted minute aggregates as supporting-only evidence", () => {
    const decisionAtMs = 1_800_000_000_000;
    for (let offset = 1; offset <= 15; offset += 1)
      store.upsertMicrostructureMinute({
        symbol: "BTC",
        minuteMs: decisionAtMs - offset * 60_000,
        source: "binance",
        takerBuyQuote: 60,
        takerSellQuote: 40,
        tradeCount: 10,
        cumulativeVolumeDelta: 20,
        tradeVelocity: 10 / 60,
        depth: {
          "10bps": { bid: 100, ask: 90, imbalance: 0.05 },
          "25bps": { bid: 120, ask: 80, imbalance: 0.2 },
          "50bps": { bid: 150, ask: 140, imbalance: 0.03 },
        },
        gapCount: 0,
        resyncCount: 0,
        samplingCoverage: 1,
        availableAtMs: decisionAtMs - (offset - 1) * 60_000,
      });
    const runtime = new CryptoForecastingRuntime({
      root,
      store,
      now: () => decisionAtMs,
      env: { NODE_ENV: "test" },
    });
    const evidence = runtime.microstructureEvidence("BTC");
    expect(evidence).toMatchObject({
      status: "available",
      source: "binance_public_ws_minute_aggregation",
      role: "supporting_only",
      modelInputEligible: false,
      tradeFlow: {
        windows: {
          "5m": {
            status: "available",
            sampleCount: 5,
            takerBuyRatio: 0.6,
            cumulativeVolumeDelta: 100,
          },
          "15m": {
            status: "available",
            sampleCount: 15,
          },
        },
      },
      orderBook: {
        windows: {
          "5m": {
            depth: {
              "25bps": {
                imbalanceMedian: 0.2,
                positiveSampleRatio: 1,
              },
            },
          },
        },
      },
    });
  });

  it("clears stale model health errors after a signed model loads", async () => {
    store.setSourceHealth({
      source: "forecast_model",
      stream: "active",
      status: "unavailable",
      lastErrorCode: "forecast_model_manifest_missing",
    });
    const modelRuntime = {
      loaded: { manifest: { modelVersion: "crypto-forecast-v1-test" } },
      load: jest.fn().mockResolvedValue(true),
      snapshot: () => ({
        loaded: true,
        modelVersion: "crypto-forecast-v1-test",
        signatureValid: true,
        modelSource: "active",
        errorCode: null,
      }),
    };
    const now = 1_800_000_000_000;
    const runtime = new CryptoForecastingRuntime({
      root,
      store,
      modelRuntime,
      now: () => now,
      env: { NODE_ENV: "production" },
    });

    await expect(runtime.generatePredictions()).resolves.toEqual({
      generated: 0,
    });
    expect(store.sourceHealth()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "forecast_model",
          stream: "active",
          status: "healthy",
          lastSuccessMs: now,
          lastErrorCode: null,
          details: {
            modelVersion: "crypto-forecast-v1-test",
            signatureValid: true,
            modelSource: "active",
          },
        }),
      ])
    );
  });
});
