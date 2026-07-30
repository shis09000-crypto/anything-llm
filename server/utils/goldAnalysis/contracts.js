const crypto = require("node:crypto");
const rawFactorRegistry = require("./contracts/factor-registry-v1.json");

function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}

const FORMULAS = Object.freeze({
  return: "ln(close_t / close_t_minus_1)",
  momentum_5: "ln(close_t / close_t_minus_5)",
  momentum_20: "ln(close_t / close_t_minus_20)",
  sma_gap_20: "close_t / SMA(close,20) - 1",
  ema_12_26: "EMA(close,12) and EMA(close,26), alpha=2/(n+1)",
  rsi_14: "Wilder RSI(close,14)",
  macd_histogram: "EMA12 - EMA26 - EMA(EMA12 - EMA26,9)",
  donchian_breakout_20:
    "close position versus prior 20 closed-bar high and low",
  atr_14: "Wilder mean true_range,14",
  adx_14: "Wilder ADX and directional movement,14",
  bollinger_20_2:
    "SMA(close,20) plus or minus 2 population standard deviations",
  realized_variance: "sum(hourly_log_return_squared) by UTC day",
  har_week: "mean(daily_realized_variance,5)",
  har_month: "mean(daily_realized_variance,22)",
  downside_semivariance: "sum(min(hourly_log_return,0)^2) by UTC day",
  bipower_variation: "pi/2 * sum(abs(return_t) * abs(return_t_minus_1))",
  jump_intensity: "max(realized_variance - bipower_variation,0)",
  parkinson_volatility:
    "sqrt(mean(ln(high/low)^2) / (4*ln(2))) over 20 closed bars",
  managed_money_net: "(managed_long - managed_short) / open_interest",
  commercial_net: "(producer_long - producer_short) / open_interest",
  managed_money_long_ratio: "managed_long / open_interest",
  managed_money_short_ratio: "managed_short / open_interest",
  spreading_ratio: "managed_spreading / open_interest",
  cot_crowding_z:
    "zscore(managed_money_net_ratio, trailing_156_released_reports)",
  gld_tonnes_change: "current_issuer_tonnes - prior_received_issuer_tonnes",
  iau_holdings_change: "current_issuer_tonnes - prior_received_issuer_tonnes",
  etf_premium_discount: "(market_price - NAV) / NAV",
  shanghai_international_premium:
    "(SGE_CNY_per_gram * 31.1034768 / USD_CNY) / XAU_USD - 1",
  gold_silver_ratio: "XAU_USD_closed / XAG_USD_closed",
});

const DELAY_BY_FREQUENCY = Object.freeze({
  tick: 5 * 60 * 1_000,
  volume_clock: 5 * 60 * 1_000,
  intraday: 60 * 60 * 1_000,
  multi: 36 * 60 * 60 * 1_000,
  session: 36 * 60 * 60 * 1_000,
  daily: 48 * 60 * 60 * 1_000,
  daily_or_weekly: 8 * 24 * 60 * 60 * 1_000,
  daily_or_monthly: 40 * 24 * 60 * 60 * 1_000,
  weekly: 8 * 24 * 60 * 60 * 1_000,
  event: 48 * 60 * 60 * 1_000,
  hourly_or_daily: 48 * 60 * 60 * 1_000,
  monthly: 40 * 24 * 60 * 60 * 1_000,
});

const factorRegistry = {
  ...rawFactorRegistry,
  factors: rawFactorRegistry.factors.map((factor) => ({
    ...factor,
    formula:
      FORMULAS[factor.name] ||
      (factor.eligibility === "unavailable"
        ? "not_computed_without_qualified_source"
        : "source_reported_value_or_registered_transform"),
    maximumUsableDelayMs:
      DELAY_BY_FREQUENCY[factor.frequency] || 40 * 24 * 60 * 60 * 1_000,
    missingStrategy:
      factor.eligibility === "unavailable"
        ? "unavailable_no_substitution"
        : "null_with_availability_mask",
    availabilityRule: factor.availability,
    modelEligibility: factor.eligibility,
  })),
};

if (
  factorRegistry.schema !== "athena.gold.factor-registry" ||
  factorRegistry.registryVersion !== "gold-gqss-factor-registry-v1" ||
  factorRegistry.factors.length !== 65
)
  throw new Error("gold_factor_registry_invalid");

const FACTOR_REGISTRY_SHA256 = sha256(factorRegistry);

module.exports = {
  FACTOR_REGISTRY: factorRegistry,
  FACTOR_REGISTRY_SHA256,
  canonicalJson,
  sha256,
};
