const path = require("node:path");
const { storagePath } = require("../environment");

const SUPPORTED_SYMBOLS = Object.freeze(["BTC", "ETH", "SOL"]);
const QUOTE = "USDT";
const HORIZONS = Object.freeze({
  "4h": {
    durationMs: 4 * 60 * 60 * 1_000,
    anchorIntervalMs: 60 * 60 * 1_000,
    cadence: "hourly",
  },
  "24h": {
    durationMs: 24 * 60 * 60 * 1_000,
    anchorIntervalMs: 60 * 60 * 1_000,
    cadence: "hourly",
  },
  "4d": {
    durationMs: 4 * 24 * 60 * 60 * 1_000,
    anchorIntervalMs: 24 * 60 * 60 * 1_000,
    cadence: "daily",
  },
  "12d": {
    durationMs: 12 * 24 * 60 * 60 * 1_000,
    anchorIntervalMs: 24 * 60 * 60 * 1_000,
    cadence: "daily",
  },
  "24d": {
    durationMs: 24 * 24 * 60 * 60 * 1_000,
    anchorIntervalMs: 24 * 60 * 60 * 1_000,
    cadence: "daily",
  },
});

const MODEL_SCHEMA = "athena.crypto.forecast-model";
const MODEL_SCHEMA_VERSION = "1.0";
const FEATURE_SCHEMA_VERSION = "crypto-forecast-features-v1";
const FEATURE_SCHEMA_VERSION_V3 = "crypto-forecast-features-v3";
const FEATURE_SCHEMA_VERSION_V4 = "crypto-forecast-features-v4";
const FEATURE_SCHEMA_VERSION_V5 = "crypto-forecast-features-v5";
const FEATURE_REGISTRY_VERSION = "crypto-forecast-features-v2";
const FEATURE_REGISTRY_VERSION_V3 = "crypto-forecast-features-v3";
const FEATURE_REGISTRY_VERSION_V4 = "crypto-forecast-features-v4";
const FEATURE_REGISTRY_VERSION_V5 = "crypto-forecast-features-v5";
const OPTIMIZED_HORIZONS_V3 = Object.freeze(["4h", "24h"]);
const DEFAULT_MODEL_VERSION = "crypto-forecast-v1";
const MAX_STORE_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_FREE_BYTES = 12 * 1024 * 1024 * 1024;
const ONE_MINUTE_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const PAPER_NOTIONAL_USDT = 100;
const FEE_BPS_PER_SIDE = 10;
const SLIPPAGE_BPS_PER_SIDE = 2;
const ROUND_TRIP_COST_RATIO =
  ((FEE_BPS_PER_SIDE + SLIPPAGE_BPS_PER_SIDE) * 2) / 10_000;

function forecastingRoot(env = process.env) {
  const configured = String(
    env.ATHENA_CRYPTO_FORECASTING_STORAGE_DIR || ""
  ).trim();
  return configured
    ? path.resolve(configured)
    : storagePath("crypto-forecasting");
}

module.exports = {
  DEFAULT_MODEL_VERSION,
  FEATURE_REGISTRY_VERSION,
  FEATURE_REGISTRY_VERSION_V3,
  FEATURE_REGISTRY_VERSION_V4,
  FEATURE_REGISTRY_VERSION_V5,
  FEATURE_SCHEMA_VERSION,
  FEATURE_SCHEMA_VERSION_V3,
  FEATURE_SCHEMA_VERSION_V4,
  FEATURE_SCHEMA_VERSION_V5,
  FEE_BPS_PER_SIDE,
  HORIZONS,
  MAX_STORE_BYTES,
  MIN_FREE_BYTES,
  MODEL_SCHEMA,
  MODEL_SCHEMA_VERSION,
  ONE_MINUTE_RETENTION_MS,
  OPTIMIZED_HORIZONS_V3,
  PAPER_NOTIONAL_USDT,
  QUOTE,
  ROUND_TRIP_COST_RATIO,
  SLIPPAGE_BPS_PER_SIDE,
  SUPPORTED_SYMBOLS,
  forecastingRoot,
};
