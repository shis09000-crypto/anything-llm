const crypto = require("node:crypto");
const { FACTOR_REGISTRY_SHA256, sha256 } = require("./contracts");

const RESEARCH_SCHEMA = "athena.gold.shadow-research";
const RESEARCH_VERSION = "gold-shadow-research-v1";
const HORIZONS = Object.freeze(["1d", "1w"]);

function buildShadowResearch({
  datasetSha256,
  timeframes,
  volatilityRisk,
  now,
}) {
  const dailyBars = Number(timeframes?.["1d"]?.closedBarsUsed || 0);
  const enoughHistory = dailyBars >= 756;
  const dataset = datasetSha256 || "unavailable";
  const researchId = crypto
    .createHash("sha256")
    .update(`${RESEARCH_VERSION}|${dataset}|${now}`)
    .digest("hex");
  const horizons = Object.fromEntries(
    HORIZONS.map((horizon) => [
      horizon,
      {
        status: "shadow",
        abstained: true,
        abstainReasons: [
          enoughHistory
            ? "signed_candidate_model_not_available"
            : "insufficient_point_in_time_history",
          "public_direction_disabled",
        ],
        heads: {
          direction: "candidate_untrained",
          returnQuantiles: "candidate_untrained",
          futureVolatility:
            volatilityRisk?.status === "complete"
              ? "har_proxy_available_for_research"
              : "insufficient",
          marketRegime: "deterministic_current_state_only",
        },
        publicFields: [
          "status",
          "abstained",
          "abstainReasons",
          "dataCoverage",
          "artifactSha256",
        ],
        dataCoverage: Math.min(1, dailyBars / 756),
        artifactSha256: null,
      },
    ])
  );
  return {
    schema: RESEARCH_SCHEMA,
    schemaVersion: "1.0",
    researchVersion: RESEARCH_VERSION,
    researchId,
    status: "shadow",
    governanceState: "candidate",
    validationProtocol: {
      walkForward: true,
      purging: true,
      embargo: true,
      regimeEvaluation: true,
      probabilityCalibration: true,
      blockBootstrap: true,
      whiteRealityCheck: true,
      spa: true,
      modelConfidenceSet: true,
      deflatedSharpe: true,
      historicalEvidenceClass: "historical_semi_blind",
    },
    allowedModels: ["har-rv", "elastic-net", "logistic", "small-xgboost"],
    prohibitedModels: ["tft", "informer", "gnn", "reinforcement-learning"],
    factorRegistrySha256: FACTOR_REGISTRY_SHA256,
    datasetSha256: dataset,
    modelSignature: {
      algorithm: "ML-DSA-65",
      status: "unavailable",
      artifactSha256: null,
    },
    horizons,
    publicPolicy: {
      exposeDirection: false,
      exposeProbabilities: false,
      exposeReturnQuantiles: false,
      exposeTargets: false,
      exposeTradeInstructions: false,
    },
    generatedAtMs: now,
    researchContractSha256: sha256({
      version: RESEARCH_VERSION,
      factorRegistrySha256: FACTOR_REGISTRY_SHA256,
      allowedModels: ["har-rv", "elastic-net", "logistic", "small-xgboost"],
      horizons: HORIZONS,
    }),
  };
}

function publicShadowResearch(value = {}) {
  return {
    status: value.status || "unavailable",
    governanceState: value.governanceState || "candidate",
    researchVersion: value.researchVersion || RESEARCH_VERSION,
    researchId: value.researchId || null,
    datasetSha256: value.datasetSha256 || null,
    factorRegistrySha256: value.factorRegistrySha256 || FACTOR_REGISTRY_SHA256,
    modelSignature: value.modelSignature || {
      algorithm: "ML-DSA-65",
      status: "unavailable",
      artifactSha256: null,
    },
    horizons: Object.fromEntries(
      Object.entries(value.horizons || {}).map(([horizon, item]) => [
        horizon,
        {
          status: item.status,
          abstained: true,
          abstainReasons: item.abstainReasons || ["public_direction_disabled"],
          dataCoverage: item.dataCoverage ?? 0,
          artifactSha256: item.artifactSha256 || null,
        },
      ])
    ),
    publicPolicy: value.publicPolicy,
  };
}

module.exports = {
  HORIZONS,
  RESEARCH_SCHEMA,
  RESEARCH_VERSION,
  buildShadowResearch,
  publicShadowResearch,
};
