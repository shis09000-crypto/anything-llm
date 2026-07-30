const crypto = require("node:crypto");
const registry = require("./contracts/feature-registry-v2.json");
const registryV3 = require("./contracts/feature-registry-v3.json");
const registryV4Source = require("./contracts/feature-registry-v4.json");
const registryV5Source = require("./contracts/feature-registry-v5.json");
const {
  FEE_BPS_PER_SIDE,
  PAPER_NOTIONAL_USDT,
  SLIPPAGE_BPS_PER_SIDE,
} = require("./constants");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validateFeatureRegistry(value = registry) {
  const errors = [];
  if (value?.schema !== "athena.crypto.feature-registry")
    errors.push("invalid_registry_schema");
  if (!["2.0", "3.0", "4.0", "5.0"].includes(value?.schemaVersion))
    errors.push("invalid_registry_schema_version");
  if (value?.schemaVersion === "2.0") {
    if (!Array.isArray(value?.features) || value.features.length !== 39)
      errors.push("invalid_registry_feature_count");
    const names = (value?.features || []).map((feature) => feature?.name);
    if (new Set(names).size !== names.length)
      errors.push("duplicate_registry_feature");
    for (const feature of value?.features || []) {
      if (
        !feature?.name ||
        !["model_input", "supporting_only", "retired"].includes(feature.status)
      )
        errors.push(`invalid_registry_feature:${feature?.name || "unknown"}`);
    }
  } else if (["3.0", "4.0", "5.0"].includes(value?.schemaVersion)) {
    const definitions = value?.featureDefinitions || {};
    const horizons = value?.horizons || {};
    for (const horizon of ["4h", "24h"]) {
      const names =
        horizons[horizon]?.features || horizons[horizon]?.candidateFeatures;
      if (!Array.isArray(names) || !names.length)
        errors.push(`invalid_registry_horizon:${horizon}`);
      else if (new Set(names).size !== names.length)
        errors.push(`duplicate_registry_feature:${horizon}`);
      for (const name of names || []) {
        const definition = definitions[name];
        if (
          !definition ||
          !definition.family ||
          !Array.isArray(definition.dependencies) ||
          !Array.isArray(definition.range)
        )
          errors.push(`invalid_registry_feature:${horizon}:${name}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function resolveV4Registry(source = registryV4Source) {
  if (source?.inheritsRegistryVersion !== registryV3.registryVersion)
    throw new Error("feature_registry_v4_parent_mismatch");
  const featureDefinitions = { ...registryV3.featureDefinitions };
  for (const [name, definition] of Object.entries(
    source.supportingFeatures || {}
  ))
    featureDefinitions[name] = {
      family: definition.family,
      lookbackBars: 0,
      dependencies: definition.sources || [],
      nullPolicy: "unavailable_with_explicit_mask",
      range: [-1e12, 1e12],
      role: "supporting_only",
      ...definition,
    };
  return {
    ...source,
    inheritsRegistrySha256: sha256(canonicalJson(registryV3)),
    horizons: Object.fromEntries(
      Object.entries(source.horizons || {}).map(([horizon, entry]) => [
        horizon,
        {
          ...entry,
          features: [...(entry.candidateFeatures || [])],
        },
      ])
    ),
    featureDefinitions,
  };
}

function resolveV5Registry(source = registryV5Source) {
  const parent = resolveV4Registry();
  if (source?.inheritsRegistryVersion !== parent.registryVersion)
    throw new Error("feature_registry_v5_parent_mismatch");
  const horizons = {};
  for (const horizon of ["4h", "24h"]) {
    const inherited = parent.horizons[horizon];
    const override = source.horizons?.[horizon] || {};
    horizons[horizon] = {
      ...inherited,
      ...override,
      features: [...inherited.features],
      candidateFeatures: [...inherited.features],
    };
  }
  return {
    ...parent,
    ...source,
    inheritsRegistrySha256: sha256(canonicalJson(parent)),
    horizons,
    featureDefinitions: { ...parent.featureDefinitions },
    supportingFeatures: { ...parent.supportingFeatures },
  };
}

const validation = validateFeatureRegistry();
if (!validation.valid)
  throw new Error(`feature_registry_invalid:${validation.errors.join(",")}`);

const FEATURE_REGISTRY = Object.freeze(registry);
const FEATURE_REGISTRY_SHA256 = sha256(canonicalJson(FEATURE_REGISTRY));
const FEATURE_NAMES = Object.freeze(
  FEATURE_REGISTRY.features
    .filter((feature) => feature.status === "model_input")
    .map((feature) => feature.name)
);
const FEATURE_REGISTRY_V3 = Object.freeze(registryV3);
const FEATURE_REGISTRY_V3_SHA256 = sha256(canonicalJson(FEATURE_REGISTRY_V3));
const HORIZON_FEATURE_NAMES_V3 = Object.freeze(
  Object.fromEntries(
    Object.entries(FEATURE_REGISTRY_V3.horizons).map(([horizon, entry]) => [
      horizon,
      Object.freeze([...entry.features]),
    ])
  )
);
const FEATURE_FAMILIES_V3 = Object.freeze(
  Object.fromEntries(
    Object.entries(FEATURE_REGISTRY_V3.featureDefinitions).map(
      ([name, definition]) => [name, definition.family]
    )
  )
);
const FEATURE_REGISTRY_V4 = Object.freeze(resolveV4Registry());
const FEATURE_REGISTRY_V4_SHA256 = sha256(canonicalJson(FEATURE_REGISTRY_V4));
const HORIZON_FEATURE_NAMES_V4 = Object.freeze(
  Object.fromEntries(
    Object.entries(FEATURE_REGISTRY_V4.horizons).map(([horizon, entry]) => [
      horizon,
      Object.freeze([...entry.features]),
    ])
  )
);
const FEATURE_FAMILIES_V4 = Object.freeze(
  Object.fromEntries(
    Object.entries(FEATURE_REGISTRY_V4.featureDefinitions).map(
      ([name, definition]) => [name, definition.family]
    )
  )
);
const FEATURE_REGISTRY_V5 = Object.freeze(resolveV5Registry());
const FEATURE_REGISTRY_V5_SHA256 = sha256(canonicalJson(FEATURE_REGISTRY_V5));
const HORIZON_FEATURE_NAMES_V5 = Object.freeze(
  Object.fromEntries(
    Object.entries(FEATURE_REGISTRY_V5.horizons).map(([horizon, entry]) => [
      horizon,
      Object.freeze([...entry.features]),
    ])
  )
);
const FEATURE_FAMILIES_V5 = Object.freeze(
  Object.fromEntries(
    Object.entries(FEATURE_REGISTRY_V5.featureDefinitions).map(
      ([name, definition]) => [name, definition.family]
    )
  )
);

const v3Validation = validateFeatureRegistry(FEATURE_REGISTRY_V3);
if (!v3Validation.valid)
  throw new Error(
    `feature_registry_v3_invalid:${v3Validation.errors.join(",")}`
  );
const v4Validation = validateFeatureRegistry(FEATURE_REGISTRY_V4);
if (!v4Validation.valid)
  throw new Error(
    `feature_registry_v4_invalid:${v4Validation.errors.join(",")}`
  );
const v5Validation = validateFeatureRegistry(FEATURE_REGISTRY_V5);
if (!v5Validation.valid)
  throw new Error(
    `feature_registry_v5_invalid:${v5Validation.errors.join(",")}`
  );

const COST_MODEL = Object.freeze({
  schema: "athena.crypto.cost-model",
  schemaVersion: "1.0",
  costModelVersion: "crypto-cost-model-v1",
  quote: "USDT",
  notionalUsdt: PAPER_NOTIONAL_USDT,
  leverage: 1,
  feeBpsPerSide: FEE_BPS_PER_SIDE,
  slippageBpsPerSide: SLIPPAGE_BPS_PER_SIDE,
  funding: "observed_gate_usdt_perpetual_when_available",
  fillModel: "next_tradeable_5m_open_no_partial_fills",
});
const COST_MODEL_SHA256 = sha256(canonicalJson(COST_MODEL));
const COST_MODEL_V3 = Object.freeze({
  schema: "athena.crypto.cost-model",
  schemaVersion: "2.0",
  costModelVersion: "crypto-cost-model-v3",
  quote: "USDT",
  notionalUsdt: PAPER_NOTIONAL_USDT,
  leverage: 1,
  longExecution: {
    market: "binance_spot",
    entry: "next_tradeable_5m_open",
    exit: "horizon_close",
  },
  shortExecution: {
    market: "binance_usdm_perpetual",
    entry: "next_tradeable_5m_open",
    exit: "horizon_mark_close",
    funding: "observed_binance_funding_events",
  },
  feeBpsPerSide: FEE_BPS_PER_SIDE,
  slippageBpsPerSide: SLIPPAGE_BPS_PER_SIDE,
  fillModel: "next_tradeable_bar_open_no_partial_fills",
});
const COST_MODEL_V3_SHA256 = sha256(canonicalJson(COST_MODEL_V3));
const COST_MODEL_V5 = Object.freeze({
  schema: "athena.crypto.cost-model",
  schemaVersion: "3.0",
  costModelVersion: "crypto-cost-model-v5",
  quote: "USDT",
  notionalUsdt: PAPER_NOTIONAL_USDT,
  leverage: 1,
  longExecution: {
    market: "binance_spot",
    entry: "next_tradeable_5m_open",
    exit: "first_touch_or_4h_timeout",
  },
  shortExecution: {
    market: "binance_usdm_perpetual",
    entry: "next_tradeable_5m_open",
    exit: "first_touch_or_4h_timeout",
    funding: "observed_binance_funding_events",
  },
  feeBpsPerSide: FEE_BPS_PER_SIDE,
  labelSlippageBpsPerSide: 5,
  safetyBufferBps: 5,
  auditSlippageGridBpsPerSide: [2, 5, 10, 20],
  fillModel: "first_touch_5m_no_partial_fills_same_bar_ambiguous",
});
const COST_MODEL_V5_SHA256 = sha256(canonicalJson(COST_MODEL_V5));

module.exports = {
  COST_MODEL,
  COST_MODEL_SHA256,
  COST_MODEL_V3,
  COST_MODEL_V3_SHA256,
  COST_MODEL_V5,
  COST_MODEL_V5_SHA256,
  FEATURE_FAMILIES_V3,
  FEATURE_FAMILIES_V4,
  FEATURE_FAMILIES_V5,
  FEATURE_NAMES,
  FEATURE_REGISTRY,
  FEATURE_REGISTRY_SHA256,
  FEATURE_REGISTRY_V3,
  FEATURE_REGISTRY_V3_SHA256,
  FEATURE_REGISTRY_V4,
  FEATURE_REGISTRY_V4_SHA256,
  FEATURE_REGISTRY_V5,
  FEATURE_REGISTRY_V5_SHA256,
  HORIZON_FEATURE_NAMES_V3,
  HORIZON_FEATURE_NAMES_V4,
  HORIZON_FEATURE_NAMES_V5,
  canonicalJson,
  sha256,
  resolveV4Registry,
  resolveV5Registry,
  validateFeatureRegistry,
};
