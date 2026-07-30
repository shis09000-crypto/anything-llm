const PUBLIC_FORECAST_MODE = "monitoring_only";

const PUBLIC_FORECAST_POLICY = Object.freeze({
  mode: PUBLIC_FORECAST_MODE,
  directDirectionalPrediction: false,
  directionalProbabilitiesExposed: false,
  returnTargetsExposed: false,
  tradeInstructionsExposed: false,
  researchArtifactsRetained: true,
  reason: "forecast_models_not_promoted",
});

const DIRECTIONAL_PREDICTION_FIELDS = new Set([
  "actionProbability",
  "candidateState",
  "conditionalDirectionProbability",
  "conditionalSideProbability",
  "drivers",
  "executionGate",
  "predictedState",
  "probabilities",
  "returnQuantiles",
  "tradeabilityProbability",
]);

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function redactDirectionalPredictionFields(value) {
  if (Array.isArray(value))
    return value.map((item) => redactDirectionalPredictionFields(item));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !DIRECTIONAL_PREDICTION_FIELDS.has(key))
      .map(([key, entry]) => [key, redactDirectionalPredictionFields(entry)])
  );
}

function monitoringOnlyHorizonView(horizon = {}) {
  const redacted = redactDirectionalPredictionFields(horizon);
  return {
    status: redacted.status,
    publicMode: PUBLIC_FORECAST_MODE,
    abstained: true,
    abstainReasons: unique([
      "monitoring_only_policy",
      ...(horizon.abstainReasons || []),
    ]),
    evidenceCoverage: redacted.evidenceCoverage,
    dataFreshnessMs: redacted.dataFreshnessMs,
    asOf: redacted.asOf,
    outcomeDueAt: redacted.outcomeDueAt,
    predictionId: redacted.predictionId,
    passportRef: redacted.passportRef,
    governanceState: redacted.governanceState,
    costModelVersion: redacted.costModelVersion,
    modelArtifactSha256: redacted.modelArtifactSha256,
    resolved: redacted.resolved,
  };
}

function monitoringOnlyForecastingView(forecasting = {}) {
  return {
    status: forecasting.status,
    publicMode: PUBLIC_FORECAST_MODE,
    analysisPolicy: PUBLIC_FORECAST_POLICY,
    modelVersion: forecasting.modelVersion,
    featureSchemaVersion: forecasting.featureSchemaVersion,
    asOf: forecasting.asOf,
    datasetManifestSha256: forecasting.datasetManifestSha256,
    modelArtifactSha256: forecasting.modelArtifactSha256,
    reason: forecasting.reason,
    horizons: Object.fromEntries(
      Object.entries(forecasting.horizons || {}).map(([horizon, value]) => [
        horizon,
        monitoringOnlyHorizonView({
          status: value?.status || forecasting.status,
          ...(value || {}),
        }),
      ])
    ),
  };
}

function monitoringOnlyPredictionDetails(result) {
  if (!result) return null;
  const redacted = redactDirectionalPredictionFields(result);
  return {
    ...redacted,
    publicMode: PUBLIC_FORECAST_MODE,
    analysisPolicy: PUBLIC_FORECAST_POLICY,
    payload: redacted.payload
      ? {
          ...redacted.payload,
          publicMode: PUBLIC_FORECAST_MODE,
          analysisPolicy: PUBLIC_FORECAST_POLICY,
          abstained: true,
          abstainReasons: unique([
            "monitoring_only_policy",
            ...(result.payload?.abstainReasons || []),
          ]),
        }
      : redacted.payload,
  };
}

module.exports = {
  PUBLIC_FORECAST_MODE,
  PUBLIC_FORECAST_POLICY,
  monitoringOnlyForecastingView,
  monitoringOnlyHorizonView,
  monitoringOnlyPredictionDetails,
  redactDirectionalPredictionFields,
};
