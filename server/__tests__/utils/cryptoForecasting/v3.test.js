/* eslint-env jest */

const {
  FEATURE_REGISTRY_V3,
  FEATURE_REGISTRY_V3_SHA256,
  HORIZON_FEATURE_NAMES_V3,
  canonicalJson,
  sha256,
  validateFeatureRegistry,
} = require("../../../utils/cryptoForecasting/contracts");
const {
  MIN_BARS,
  buildFeatureVectorV3,
} = require("../../../utils/cryptoForecasting/features");
const {
  ForecastModelRuntime,
  _internals,
} = require("../../../utils/cryptoForecasting/modelRuntime");

function bars(symbol, multiplier, count = MIN_BARS + 1_000) {
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
      takerBuyBaseVolume: volume * (0.45 + (index % 7) / 100),
      takerBuyQuoteVolume: volume * close * (0.45 + (index % 7) / 100),
      source: "test",
    };
  });
}

describe("crypto forecasting v3 contracts", () => {
  it("defines independent, duplicate-free 4h and 24h feature orders", () => {
    expect(validateFeatureRegistry(FEATURE_REGISTRY_V3)).toEqual({
      valid: true,
      errors: [],
    });
    expect(FEATURE_REGISTRY_V3_SHA256).toBe(
      sha256(canonicalJson(FEATURE_REGISTRY_V3))
    );
    for (const names of Object.values(HORIZON_FEATURE_NAMES_V3)) {
      expect(new Set(names).size).toBe(names.length);
      expect(names.some((name) => name.startsWith("taker_buy_ratio"))).toBe(
        false
      );
      expect(names).toEqual(expect.arrayContaining(["asset_eth", "asset_sol"]));
      expect(names).not.toContain("asset_btc");
    }
    expect(HORIZON_FEATURE_NAMES_V3["4h"]).not.toEqual(
      HORIZON_FEATURE_NAMES_V3["24h"]
    );
  });

  it("builds finite horizon-specific vectors against an excluded-asset market basket", () => {
    const marketBarsBySymbol = {
      BTC: bars("BTC", 1),
      ETH: bars("ETH", 2),
      SOL: bars("SOL", 3),
    };
    const result = buildFeatureVectorV3({
      horizon: "4h",
      symbol: "BTC",
      bars: marketBarsBySymbol.BTC,
      marketBarsBySymbol,
      asOfMs: marketBarsBySymbol.BTC.at(-1).closeTimeMs,
    });
    expect(result.vector).toHaveLength(HORIZON_FEATURE_NAMES_V3["4h"].length);
    expect(result.vector.every(Number.isFinite)).toBe(true);
    expect(result.evidenceCoverage).toBeGreaterThanOrEqual(0.9);
    expect(result.values.market_correlation_30d).not.toBe(1);
    expect(result.values.relative_market_return_4h).not.toBe(0);
  });

  it("combines opportunity and conditional direction probabilities exactly", async () => {
    const runtime = new ForecastModelRuntime({
      root: "/tmp/not-used",
      env: { NODE_ENV: "test" },
    });
    runtime.loaded = {
      manifest: {
        horizons: {
          "4h": {
            decisionLayers: {
              opportunity: {
                calibration: { scale: 1, bias: 0 },
              },
              conditionalDirection: {
                calibration: { scale: 1, bias: 0 },
              },
            },
          },
        },
      },
    };
    runtime.binaryLayerProbability = jest
      .fn()
      .mockResolvedValueOnce(0.6)
      .mockResolvedValueOnce(0.75);
    await expect(runtime.probabilityDetails("4h", [0])).resolves.toMatchObject({
      decisionLayer: "opportunity_then_direction-v1",
      actionProbability: expect.closeTo(0.6, 8),
      probabilities: [
        expect.closeTo(0.15, 8),
        expect.closeTo(0.4, 8),
        expect.closeTo(0.45, 8),
      ],
      conditionalDirectionProbability: {
        down: expect.closeTo(0.25, 8),
        up: expect.closeTo(0.75, 8),
      },
    });
  });

  it("normalizes scalar and pair binary model outputs", () => {
    expect(
      _internals.normalizeBinaryProbability({
        data: Float32Array.from([0.25, 0.75]),
      })
    ).toBeCloseTo(0.75);
    expect(
      _internals.normalizeBinaryProbability({
        data: Float32Array.from([0]),
      })
    ).toBeCloseTo(0);
  });
});
