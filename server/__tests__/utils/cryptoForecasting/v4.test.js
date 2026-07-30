/* eslint-env jest */

const {
  FEATURE_REGISTRY_V4,
  FEATURE_REGISTRY_V4_SHA256,
  HORIZON_FEATURE_NAMES_V4,
  canonicalJson,
  sha256,
  validateFeatureRegistry,
} = require("../../../utils/cryptoForecasting/contracts");
const {
  buildFeatureVectorV4,
} = require("../../../utils/cryptoForecasting/features");
const {
  ForecastModelRuntime,
  _internals,
} = require("../../../utils/cryptoForecasting/modelRuntime");

function bars(symbol, multiplier, count = 30 * 24 * 12 + 1_000) {
  const start = 1_700_000_000_000;
  return Array.from({ length: count }, (_, index) => {
    const close =
      100 * multiplier +
      index * 0.002 * multiplier +
      Math.sin(index / (17 + multiplier)) * multiplier;
    const volume = 10 + (index % (17 + multiplier));
    return {
      symbol,
      interval: "5m",
      openTimeMs: start + index * 300_000,
      closeTimeMs: start + (index + 1) * 300_000 - 1,
      open: close - 0.05,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume,
      quoteVolume: volume * close,
      tradeCount: 100 + (index % 41),
      takerBuyBaseVolume: volume * 0.48,
      takerBuyQuoteVolume: volume * close * 0.48,
      source: "test",
      availableAtMs: start + (index + 1) * 300_000,
      availabilityEstimated: false,
    };
  });
}

describe("crypto forecasting v4 contracts", () => {
  it("resolves one canonical inherited registry with independent horizons", () => {
    expect(validateFeatureRegistry(FEATURE_REGISTRY_V4)).toEqual({
      valid: true,
      errors: [],
    });
    expect(FEATURE_REGISTRY_V4_SHA256).toBe(
      sha256(canonicalJson(FEATURE_REGISTRY_V4))
    );
    expect(HORIZON_FEATURE_NAMES_V4["4h"]).not.toEqual(
      HORIZON_FEATURE_NAMES_V4["24h"]
    );
    expect(FEATURE_REGISTRY_V4.selectionContract).toMatchObject({
      maximumModelInputsPerHead: 20,
      minimumFoldSelectionRatio: 0.7,
    });
    expect(
      FEATURE_REGISTRY_V4.horizons["4h"].headRequiredFeatures
        .futureVolatility
    ).toEqual(
      expect.arrayContaining(["realized_vol_4h", "normalized_atr_4h"])
    );
    expect(FEATURE_REGISTRY_V4.supportingFeatures.mvrv).toMatchObject({
      availability: "organic_only",
      symbols: ["BTC", "ETH"],
    });
  });

  it("builds the same finite v4 candidate vector under the availability boundary", () => {
    const marketBarsBySymbol = {
      BTC: bars("BTC", 1),
      ETH: bars("ETH", 2),
      SOL: bars("SOL", 3),
    };
    const source = marketBarsBySymbol.BTC;
    const result = buildFeatureVectorV4({
      horizon: "4h",
      symbol: "BTC",
      bars: source,
      marketBarsBySymbol,
      asOfMs: source.at(-1).closeTimeMs,
      decisionAtMs: source.at(-1).availableAtMs,
      featureNames: HORIZON_FEATURE_NAMES_V4["4h"].slice(0, 20),
    });
    expect(result.featureSchemaVersion).toBe("crypto-forecast-features-v4");
    expect(result.featureRegistrySha256).toBe(FEATURE_REGISTRY_V4_SHA256);
    expect(result.vector).toHaveLength(20);
    expect(result.vector.every(Number.isFinite)).toBe(true);
  });

  it("runs learned state, volatility quantiles and tail risk as direction-independent heads", async () => {
    const runtime = new ForecastModelRuntime({
      root: "/tmp/not-used",
      env: { NODE_ENV: "test" },
    });
    runtime.loaded = {
      manifest: {
        horizons: {
          "4h": {
            predictionHeads: {
              marketState: {
                artifact: "state.onnx",
                classOrder: ["trend", "range", "stress"],
                calibration: { scale: [1, 1, 1], bias: [0, 0, 0] },
              },
              futureVolatility: {
                artifacts: {
                  p50: { artifact: "p50.onnx" },
                  p90: { artifact: "p90.onnx" },
                },
                blend: {
                  modelWeight: 0.25,
                  baselineFeature: "realized_vol_24h",
                },
              },
              tailRisk: {
                artifact: "tail.onnx",
                calibration: { scale: 1, bias: 0 },
              },
            },
          },
        },
      },
    };
    runtime.optionalHeadProbability = jest
      .fn()
      .mockResolvedValueOnce([0.2, 0.3, 0.5])
      .mockResolvedValueOnce(0.7);
    runtime.scalarHead = jest
      .fn()
      .mockResolvedValueOnce(0.04)
      .mockResolvedValueOnce(0.08);
    await expect(
      runtime.predictionHeads("4h", [0], { realized_vol_24h: 0.02 })
    ).resolves.toMatchObject({
      marketState: {
        state: "stress",
        probabilities: {
          trend: expect.closeTo(0.2, 8),
          range: expect.closeTo(0.3, 8),
          stress: expect.closeTo(0.5, 8),
        },
      },
      futureVolatility: {
        p50: 0.025,
        p90: 0.08,
      },
      tailRisk: {
        probability: expect.closeTo(0.7, 8),
      },
    });
    expect(_internals.optionalHeadArtifacts({
      predictionHeads: runtime.loaded.manifest.horizons["4h"].predictionHeads,
    })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "marketState", outputKind: "multiclass" }),
        expect.objectContaining({ key: "tailRisk", outputKind: "binary" }),
      ])
    );
  });
});
