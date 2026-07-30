const {
  _internals: indicatorInternals,
} = require("../agents/aibitat/plugins/crypto-market/quantAnalysis");
const {
  _internals: evidenceInternals,
} = require("../agents/aibitat/plugins/crypto-market/supportingEvidence");
const {
  FEATURE_SCHEMA_VERSION,
  ROUND_TRIP_COST_RATIO,
} = require("./constants");
const {
  FEATURE_NAMES,
  FEATURE_REGISTRY_V3,
  FEATURE_REGISTRY_V3_SHA256,
  FEATURE_REGISTRY_V4,
  FEATURE_REGISTRY_V4_SHA256,
  FEATURE_REGISTRY_V5,
  FEATURE_REGISTRY_V5_SHA256,
  HORIZON_FEATURE_NAMES_V3,
  HORIZON_FEATURE_NAMES_V4,
  HORIZON_FEATURE_NAMES_V5,
} = require("./contracts");

const MIN_BARS = 30 * 24 * 12;
const BAR_INTERVAL_MS = 5 * 60 * 1_000;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value, digits = 12) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function logReturn(bars, window) {
  if (bars.length <= window) return null;
  const current = finite(bars.at(-1)?.close);
  const previous = finite(bars[bars.length - 1 - window]?.close);
  return current > 0 && previous > 0 ? Math.log(current / previous) : null;
}

function sum(bars, field) {
  return bars.reduce((total, bar) => total + Number(bar[field] || 0), 0);
}

function ratioRecentToBaseline(bars, field, recentBars, baselineBars) {
  if (bars.length < baselineBars || recentBars <= 0) return null;
  const recent = bars.slice(-recentBars);
  const baseline = bars.slice(-baselineBars);
  const recentAverage = sum(recent, field) / recent.length;
  const baselineAverage = sum(baseline, field) / baseline.length;
  return baselineAverage > 0 ? recentAverage / baselineAverage : null;
}

function seasonalRatio(
  bars,
  field,
  recentBars = 12,
  weekBars = 7 * 24 * 12,
  lookbackWeeks = 4
) {
  if (bars.length < weekBars * lookbackWeeks + recentBars) return null;
  const current = sum(bars.slice(-recentBars), field);
  const comparisons = [];
  for (let week = 1; week <= lookbackWeeks; week += 1) {
    const end = bars.length - week * weekBars;
    const start = end - recentBars;
    if (start < 0) continue;
    comparisons.push(sum(bars.slice(start, end), field));
  }
  const baseline =
    comparisons.reduce((total, value) => total + value, 0) / comparisons.length;
  return baseline > 0 ? current / baseline : null;
}

function realizedVolatility(bars, window) {
  if (bars.length <= window) return null;
  const returns = [];
  for (let index = bars.length - window; index < bars.length; index += 1) {
    const previous = finite(bars[index - 1]?.close);
    const current = finite(bars[index]?.close);
    if (!(previous > 0 && current > 0)) return null;
    returns.push(Math.log(current / previous));
  }
  const mean =
    returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance =
    returns.reduce((total, value) => total + (value - mean) ** 2, 0) /
    Math.max(returns.length - 1, 1);
  return Math.sqrt(variance);
}

function rollingSmaDistance(bars, window) {
  if (bars.length < window) return null;
  const current = finite(bars.at(-1)?.close);
  const average =
    bars.slice(-window).reduce((total, bar) => total + bar.close, 0) / window;
  return current > 0 && average > 0 ? current / average - 1 : null;
}

function takerRatio(bars, window) {
  if (bars.length < window) return null;
  const subset = bars.slice(-window);
  const quote = sum(subset, "quoteVolume");
  return quote > 0 ? sum(subset, "takerBuyQuoteVolume") / quote : null;
}

function takerFlow(bars, window) {
  const ratio = takerRatio(bars, window);
  return Number.isFinite(ratio) ? ratio * 2 - 1 : null;
}

function resampleBars(bars = [], intervalMs) {
  const result = [];
  let current = null;
  for (const bar of bars) {
    const bucket = Math.floor(bar.openTimeMs / intervalMs) * intervalMs;
    if (!current || current.openTimeMs !== bucket) {
      if (current) result.push(current);
      current = {
        ...bar,
        interval: `${intervalMs}ms`,
        openTimeMs: bucket,
        closeTimeMs: bucket + intervalMs - 1,
      };
      continue;
    }
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    current.volume += bar.volume;
    current.quoteVolume += bar.quoteVolume;
    current.tradeCount += bar.tradeCount;
    current.takerBuyBaseVolume += bar.takerBuyBaseVolume;
    current.takerBuyQuoteVolume += bar.takerBuyQuoteVolume;
  }
  if (current) result.push(current);
  return result;
}

