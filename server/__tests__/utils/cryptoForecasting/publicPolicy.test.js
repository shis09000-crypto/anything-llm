/* eslint-env jest */

const {
  PUBLIC_FORECAST_POLICY,
  monitoringOnlyForecastingView,
  monitoringOnlyPredictionDetails,
} = require("../../../utils/cryptoForecasting/publicPolicy");

describe("crypto forecasting public monitoring policy", () => {
  it("removes directional results while retaining provenance and monitoring data", () => {
    const result = monitoringOnlyForecastingView({
      status: "active",
      modelVersion: "research-model",
      datasetManifestSha256: "a".repeat(64),
      horizons: {
        "4h": {
          status: "active",
          probabilities: { up: 0.7, range: 0.1, down: 0.2 },
          candidateState: "up",
          predictedState: "up",
          actionProbability: 0.9,
          tradeabilityProbability: 0.8,
          conditionalDirectionProbability: { up: 0.8, down: 0.2 },
          returnQuantiles: { q10: -0.01, q50: 0.02, q90: 0.05 },
          drivers: [{ featurePath: "volume.ratio", direction: "supports" }],
          futureVolatility: { status: "active", p50: 0.03 },
          currentRegime: "trend",
          evidenceCoverage: 0.98,
          dataFreshnessMs: 500,
          abstained: false,
          abstainReasons: [],
        },
      },
    });

    expect(result.analysisPolicy).toBe(PUBLIC_FORECAST_POLICY);
    expect(result.horizons["4h"]).toMatchObject({
      status: "active",
      publicMode: "monitoring_only",
      abstained: true,
      abstainReasons: ["monitoring_only_policy"],
      evidenceCoverage: 0.98,
    });
    for (const field of [
      "probabilities",
      "candidateState",
      "predictedState",
      "actionProbability",
      "tradeabilityProbability",
      "conditionalDirectionProbability",
      "returnQuantiles",
      "drivers",
      "futureVolatility",
      "currentRegime",
    ])
      expect(result.horizons["4h"]).not.toHaveProperty(field);
  });

  it("redacts directional fields from prediction passports without deleting audit hashes", () => {
    const result = monitoringOnlyPredictionDetails({
      predictionId: "p1",
      status: "shadow",
      payload: {
        probabilities: { up: 0.6, range: 0.2, down: 0.2 },
        candidateState: "up",
        predictedState: null,
        modelArtifactSha256: "b".repeat(64),
        abstainReasons: ["model_shadow"],
        passport: {
          modelArtifactSha256: "b".repeat(64),
          probabilities: { up: 0.6, range: 0.2, down: 0.2 },
          featureSnapshotSha256: "c".repeat(64),
        },
      },
      passport: {
        probabilities: { up: 0.6, range: 0.2, down: 0.2 },
        featureSnapshot: {
          snapshotSha256: "c".repeat(64),
          values: { volumeRatio: 1.3 },
        },
      },
    });

    expect(result).toMatchObject({
      predictionId: "p1",
      publicMode: "monitoring_only",
      payload: {
        publicMode: "monitoring_only",
        abstained: true,
        abstainReasons: ["monitoring_only_policy", "model_shadow"],
        modelArtifactSha256: "b".repeat(64),
        passport: {
          modelArtifactSha256: "b".repeat(64),
          featureSnapshotSha256: "c".repeat(64),
        },
      },
      passport: {
        featureSnapshot: {
          snapshotSha256: "c".repeat(64),
          values: { volumeRatio: 1.3 },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('"probabilities"');
    expect(JSON.stringify(result)).not.toContain('"candidateState"');
  });
});
