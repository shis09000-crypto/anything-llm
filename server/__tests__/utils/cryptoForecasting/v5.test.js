/* eslint-env jest */

const {
  FEATURE_REGISTRY_V5,
  FEATURE_REGISTRY_V5_SHA256,
  HORIZON_FEATURE_NAMES_V5,
  canonicalJson,
  sha256,
  validateFeatureRegistry,
} = require("../../../utils/cryptoForecasting/contracts");
const {
  costFirstTouchBarrierRatio,
} = require("../../../utils/cryptoForecasting/features");
const {
  ForecastModelRuntime,
} = require("../../../utils/cryptoForecasting/modelRuntime");

describe("crypto forecasting v5 contracts", () => {
  it("publishes the canonical cost-aware two-layer contract", () => {
    expect(validateFeatureRegistry(FEATURE_REGISTRY_V5)).toEqual({
      valid: true,
      errors: [],
    });
    expect(FEATURE_REGISTRY_V5_SHA256).toBe(
      sha256(canonicalJson(FEATURE_REGISTRY_V5))
    );
    expect(FEATURE_REGISTRY_V5.labelContract).toMatchObject({
      version: "cost-first-touch-v5",
      sameBarDoubleTouch: "ambiguous_abstain",
      minimumActionShare: 0.15,
      minimumNoTradeShare: 0.15,
    });
    expect(FEATURE_REGISTRY_V5.selectionContract).toMatchObject({
      maximumSideInputs: 16,
      maximumMetaInputs: 8,
    });
  });

  it("combines calibrated tradeability and conditional side probabilities", async () => {
    const runtime = new ForecastModelRuntime({
      root: "/tmp/not-used",
      env: { NODE_ENV: "test" },
    });
    runtime.loaded = {
      manifest: {
        horizons: {
          "4h": {
            featureNames: HORIZON_FEATURE_NAMES_V5["4h"].slice(0, 4),
            decisionLayers: {
              side: { calibration: { scale: 1, bias: 0 } },
              tradeabilityMeta: {
                inputFeatureNames: [
                  "side_up_probability",
                  "future_volatility_p50",
                  "tail_risk_probability",
                  "stress_probability",
                ],
                calibration: { scale: 1, bias: 0 },
              },
            },
          },
        },
      },
    };
    runtime.binaryLayerProbability = jest
      .fn()
      .mockResolvedValueOnce(0.7)
      .mockResolvedValueOnce(0.6);
    runtime.predictionHeads = jest.fn().mockResolvedValue({
      futureVolatility: { p50: 0.03 },
      tailRisk: { probability: 0.2 },
      marketState: { probabilities: { stress: 0.1 } },
    });
    const details = await runtime.probabilityDetails("4h", [1, 2, 3, 4], {
      values: {},
    });
    expect(details).toMatchObject({
      decisionLayer: "net_opportunity_then_side_v5",
      actionProbability: expect.closeTo(0.6, 8),
      tradeabilityProbability: expect.closeTo(0.6, 8),
      conditionalSideProbability: {
        down: expect.closeTo(0.3, 8),
        up: expect.closeTo(0.7, 8),
      },
    });
    expect(details.probabilities).toEqual([
      expect.closeTo(0.18, 8),
      expect.closeTo(0.4, 8),
      expect.closeTo(0.42, 8),
    ]);
    expect(details.metaVector).toEqual([0.7, 0.03, 0.2, 0.1]);
  });

  it("never places a barrier below cost plus the safety buffer", () => {
    const bars = Array.from({ length: 400 }, (_, index) => ({
      close: 100 + Math.sin(index / 10) * 0.01,
    }));
    expect(
      costFirstTouchBarrierRatio(bars, 0.5, {
        horizonDurationMs: 4 * 60 * 60 * 1_000,
        feeBpsPerSide: 10,
        slippageBpsPerSide: 5,
        safetyBufferBps: 5,
      })
    ).toBeCloseTo(0.0035, 10);
  });
});