function alignedReturns(left, right, window) {
  const leftMap = new Map(left.map((bar) => [bar.openTimeMs, bar.close]));
  const pairs = right
    .filter((bar) => leftMap.has(bar.openTimeMs))
    .slice(-(window + 1))
    .map((bar) => [leftMap.get(bar.openTimeMs), bar.close]);
  if (pairs.length < window + 1) return { correlation: null };
  const leftReturns = [];
  const rightReturns = [];
  for (let index = 1; index < pairs.length; index += 1) {
    leftReturns.push(Math.log(pairs[index][0] / pairs[index - 1][0]));
    rightReturns.push(Math.log(pairs[index][1] / pairs[index - 1][1]));
  }
  return {
    correlation: evidenceInternals.pearsonCorrelation(
      leftReturns,
      rightReturns
    ),
  };
}

function ewmaVolatility(bars, halfLifeBars = 288, maxBars = 2_016) {
  const subset = bars.slice(-(maxBars + 1));
  if (subset.length < 289) return null;
  const alpha = 1 - Math.exp(Math.log(0.5) / halfLifeBars);
  let variance = 0;
  let initialized = false;
  for (let index = 1; index < subset.length; index += 1) {
    const value = Math.log(subset[index].close / subset[index - 1].close);
    if (!Number.isFinite(value)) continue;
    variance = initialized
      ? alpha * value ** 2 + (1 - alpha) * variance
      : value ** 2;
    initialized = true;
  }
  return initialized ? Math.sqrt(variance) : null;
}

function labelBandRatio(bars, horizonDurationMs) {
  const perFiveMinuteVol = ewmaVolatility(bars);
  const horizonBars = horizonDurationMs / (5 * 60 * 1_000);
  const scaled = Number.isFinite(perFiveMinuteVol)
    ? 0.35 * perFiveMinuteVol * Math.sqrt(horizonBars)
    : null;
  return Math.max(ROUND_TRIP_COST_RATIO, scaled || 0);
}

function costFirstTouchBarrierRatio(
  bars,
  multiplier,
  {
    horizonDurationMs = 4 * 60 * 60 * 1_000,
    feeBpsPerSide = 10,
    slippageBpsPerSide = 5,
    safetyBufferBps = 5,
  } = {}
) {
  const perFiveMinuteVol = ewmaVolatility(bars);
  if (!Number.isFinite(perFiveMinuteVol)) return null;
  const horizonBars = horizonDurationMs / BAR_INTERVAL_MS;
  const horizonVolatility = perFiveMinuteVol * Math.sqrt(horizonBars);
  const minimum =
    (2 * (feeBpsPerSide + slippageBpsPerSide) + safetyBufferBps) / 10_000;
  return rounded(Math.max(minimum, Number(multiplier) * horizonVolatility), 12);
}

function latestFinite(values = []) {
  return [...values].reverse().find(Number.isFinite) ?? null;
}

function mean(values = []) {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length
    ? finiteValues.reduce((total, value) => total + value, 0) /
        finiteValues.length
    : null;
}

function median(values = []) {
  const finiteValues = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finiteValues.length) return null;
  const middle = Math.floor(finiteValues.length / 2);
  return finiteValues.length % 2
    ? finiteValues[middle]
    : (finiteValues[middle - 1] + finiteValues[middle]) / 2;
}

function normalizedAtr(rows = [], period = 14) {
  if (rows.length <= period) return null;
  const ranges = rows.map((row, index) => {
    if (index === 0) return row.high - row.low;
    const previousClose = rows[index - 1].close;
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose)
    );
  });
  let atr = mean(ranges.slice(1, period + 1));
  if (!Number.isFinite(atr)) return null;
  for (let index = period + 1; index < ranges.length; index += 1)
    atr = (atr * (period - 1) + ranges[index]) / period;
  const close = finite(rows.at(-1)?.close);
  return close > 0 ? atr / close : null;
}

function adxSnapshot(rows = [], period = 14, slopeBars = 3) {
  const series = indicatorInternals.directionalSeries(rows, period).adx;
  const latestIndex = (() => {
    for (let index = series.length - 1; index >= 0; index -= 1)
      if (Number.isFinite(series[index])) return index;
    return -1;
  })();
  if (latestIndex < 0) return { value: null, slope: null };
  const previous = series[latestIndex - slopeBars];
  return {
    value: series[latestIndex],
    slope: Number.isFinite(previous) ? series[latestIndex] - previous : null,
  };
}

function donchianPosition(rows = [], period = 20) {
  if (rows.length <= period) return null;
  const reference = rows.slice(0, -1).slice(-period);
  const upper = Math.max(...reference.map((row) => row.high));
  const lower = Math.min(...reference.map((row) => row.low));
  const close = finite(rows.at(-1)?.close);
  return close !== null && upper > lower
    ? (close - lower) / (upper - lower)
    : 0.5;
}

function bollingerZ(rows = [], period = 20) {
  const closes = rows.map((row) => row.close);
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const average = mean(window);
  if (!Number.isFinite(average)) return null;
  const deviation = Math.sqrt(
    window.reduce((total, value) => total + (value - average) ** 2, 0) / period
  );
  return deviation > 0 ? (window.at(-1) - average) / deviation : 0;
}

function vwapDistance(bars = [], window) {
  if (bars.length < window) return null;
  const selected = bars.slice(-window);
  const baseVolume = sum(selected, "volume");
  const quoteVolume = sum(selected, "quoteVolume");
  const close = finite(selected.at(-1)?.close);
  const vwap = baseVolume > 0 ? quoteVolume / baseVolume : null;
  return close > 0 && vwap > 0 ? close / vwap - 1 : null;
}

function marketStructureValue(rows = []) {
  const state = evidenceInternals.marketStructure(rows, 2).state;
  if (state === "bullish") return 1;
  if (state === "bearish") return -1;
  if (state === "mixed") return 0;
  return null;
}

function robustVolumeSurprise(
  bars = [],
  recentBars,
  weekBars = 7 * 24 * 12,
  lookbackWeeks = 4
) {
  if (bars.length < weekBars * lookbackWeeks + recentBars) return null;
  const current = sum(bars.slice(-recentBars), "quoteVolume");
  const comparisons = [];
  for (let week = 1; week <= lookbackWeeks; week += 1) {
    const end = bars.length - week * weekBars;
    const start = end - recentBars;
    if (start >= 0)
      comparisons.push(sum(bars.slice(start, end), "quoteVolume"));
  }
  const baseline = median(comparisons);
  if (!(baseline > 0)) return null;
  const deviations = comparisons.map((value) => Math.abs(value - baseline));
  const mad = median(deviations);
  const scale = Number.isFinite(mad) && mad > 0 ? 1.4826 * mad : baseline;
  return (current - baseline) / scale;
}

function takerFlowPersistence(bars = [], window, bucketBars = 3) {
  if (bars.length < window || window < bucketBars) return null;
  const buckets = resampleBars(bars, bucketBars * BAR_INTERVAL_MS);
  const selected = buckets.slice(-Math.floor(window / bucketBars));
  const signs = selected
    .map((bar) => takerFlow([bar], 1))
    .filter(Number.isFinite)
    .map(Math.sign);
  return mean(signs);
}

function takerFlowAcceleration(bars = [], window) {
  if (bars.length < window * 2) return null;
  const recent = takerFlow(bars, window);
  const previous = takerFlow(bars.slice(0, -window), window);
  return Number.isFinite(recent) && Number.isFinite(previous)
    ? recent - previous
    : null;
}

function alignedMarketStatistics({
  symbol,
  bars,
  marketBarsBySymbol = {},
  returnWindows = [],
  correlationWindow = 30 * 24 * 12,
}) {
  const otherSymbols = Object.keys(marketBarsBySymbol).filter(
    (candidate) => candidate !== symbol
  );
  if (!otherSymbols.length)
    return {
      relativeReturns: Object.fromEntries(
        returnWindows.map((window) => [window, null])
      ),
      correlation: null,
      beta: null,
    };
  const assetMap = new Map(bars.map((bar) => [bar.openTimeMs, bar.close]));
  const otherMaps = otherSymbols.map(
    (candidate) =>
      new Map(
        (marketBarsBySymbol[candidate] || []).map((bar) => [
          bar.openTimeMs,
          bar.close,
        ])
      )
  );
  const aligned = [...assetMap.entries()]
    .filter(([time]) => otherMaps.every((lookup) => lookup.has(time)))
    .map(([time, assetClose]) => ({
      time,
      assetClose,
      marketClose: Math.exp(
        mean(otherMaps.map((lookup) => Math.log(lookup.get(time))))
      ),
    }))
    .sort((left, right) => left.time - right.time);
  const relativeReturns = {};
  for (const window of returnWindows) {
    if (aligned.length <= window) {
      relativeReturns[window] = null;
      continue;
    }
    const current = aligned.at(-1);
    const previous = aligned[aligned.length - 1 - window];
    relativeReturns[window] =
      Math.log(current.assetClose / previous.assetClose) -
      Math.log(current.marketClose / previous.marketClose);
  }
  const selected = aligned.slice(-(correlationWindow + 1));
  if (selected.length < correlationWindow + 1)
    return { relativeReturns, correlation: null, beta: null };
  const assetReturns = [];
  const marketReturns = [];
  for (let index = 1; index < selected.length; index += 1) {
    assetReturns.push(
      Math.log(selected[index].assetClose / selected[index - 1].assetClose)
    );
    marketReturns.push(
      Math.log(selected[index].marketClose / selected[index - 1].marketClose)
    );
  }
  const correlation = evidenceInternals.pearsonCorrelation(
    assetReturns,
    marketReturns
  );
  const marketMean = mean(marketReturns);
  const assetMean = mean(assetReturns);
  const covariance = mean(
    marketReturns.map(
      (value, index) => (value - marketMean) * (assetReturns[index] - assetMean)
    )
  );
  const marketVariance = mean(
    marketReturns.map((value) => (value - marketMean) ** 2)
  );
  return {
    relativeReturns,
    correlation,
    beta: marketVariance > 0 ? covariance / marketVariance : null,
  };
}

function buildFeatureVectorV3({
  horizon,
  symbol,
  bars,
  marketBarsBySymbol = { [symbol]: bars },
  featureNames = null,
  asOfMs = bars.at(-1)?.closeTimeMs,
  decisionAtMs = asOfMs + 1,
}) {
  const names = featureNames || HORIZON_FEATURE_NAMES_V3[horizon];
  if (!names)
    return {
      status: "insufficient",
      reason: "v3_horizon_not_optimized",
      featureSchemaVersion: FEATURE_REGISTRY_V3.registryVersion,
    };
  const closedBySymbol = Object.fromEntries(
    Object.entries(marketBarsBySymbol).map(([candidate, candidateBars]) => [
      candidate,
      candidateBars
        .filter(
          (bar) =>
            bar.closeTimeMs <= asOfMs &&
            Number(bar.availableAtMs ?? bar.closeTimeMs + 1) <= decisionAtMs
        )
        .sort((left, right) => left.openTimeMs - right.openTimeMs),
    ])
  );
  const closed = closedBySymbol[symbol] || [];
  if (closed.length < MIN_BARS)
    return {
      status: "insufficient",
      reason: "insufficient_history",
      barsAvailable: closed.length,
      barsRequired: MIN_BARS,
      featureSchemaVersion: FEATURE_REGISTRY_V3.registryVersion,
    };
  let contiguousStart = 0;
  const continuityFloor = Math.max(0, closed.length - MIN_BARS);
  for (let index = closed.length - 1; index > continuityFloor; index -= 1) {
    if (
      closed[index].openTimeMs - closed[index - 1].openTimeMs !==
      BAR_INTERVAL_MS
    ) {
      contiguousStart = index;
      break;
    }
  }
  const featureBars = closed.slice(contiguousStart);
  if (featureBars.length < MIN_BARS)
    return {
      status: "insufficient",
      reason: "market_data_gap",
      barsAvailable: featureBars.length,
      barsRequired: MIN_BARS,
      featureSchemaVersion: FEATURE_REGISTRY_V3.registryVersion,
    };
  const hourly = resampleBars(featureBars, 60 * 60 * 1_000);
  const fourHourly = resampleBars(featureBars, 4 * 60 * 60 * 1_000);
  const daily = resampleBars(featureBars, 24 * 60 * 60 * 1_000);
  const hourlyRows = hourly.map((bar) => ({
    ts: bar.openTimeMs,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
  const fourHourlyRows = fourHourly.map((bar) => ({
    ts: bar.openTimeMs,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
  const dailyRows = daily.map((bar) => ({
    ts: bar.openTimeMs,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
  const adx1h = adxSnapshot(hourlyRows);
  const adx4h = adxSnapshot(fourHourlyRows);
  const adx24h = adxSnapshot(dailyRows);
  const cmf = evidenceInternals.chaikinMoneyFlowSeries(hourlyRows, 20);
  const mfi = evidenceInternals.moneyFlowIndexSeries(hourlyRows, 14);
  const adl = evidenceInternals.accumulationDistributionSeries(hourlyRows);
  const adlSlope = evidenceInternals.accumulationDistributionSlope(
    hourlyRows,
    adl,
    3
  );
  const cross = alignedMarketStatistics({
    symbol,
    bars: featureBars,
    marketBarsBySymbol: closedBySymbol,
    returnWindows: [48, 288, 1_152],
  });
  const donchian4h = donchianPosition(fourHourlyRows, 20);
  const donchian24h = donchianPosition(hourlyRows, 20);
  const donchian4d = donchianPosition(fourHourlyRows, 24);
  const volumeRatio4h24h = ratioRecentToBaseline(
    featureBars,
    "quoteVolume",
    48,
    288
  );
  const volumeRatio24h4d = ratioRecentToBaseline(
    featureBars,
    "quoteVolume",
    288,
    1_152
  );
  const values = {
    asset_eth: symbol === "ETH" ? 1 : 0,
    asset_sol: symbol === "SOL" ? 1 : 0,
    return_15m: logReturn(featureBars, 3),
    return_1h: logReturn(featureBars, 12),
    return_4h: logReturn(featureBars, 48),
    return_12h: logReturn(featureBars, 144),
    return_24h: logReturn(featureBars, 288),
    return_4d: logReturn(featureBars, 1_152),
    return_12d: logReturn(featureBars, 3_456),
    realized_vol_1h: realizedVolatility(featureBars, 12),
    realized_vol_4h: realizedVolatility(featureBars, 48),
    realized_vol_24h: realizedVolatility(featureBars, 288),
    realized_vol_4d: realizedVolatility(featureBars, 1_152),
    normalized_atr_1h: normalizedAtr(hourlyRows),
    normalized_atr_4h: normalizedAtr(fourHourlyRows),
    normalized_atr_24h: normalizedAtr(dailyRows),
    adx_1h: adx1h.value,
    adx_slope_1h: adx1h.slope,
    adx_4h: adx4h.value,
    adx_slope_4h: adx4h.slope,
    adx_24h: adx24h.value,
    adx_slope_24h: adx24h.slope,
    donchian_position_4h: donchian4h,
    donchian_position_24h: donchian24h,
    donchian_position_4d: donchian4d,
    bollinger_z_4h: bollingerZ(fourHourlyRows),
    bollinger_z_24h: bollingerZ(hourlyRows),
    bollinger_z_4d: bollingerZ(fourHourlyRows, 24),
    vwap_distance_1h: vwapDistance(featureBars, 12),
    vwap_distance_4h: vwapDistance(featureBars, 48),
    vwap_distance_24h: vwapDistance(featureBars, 288),
    market_structure_4h: marketStructureValue(fourHourlyRows.slice(-80)),
    market_structure_24h: marketStructureValue(hourlyRows.slice(-80)),
    volume_ratio_15m_4h: ratioRecentToBaseline(
      featureBars,
      "quoteVolume",
      3,
      48
    ),
    volume_ratio_1h_24h: ratioRecentToBaseline(
      featureBars,
      "quoteVolume",
      12,
      288
    ),
    volume_ratio_4h_24h: volumeRatio4h24h,
    volume_ratio_24h_4d: volumeRatio24h4d,
    volume_acceleration_1h: ratioRecentToBaseline(
      featureBars,
      "quoteVolume",
      12,
      24
    ),
    volume_acceleration_4h: ratioRecentToBaseline(
      featureBars,
      "quoteVolume",
      48,
      96
    ),
    robust_volume_surprise_1h: robustVolumeSurprise(featureBars, 12),
    robust_volume_surprise_4h: robustVolumeSurprise(featureBars, 48),
    trade_count_ratio_1h_24h: ratioRecentToBaseline(
      featureBars,
      "tradeCount",
      12,
      288
    ),
    trade_count_ratio_4h_24h: ratioRecentToBaseline(
      featureBars,
      "tradeCount",
      48,
      288
    ),
    taker_flow_proxy_15m: takerFlow(featureBars, 3),
    taker_flow_proxy_1h: takerFlow(featureBars, 12),
    taker_flow_proxy_4h: takerFlow(featureBars, 48),
    taker_flow_proxy_12h: takerFlow(featureBars, 144),
    taker_flow_proxy_24h: takerFlow(featureBars, 288),
    taker_flow_persistence_1h: takerFlowPersistence(featureBars, 12),
    taker_flow_persistence_4h: takerFlowPersistence(featureBars, 48),
    taker_flow_persistence_12h: takerFlowPersistence(featureBars, 144),
    taker_flow_acceleration_1h: takerFlowAcceleration(featureBars, 12),
    taker_flow_acceleration_4h: takerFlowAcceleration(featureBars, 48),
    cmf20_1h: latestFinite(cmf),
    mfi14_1h: latestFinite(mfi),
    adl_slope_1h: adlSlope.normalizedByVolume,
    relative_market_return_4h: cross.relativeReturns[48],
    relative_market_return_24h: cross.relativeReturns[288],
    relative_market_return_4d: cross.relativeReturns[1_152],
    market_correlation_30d: cross.correlation,
    market_beta_30d: cross.beta,
    breakout_volume_interaction_4h:
      Number.isFinite(donchian4h) && Number.isFinite(volumeRatio4h24h)
        ? (donchian4h - 0.5) * 2 * volumeRatio4h24h
        : null,
    breakout_volume_interaction_24h:
      Number.isFinite(donchian24h) && Number.isFinite(volumeRatio24h4d)
        ? (donchian24h - 0.5) * 2 * volumeRatio24h4d
        : null,
    trend_adx_interaction_4h:
      Number.isFinite(logReturn(featureBars, 48)) &&
      Number.isFinite(adx4h.value)
        ? logReturn(featureBars, 48) * adx4h.value
        : null,
    trend_adx_interaction_24h:
      Number.isFinite(logReturn(featureBars, 288)) &&
      Number.isFinite(adx24h.value)
        ? logReturn(featureBars, 288) * adx24h.value
        : null,
  };
  const missing = names.filter(
    (name) => !Number.isFinite(Number(values[name]))
  );
  const vector = names.map((name) =>
    Number.isFinite(Number(values[name])) ? Number(values[name]) : 0
  );
  return {
    status: missing.length ? "partial" : "complete",
    featureSchemaVersion: FEATURE_REGISTRY_V3.registryVersion,
    featureRegistrySha256: FEATURE_REGISTRY_V3_SHA256,
    horizon,
    asOfMs,
    barsAvailable: featureBars.length,
    values: Object.fromEntries(
      names.map((name, index) => [name, rounded(vector[index])])
    ),
    vector,
    missing,
    evidenceCoverage: rounded(
      (names.length - missing.length) / names.length,
      6
    ),
  };
}

function buildFeatureVectorV4(options) {
  const names =
    options.featureNames || HORIZON_FEATURE_NAMES_V4[options.horizon];
  const result = buildFeatureVectorV3({
    ...options,
    featureNames: names,
  });
  if (!["complete", "partial"].includes(result.status)) {
    return {
      ...result,
      featureSchemaVersion: FEATURE_REGISTRY_V4.registryVersion,
    };
  }
  return {
    ...result,
    featureSchemaVersion: FEATURE_REGISTRY_V4.registryVersion,
    featureRegistrySha256: FEATURE_REGISTRY_V4_SHA256,
  };
}

function buildFeatureVectorV5(options) {
  const names =
    options.featureNames || HORIZON_FEATURE_NAMES_V5[options.horizon];
  const result = buildFeatureVectorV3({
    ...options,
    featureNames: names,
  });
  if (!["complete", "partial"].includes(result.status)) {
    return {
      ...result,
      featureSchemaVersion: FEATURE_REGISTRY_V5.registryVersion,
    };
  }
  return {
    ...result,
    featureSchemaVersion: FEATURE_REGISTRY_V5.registryVersion,
    featureRegistrySha256: FEATURE_REGISTRY_V5_SHA256,
  };
}

function buildFeatureVector({
  symbol,
  bars,
  btcBars = bars,
  asOfMs = bars.at(-1)?.closeTimeMs,
  decisionAtMs = asOfMs + 1,
}) {
  const closed = bars
    .filter(
      (bar) =>
        bar.closeTimeMs <= asOfMs &&
        Number(bar.availableAtMs ?? bar.closeTimeMs + 1) <= decisionAtMs
    )
    .sort((left, right) => left.openTimeMs - right.openTimeMs);
  const btcClosed = btcBars
    .filter(
      (bar) =>
        bar.closeTimeMs <= asOfMs &&
        Number(bar.availableAtMs ?? bar.closeTimeMs + 1) <= decisionAtMs
    )
    .sort((left, right) => left.openTimeMs - right.openTimeMs);
  if (closed.length < MIN_BARS)
    return {
      status: "insufficient",
      reason: "insufficient_history",
      barsAvailable: closed.length,
      barsRequired: MIN_BARS,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    };
  const contiguousBars = (source) => {
    let start = Math.max(0, source.length - MIN_BARS);
    for (let index = source.length - 1; index > start; index -= 1) {
      if (
        source[index].openTimeMs - source[index - 1].openTimeMs !==
        BAR_INTERVAL_MS
      ) {
        start = index;
        break;
      }
    }
    return source.slice(start);
  };
  const contiguousClosed = contiguousBars(closed);
  const contiguousBtcClosed = contiguousBars(btcClosed);
  if (contiguousClosed.length < MIN_BARS)
    return {
      status: "insufficient",
      reason: "market_data_gap",
      barsAvailable: contiguousClosed.length,
      barsRequired: MIN_BARS,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    };
  if (symbol !== "BTC" && contiguousBtcClosed.length < MIN_BARS)
    return {
      status: "insufficient",
      reason: "benchmark_data_gap",
      barsAvailable: contiguousBtcClosed.length,
      barsRequired: MIN_BARS,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    };

  const featureBars = contiguousClosed;
  const benchmarkBars = symbol === "BTC" ? featureBars : contiguousBtcClosed;
  const hourly = resampleBars(featureBars, 60 * 60 * 1_000);
  const hourlyRows = hourly.slice(-240).map((bar) => ({
    ts: bar.openTimeMs,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
  const regression4h = evidenceInternals.linearRegression(
    featureBars.slice(-48).map((bar) => bar.close),
    48
  );
  const regression24h = evidenceInternals.linearRegression(
    featureBars.slice(-288).map((bar) => bar.close),
    288
  );
  const rsi = indicatorInternals.rsiSeries(
    hourlyRows.map((row) => row.close),
    14
  );
  const cmf = evidenceInternals.chaikinMoneyFlowSeries(hourlyRows, 20);
  const mfi = evidenceInternals.moneyFlowIndexSeries(hourlyRows, 14);
  const adl = evidenceInternals.accumulationDistributionSeries(hourlyRows);
  const adlSlope = evidenceInternals.accumulationDistributionSlope(
    hourlyRows,
    adl,
    3
  );
  const weekMinutes = 7 * 24 * 60;
  const epochThursdayOffsetMinutes = 3 * 24 * 60;
  const minuteOfWeek =
    (((Math.floor(asOfMs / 60_000) + epochThursdayOffsetMinutes) %
      weekMinutes) +
      weekMinutes) %
    weekMinutes;
  const cycle = (minuteOfWeek / (7 * 24 * 60)) * Math.PI * 2;
  const values = {
    asset_btc: symbol === "BTC" ? 1 : 0,
    asset_eth: symbol === "ETH" ? 1 : 0,
    asset_sol: symbol === "SOL" ? 1 : 0,
    return_1h: logReturn(featureBars, 12),
    return_4h: logReturn(featureBars, 48),
    return_24h: logReturn(featureBars, 288),
    return_4d: logReturn(featureBars, 1_152),
    return_12d: logReturn(featureBars, 3_456),
    return_24d: logReturn(featureBars, 6_912),
    realized_vol_4h: realizedVolatility(featureBars, 48),
    realized_vol_24h: realizedVolatility(featureBars, 288),
    realized_vol_4d: realizedVolatility(featureBars, 1_152),
    volume_ratio_1h_24h: ratioRecentToBaseline(
      featureBars,
      "quoteVolume",
      12,
      288
    ),
    volume_ratio_4h_24h: ratioRecentToBaseline(
      featureBars,
      "quoteVolume",
      48,
      288
    ),
    volume_acceleration_1h:
      ratioRecentToBaseline(featureBars, "quoteVolume", 12, 24) ?? null,
    seasonal_volume_ratio_1h: seasonalRatio(featureBars, "quoteVolume"),
    seasonal_trade_count_ratio_1h: seasonalRatio(featureBars, "tradeCount"),
    trade_count_ratio_1h_24h: ratioRecentToBaseline(
      featureBars,
      "tradeCount",
      12,
      288
    ),
    taker_buy_ratio_1h: takerRatio(featureBars, 12),
    taker_buy_ratio_4h: takerRatio(featureBars, 48),
    taker_flow_proxy_1h: takerFlow(featureBars, 12),
    taker_flow_proxy_4h: takerFlow(featureBars, 48),
    close_vs_sma_4h: rollingSmaDistance(featureBars, 48),
    close_vs_sma_24h: rollingSmaDistance(featureBars, 288),
    regression_slope_4h: regression4h.slopePctPerBar,
    regression_r2_4h: regression4h.rSquared,
    regression_slope_24h: regression24h.slopePctPerBar,
    regression_r2_24h: regression24h.rSquared,
    efficiency_ratio_4h: evidenceInternals.efficiencyRatio(
      featureBars.map((bar) => bar.close),
      48
    ),
    efficiency_ratio_24h: evidenceInternals.efficiencyRatio(
      featureBars.map((bar) => bar.close),
      288
    ),
    rsi14_1h: [...rsi].reverse().find(Number.isFinite) ?? null,
    cmf20_1h: [...cmf].reverse().find(Number.isFinite) ?? null,
    mfi14_1h: [...mfi].reverse().find(Number.isFinite) ?? null,
    adl_slope_1h: adlSlope.normalizedByVolume,
    relative_btc_return_4h: (() => {
      if (symbol === "BTC") return 0;
      const asset = finite(logReturn(featureBars, 48));
      const benchmark = finite(logReturn(benchmarkBars, 48));
      return asset === null || benchmark === null ? null : asset - benchmark;
    })(),
    relative_btc_return_24h: (() => {
      if (symbol === "BTC") return 0;
      const asset = finite(logReturn(featureBars, 288));
      const benchmark = finite(logReturn(benchmarkBars, 288));
      return asset === null || benchmark === null ? null : asset - benchmark;
    })(),
    btc_correlation_30d:
      symbol === "BTC"
        ? 1
        : alignedReturns(featureBars, benchmarkBars, 30 * 24 * 12).correlation,
    minute_of_week_sin: Math.sin(cycle),
    minute_of_week_cos: Math.cos(cycle),
  };

  const missing = FEATURE_NAMES.filter(
    (name) => !Number.isFinite(Number(values[name]))
  );
  const vector = FEATURE_NAMES.map((name) =>
    Number.isFinite(Number(values[name])) ? Number(values[name]) : 0
  );
  return {
    status: missing.length ? "partial" : "complete",
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    asOfMs,
    barsAvailable: featureBars.length,
    values: Object.fromEntries(
      FEATURE_NAMES.map((name, index) => [name, rounded(vector[index])])
    ),
    vector,
    missing,
    evidenceCoverage: rounded(
      (FEATURE_NAMES.length - missing.length) / FEATURE_NAMES.length,
      6
    ),
  };
}

module.exports = {
  FEATURE_NAMES,
  HORIZON_FEATURE_NAMES_V3,
  HORIZON_FEATURE_NAMES_V4,
  HORIZON_FEATURE_NAMES_V5,
  MIN_BARS,
  _internals: {
    adxSnapshot,
    alignedReturns,
    alignedMarketStatistics,
    bollingerZ,
    donchianPosition,
    ewmaVolatility,
    logReturn,
    marketStructureValue,
    normalizedAtr,
    ratioRecentToBaseline,
    realizedVolatility,
    resampleBars,
    robustVolumeSurprise,
    seasonalRatio,
    takerFlow,
    takerFlowAcceleration,
    takerFlowPersistence,
    takerRatio,
    vwapDistance,
  },
  buildFeatureVector,
  buildFeatureVectorV3,
  buildFeatureVectorV4,
  buildFeatureVectorV5,
  costFirstTouchBarrierRatio,
  labelBandRatio,
};
