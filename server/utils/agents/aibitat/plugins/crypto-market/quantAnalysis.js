const crypto = require("node:crypto");
const {
  buildSupportingEvidence,
  enhancedIndicators,
} = require("./supportingEvidence");

const FORMULA_VERSION = "crypto-quant-v2";
const BARS_REQUESTED = 500;
const BARS_RETURNED = 120;
const MIN_ANALYSIS_BARS = 30;
const COMPLETE_TIMEFRAME_BARS = 60;
const MAX_ANALYSIS_PAYLOAD_BYTES = 100 * 1024;

const TIMEFRAME_CONFIG = Object.freeze({
  "1h": {
    interval: "1h",
    intervalMs: 60 * 60 * 1_000,
    barsPerYear: 365 * 24,
  },
  "4h": {
    interval: "4h",
    intervalMs: 4 * 60 * 60 * 1_000,
    barsPerYear: 365 * 6,
  },
  "1d": {
    interval: "1d",
    intervalMs: 24 * 60 * 60 * 1_000,
    barsPerYear: 365,
  },
  "1w": {
    interval: "1w",
    intervalMs: 7 * 24 * 60 * 60 * 1_000,
    barsPerYear: 52,
  },
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value, digits = 10) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function lastFinite(values = []) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(values[index])) return values[index];
  }
  return null;
}

function compactCandle(candle) {
  return [
    Number(candle.ts),
    String(candle.open),
    String(candle.high),
    String(candle.low),
    String(candle.close),
    String(candle.volume),
  ];
}

function closedCandlesSha256(rows = []) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        rows.map((row) => [
          row.ts,
          row.raw.open,
          row.raw.high,
          row.raw.low,
          row.raw.close,
          row.raw.volume,
        ])
      )
    )
    .digest("hex");
}

function numericRows(candles = []) {
  const byTimestamp = new Map();
  for (const candle of candles) {
    const ts = finite(candle?.ts);
    const open = finite(candle?.open);
    const high = finite(candle?.high);
    const low = finite(candle?.low);
    const close = finite(candle?.close);
    const volume = finite(candle?.volume);
    if (
      ts === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      volume === null ||
      ts <= 0 ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      volume < 0
    )
      continue;
    byTimestamp.set(ts, {
      ts,
      open,
      high,
      low,
      close,
      volume,
      raw: {
        ts,
        open: String(candle.open),
        high: String(candle.high),
        low: String(candle.low),
        close: String(candle.close),
        volume: String(candle.volume),
      },
    });
  }
  return Array.from(byTimestamp.values()).sort(
    (left, right) => left.ts - right.ts
  );
}

function splitClosedRows(candles, intervalMs, now = Date.now()) {
  const rows = numericRows(candles);
  if (!rows.length) return { closed: [], forming: null };
  const latest = rows[rows.length - 1];
  const forming = latest.ts + intervalMs > now ? rows.pop() || null : null;
  return { closed: rows, forming };
}

function smaSeries(values, period) {
  const result = Array(values.length).fill(null);
  let sum = 0;
  let invalid = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value)) sum += value;
    else invalid += 1;
    if (index >= period) {
      const removed = values[index - period];
      if (Number.isFinite(removed)) sum -= removed;
      else invalid -= 1;
    }
    if (index >= period - 1 && invalid === 0) result[index] = sum / period;
  }
  return result;
}

function emaSeries(values, period) {
  const result = Array(values.length).fill(null);
  const alpha = 2 / (period + 1);
  const seed = [];
  let previous = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    if (previous === null) {
      seed.push(value);
      if (seed.length < period) continue;
      if (seed.length > period) seed.shift();
      previous = seed.reduce((sum, entry) => sum + entry, 0) / period;
      result[index] = previous;
      continue;
    }
    previous = value * alpha + previous * (1 - alpha);
    result[index] = previous;
  }
  return result;
}

function bollingerSeries(values, period = 20, multiplier = 2) {
  const middle = smaSeries(values, period);
  const upper = Array(values.length).fill(null);
  const lower = Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    if (!Number.isFinite(middle[index])) continue;
    const window = values.slice(index - period + 1, index + 1);
    if (!window.every(Number.isFinite)) continue;
    const variance =
      window.reduce((sum, value) => sum + (value - middle[index]) ** 2, 0) /
      period;
    const deviation = Math.sqrt(variance);
    upper[index] = middle[index] + deviation * multiplier;
    lower[index] = middle[index] - deviation * multiplier;
  }
  return { middle, upper, lower };
}

function rsiSeries(values, period = 14) {
  const result = Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  const valueFor = () => {
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    return 100 - 100 / (1 + averageGain / averageLoss);
  };
  result[period] = valueFor();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    result[index] = valueFor();
  }
  return result;
}

function trueRangeSeries(rows) {
  return rows.map((row, index) => {
    if (index === 0) return row.high - row.low;
    const previousClose = rows[index - 1].close;
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose)
    );
  });
}

function wilderSeries(values, period, seedIndex = period - 1) {
  const result = Array(values.length).fill(null);
  const start = seedIndex - period + 1;
  if (start < 0 || seedIndex >= values.length) return result;
  const seed = values.slice(start, seedIndex + 1);
  if (!seed.every(Number.isFinite)) return result;
  let previous = seed.reduce((sum, value) => sum + value, 0) / period;
  result[seedIndex] = previous;
  for (let index = seedIndex + 1; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) continue;
    previous = (previous * (period - 1) + values[index]) / period;
    result[index] = previous;
  }
  return result;
}

function directionalSeries(rows, period = 14) {
  const length = rows.length;
  const tr = trueRangeSeries(rows);
  const plusDm = Array(length).fill(0);
  const minusDm = Array(length).fill(0);
  for (let index = 1; index < length; index += 1) {
    const upMove = rows[index].high - rows[index - 1].high;
    const downMove = rows[index - 1].low - rows[index].low;
    plusDm[index] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[index] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const plusDi = Array(length).fill(null);
  const minusDi = Array(length).fill(null);
  const dx = Array(length).fill(null);
  const adx = Array(length).fill(null);
  if (length <= period) return { plusDi, minusDi, adx };

  let smoothTr = tr.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  let smoothPlus = plusDm
    .slice(1, period + 1)
    .reduce((sum, value) => sum + value, 0);
  let smoothMinus = minusDm
    .slice(1, period + 1)
    .reduce((sum, value) => sum + value, 0);

  for (let index = period; index < length; index += 1) {
    if (index > period) {
      smoothTr = smoothTr - smoothTr / period + tr[index];
      smoothPlus = smoothPlus - smoothPlus / period + plusDm[index];
      smoothMinus = smoothMinus - smoothMinus / period + minusDm[index];
    }
    plusDi[index] = smoothTr === 0 ? 0 : (100 * smoothPlus) / smoothTr;
    minusDi[index] = smoothTr === 0 ? 0 : (100 * smoothMinus) / smoothTr;
    const denominator = plusDi[index] + minusDi[index];
    dx[index] =
      denominator === 0
        ? 0
        : (100 * Math.abs(plusDi[index] - minusDi[index])) / denominator;
  }

  const firstAdxIndex = period * 2 - 1;
  if (firstAdxIndex < length) {
    const seed = dx.slice(period, firstAdxIndex + 1);
    if (seed.every(Number.isFinite)) {
      adx[firstAdxIndex] = seed.reduce((sum, value) => sum + value, 0) / period;
      for (let index = firstAdxIndex + 1; index < length; index += 1) {
        adx[index] = (adx[index - 1] * (period - 1) + dx[index]) / period;
      }
    }
  }
  return { plusDi, minusDi, adx };
}

function stochasticSeries(rows, period = 14, smoothK = 3, smoothD = 3) {
  const rawK = Array(rows.length).fill(null);
  for (let index = period - 1; index < rows.length; index += 1) {
    const window = rows.slice(index - period + 1, index + 1);
    const high = Math.max(...window.map((row) => row.high));
    const low = Math.min(...window.map((row) => row.low));
    rawK[index] =
      high === low ? 50 : ((rows[index].close - low) / (high - low)) * 100;
  }
  const k = smaSeries(rawK, smoothK);
  const d = smaSeries(k, smoothD);
  return { k, d };
}

function obvSeries(rows) {
  const result = Array(rows.length).fill(null);
  if (!rows.length) return result;
  result[0] = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const direction =
      rows[index].close > rows[index - 1].close
        ? 1
        : rows[index].close < rows[index - 1].close
          ? -1
          : 0;
    result[index] = result[index - 1] + direction * rows[index].volume;
  }
  return result;
}

function rollingVwapSeries(rows, period = 20) {
  const result = Array(rows.length).fill(null);
  for (let index = period - 1; index < rows.length; index += 1) {
    const window = rows.slice(index - period + 1, index + 1);
    const volume = window.reduce((sum, row) => sum + row.volume, 0);
    if (volume === 0) continue;
    result[index] =
      window.reduce(
        (sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume,
        0
      ) / volume;
  }
  return result;
}

function logReturn(values, bars) {
  if (values.length <= bars) return null;
  const latest = values[values.length - 1];
  const previous = values[values.length - 1 - bars];
  if (latest <= 0 || previous <= 0) return null;
  return Math.log(latest / previous);
}

function realizedVolatility(values, period, barsPerYear) {
  if (values.length <= period) return null;
  const returns = [];
  for (let index = values.length - period; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous <= 0 || current <= 0) return null;
    returns.push(Math.log(current / previous));
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(barsPerYear);
}

function maximumDrawdown(values, period = 30) {
  const window = values.slice(-period);
  if (!window.length) return null;
  let peak = window[0];
  let drawdown = 0;
  for (const value of window) {
    peak = Math.max(peak, value);
    if (peak > 0) drawdown = Math.min(drawdown, value / peak - 1);
  }
  return drawdown;
}

function slopePercent(values, bars = 3) {
  const finiteEntries = values
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => Number.isFinite(value));
  if (finiteEntries.length <= bars) return null;
  const latest = finiteEntries[finiteEntries.length - 1].value;
  const previous = finiteEntries[finiteEntries.length - 1 - bars].value;
  if (previous === 0) return null;
  return ((latest - previous) / Math.abs(previous)) * 100;
}

function slopeDelta(values, bars = 3) {
  const finiteEntries = values.filter(Number.isFinite);
  if (finiteEntries.length <= bars) return null;
  return (
    finiteEntries[finiteEntries.length - 1] -
    finiteEntries[finiteEntries.length - 1 - bars]
  );
}

function latestSnapshot(series) {
  return {
    value: rounded(lastFinite(series)),
    slope3Pct: rounded(slopePercent(series, 3)),
  };
}

function recentCross(left, right, rows, lookback = 3, name = "cross") {
  const events = [];
  const start = Math.max(1, rows.length - lookback);
  for (let index = start; index < rows.length; index += 1) {
    if (
      !Number.isFinite(left[index - 1]) ||
      !Number.isFinite(right[index - 1]) ||
      !Number.isFinite(left[index]) ||
      !Number.isFinite(right[index])
    )
      continue;
    const crossedUp =
      left[index - 1] <= right[index - 1] && left[index] > right[index];
    const crossedDown =
      left[index - 1] >= right[index - 1] && left[index] < right[index];
    if (!crossedUp && !crossedDown) continue;
    events.push({
      name: `${name}_${crossedUp ? "bullish" : "bearish"}`,
      barsAgo: rows.length - 1 - index,
      timestampMs: rows[index].ts,
    });
  }
  return events;
}

function rollingLevels(rows) {
  const previous = rows.slice(0, -1);
  const valuesFor = (period) => {
    const window = previous.slice(-period);
    if (!window.length) return { support: null, resistance: null };
    return {
      support: rounded(Math.min(...window.map((row) => row.low))),
      resistance: rounded(Math.max(...window.map((row) => row.high))),
    };
  };
  return {
    previous20: valuesFor(20),
    previous50: valuesFor(50),
    fibonacci: fibonacciLevels(rows, 100),
  };
}

function fibonacciLevels(rows, lookback = 100) {
  const closedWindow = rows.slice(-lookback);
  if (closedWindow.length < MIN_ANALYSIS_BARS)
    return {
      status: "insufficient_data",
      lookback,
      direction: null,
      swing: null,
      retracements: {},
      extensions: {},
      nearestBelow: null,
      nearestAbove: null,
    };

  const highRow = closedWindow.reduce((highest, row) =>
    row.high > highest.high ? row : highest
  );
  const lowRow = closedWindow.reduce((lowest, row) =>
    row.low < lowest.low ? row : lowest
  );
  const range = highRow.high - lowRow.low;
  if (!Number.isFinite(range) || range <= 0 || highRow.ts === lowRow.ts)
    return {
      status: "insufficient_range",
      lookback,
      direction: null,
      swing: null,
      retracements: {},
      extensions: {},
      nearestBelow: null,
      nearestAbove: null,
    };

  const direction = lowRow.ts < highRow.ts ? "upswing" : "downswing";
  const retracementRatios = [0.236, 0.382, 0.5, 0.618, 0.786];
  const extensionRatios = [1.272, 1.618];
  const retracements = Object.fromEntries(
    retracementRatios.map((ratio) => [
      String(ratio),
      rounded(
        direction === "upswing"
          ? highRow.high - range * ratio
          : lowRow.low + range * ratio
      ),
    ])
  );
  const extensions = Object.fromEntries(
    extensionRatios.map((ratio) => [
      String(ratio),
      rounded(
        direction === "upswing"
          ? highRow.high + range * (ratio - 1)
          : lowRow.low - range * (ratio - 1)
      ),
    ])
  );
  const currentClose = rows[rows.length - 1]?.close;
  const allLevels = [
    lowRow.low,
    highRow.high,
    ...Object.values(retracements),
    ...Object.values(extensions),
  ]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  return {
    status: "available",
    lookback,
    direction,
    swing: {
      startTimestampMs: direction === "upswing" ? lowRow.ts : highRow.ts,
      startPrice: rounded(direction === "upswing" ? lowRow.low : highRow.high),
      endTimestampMs: direction === "upswing" ? highRow.ts : lowRow.ts,
      endPrice: rounded(direction === "upswing" ? highRow.high : lowRow.low),
      range: rounded(range),
    },
    retracements,
    extensions,
    nearestBelow: Number.isFinite(currentClose)
      ? [...allLevels].reverse().find((level) => level < currentClose) || null
      : null,
    nearestAbove: Number.isFinite(currentClose)
      ? allLevels.find((level) => level > currentClose) || null
      : null,
  };
}

function gapCount(rows, intervalMs) {
  let gaps = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].ts - rows[index - 1].ts > intervalMs * 1.5) gaps += 1;
  }
  return gaps;
}

function regimeFor({
  close,
  ma5,
  ma10,
  ma30,
  adx,
  plusDi,
  minusDi,
  rsi,
  atrPct,
  bollWidthPct,
}) {
  if (![close, ma5, ma10, ma30, adx, plusDi, minusDi].every(Number.isFinite))
    return { state: "insufficient_data", volatility: "unknown", reasons: [] };

  const bullishAlignment =
    close > ma5 && ma5 > ma10 && ma10 > ma30 && plusDi > minusDi;
  const bearishAlignment =
    close < ma5 && ma5 < ma10 && ma10 < ma30 && minusDi > plusDi;
  const highVolatility =
    (Number.isFinite(atrPct) && atrPct >= 5) ||
    (Number.isFinite(bollWidthPct) && bollWidthPct >= 10);
  const reasons = [];
  let state = "mixed";
  if (bullishAlignment && adx >= 20) {
    state = "bullish_trend";
    reasons.push(
      "price_and_ma_bullish_alignment",
      "positive_directional_movement"
    );
  } else if (bearishAlignment && adx >= 20) {
    state = "bearish_trend";
    reasons.push(
      "price_and_ma_bearish_alignment",
      "negative_directional_movement"
    );
  } else if (adx < 20) {
    state = "range";
    reasons.push("low_adx");
  } else if (highVolatility) {
    state = "volatile";
    reasons.push("elevated_atr_or_bollinger_width");
  }
  if (Number.isFinite(rsi) && rsi >= 70) reasons.push("rsi_overbought");
  if (Number.isFinite(rsi) && rsi <= 30) reasons.push("rsi_oversold");
  return {
    state,
    volatility: highVolatility ? "high" : "normal",
    reasons,
  };
}

function analyzeTimeframe({
  id,
  candles,
  now = Date.now(),
  cacheHit = false,
  source = "gate",
}) {
  const config = TIMEFRAME_CONFIG[id];
  if (!config) throw new Error(`unsupported_quant_timeframe:${id}`);
  const { closed, forming } = splitClosedRows(candles, config.intervalMs, now);
  const closes = closed.map((row) => row.close);
  const volumes = closed.map((row) => row.volume);
  const ma5 = smaSeries(closes, 5);
  const ma10 = smaSeries(closes, 10);
  const ma30 = smaSeries(closes, 30);
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macd = closes.map((_, index) =>
    Number.isFinite(ema12[index]) && Number.isFinite(ema26[index])
      ? ema12[index] - ema26[index]
      : null
  );
  const macdSignal = emaSeries(macd, 9);
  const macdHistogram = macd.map((value, index) =>
    Number.isFinite(value) && Number.isFinite(macdSignal[index])
      ? value - macdSignal[index]
      : null
  );
  const rsi = rsiSeries(closes, 14);
  const bollinger = bollingerSeries(closes, 20, 2);
  const tr = trueRangeSeries(closed);
  const atr = wilderSeries(tr, 14);
  const directional = directionalSeries(closed, 14);
  const stochastic = stochasticSeries(closed, 14, 3, 3);
  const obv = obvSeries(closed);
  const rollingVwap = rollingVwapSeries(closed, 20);
  const volumeSma20 = smaSeries(volumes, 20);
  const enhanced = enhancedIndicators(closed);

  const close = closes[closes.length - 1] ?? null;
  const latestAtr = lastFinite(atr);
  const latestBollMiddle = lastFinite(bollinger.middle);
  const latestBollUpper = lastFinite(bollinger.upper);
  const latestBollLower = lastFinite(bollinger.lower);
  const atrPct =
    Number.isFinite(close) && close !== 0 && Number.isFinite(latestAtr)
      ? (latestAtr / close) * 100
      : null;
  const bollWidthPct =
    Number.isFinite(latestBollMiddle) &&
    latestBollMiddle !== 0 &&
    Number.isFinite(latestBollUpper) &&
    Number.isFinite(latestBollLower)
      ? ((latestBollUpper - latestBollLower) / latestBollMiddle) * 100
      : null;
  const latestVolumeAverage = lastFinite(volumeSma20);
  const latestVolume = volumes[volumes.length - 1] ?? null;
  const volumeWindow = volumes.slice(-20);
  const volumeMean =
    volumeWindow.length > 0
      ? volumeWindow.reduce((sum, value) => sum + value, 0) /
        volumeWindow.length
      : null;
  const volumeVariance =
    volumeWindow.length > 0
      ? volumeWindow.reduce(
          (sum, value) => sum + (value - volumeMean) ** 2,
          0
        ) / volumeWindow.length
      : null;
  const volumeDeviation =
    Number.isFinite(volumeVariance) && volumeVariance > 0
      ? Math.sqrt(volumeVariance)
      : null;
  const latestRsi = lastFinite(rsi);
  const latestAdx = lastFinite(directional.adx);
  const latestPlusDi = lastFinite(directional.plusDi);
  const latestMinusDi = lastFinite(directional.minusDi);
  const latestMa5 = lastFinite(ma5);
  const latestMa10 = lastFinite(ma10);
  const latestMa30 = lastFinite(ma30);
  const hasMinimumBars = closed.length >= MIN_ANALYSIS_BARS;
  const regime = hasMinimumBars
    ? regimeFor({
        close,
        ma5: latestMa5,
        ma10: latestMa10,
        ma30: latestMa30,
        adx: latestAdx,
        plusDi: latestPlusDi,
        minusDi: latestMinusDi,
        rsi: latestRsi,
        atrPct,
        bollWidthPct,
      })
    : {
        state: "insufficient_data",
        volatility: "unknown",
        reasons: ["fewer_than_30_closed_candles"],
      };

  const events = hasMinimumBars
    ? [
        ...recentCross(ma5, ma10, closed, 3, "ma5_ma10_cross"),
        ...recentCross(ma10, ma30, closed, 3, "ma10_ma30_cross"),
        ...recentCross(macd, macdSignal, closed, 3, "macd_signal_cross"),
        ...recentCross(
          stochastic.k,
          stochastic.d,
          closed,
          3,
          "stochastic_cross"
        ),
      ]
    : [];
  if (hasMinimumBars && Number.isFinite(latestRsi) && latestRsi >= 70)
    events.push({ name: "rsi_overbought", barsAgo: 0 });
  if (hasMinimumBars && Number.isFinite(latestRsi) && latestRsi <= 30)
    events.push({ name: "rsi_oversold", barsAgo: 0 });
  const volumeRatio =
    Number.isFinite(latestVolume) &&
    Number.isFinite(latestVolumeAverage) &&
    latestVolumeAverage !== 0
      ? latestVolume / latestVolumeAverage
      : null;
  if (hasMinimumBars && Number.isFinite(volumeRatio) && volumeRatio >= 1.5)
    events.push({ name: "elevated_volume", barsAgo: 0 });
  const latestLogReturn = logReturn(closes, 1);
  if (
    hasMinimumBars &&
    Number.isFinite(volumeRatio) &&
    volumeRatio >= 1.5 &&
    Number.isFinite(latestLogReturn) &&
    latestLogReturn !== 0
  )
    events.push({
      name:
        latestLogReturn > 0
          ? "bullish_price_volume_confirmation"
          : "bearish_price_volume_confirmation",
      barsAgo: 0,
    });

  return {
    interval: config.interval,
    source,
    barsRequested: BARS_REQUESTED,
    barsCalculated: closed.length,
    barsReturned: Math.min(BARS_RETURNED, closed.length),
    cacheHit: Boolean(cacheHit),
    formingCandle: forming ? compactCandle(forming.raw) : null,
    candles: closed.slice(-BARS_RETURNED).map((row) => compactCandle(row.raw)),
    indicators: hasMinimumBars
      ? {
          movingAverages: {
            ma5: latestSnapshot(ma5),
            ma10: latestSnapshot(ma10),
            ma30: latestSnapshot(ma30),
            ema12: latestSnapshot(ema12),
            ema26: latestSnapshot(ema26),
          },
          macd: {
            value: rounded(lastFinite(macd)),
            signal: rounded(lastFinite(macdSignal)),
            histogram: rounded(lastFinite(macdHistogram)),
          },
          rsi14: rounded(latestRsi),
          bollinger20: {
            upper: rounded(latestBollUpper),
            middle: rounded(latestBollMiddle),
            lower: rounded(latestBollLower),
            widthPct: rounded(bollWidthPct),
          },
          atr14: {
            value: rounded(latestAtr),
            percentOfPrice: rounded(atrPct),
          },
          adx14: {
            value: rounded(latestAdx),
            plusDi: rounded(latestPlusDi),
            minusDi: rounded(latestMinusDi),
          },
          stochastic1433: {
            k: rounded(lastFinite(stochastic.k)),
            d: rounded(lastFinite(stochastic.d)),
          },
          obv: latestSnapshot(obv),
          rollingVwap20: latestSnapshot(rollingVwap),
          returns: {
            log1: rounded(logReturn(closes, 1)),
            log5: rounded(logReturn(closes, 5)),
            log20: rounded(logReturn(closes, 20)),
          },
          realizedVolatility20Annualized: rounded(
            realizedVolatility(closes, 20, config.barsPerYear)
          ),
          maximumDrawdown30: rounded(maximumDrawdown(closes, 30)),
          volume: {
            latest: rounded(latestVolume),
            sma20: rounded(latestVolumeAverage),
            ratioToSma20: rounded(volumeRatio),
            zScore20:
              Number.isFinite(latestVolume) &&
              Number.isFinite(volumeMean) &&
              Number.isFinite(volumeDeviation) &&
              volumeDeviation !== 0
                ? rounded((latestVolume - volumeMean) / volumeDeviation)
                : null,
          },
          ...enhanced,
          shortTermSlopes: {
            close3Pct: rounded(slopePercent(closes, 3)),
            macdHistogram3Change: rounded(slopeDelta(macdHistogram, 3)),
            rsi14_3Change: rounded(slopeDelta(rsi, 3)),
            atr14_3Pct: rounded(slopePercent(atr, 3)),
            adx14_3Change: rounded(slopeDelta(directional.adx, 3)),
          },
        }
      : null,
    levels: rollingLevels(closed),
    events,
    regime,
    dataQuality: {
      status:
        closed.length >= COMPLETE_TIMEFRAME_BARS
          ? "complete"
          : closed.length >= MIN_ANALYSIS_BARS
            ? "partial"
            : "insufficient",
      minimumBarsRequired: MIN_ANALYSIS_BARS,
      reason: hasMinimumBars ? null : "fewer_than_30_closed_candles",
      gapCount: gapCount(closed, config.intervalMs),
      oldestClosedTimestampMs: closed[0]?.ts || null,
      newestClosedTimestampMs: closed[closed.length - 1]?.ts || null,
      calculationInput: {
        closedCandlesUsed: closed.length,
        formingCandleExcluded: Boolean(forming),
        digestAlgorithm: "sha256",
        digestCanonicalization:
          "timestamp-open-high-low-close-volume-strings-v1",
        closedCandlesSha256: closedCandlesSha256(closed),
      },
    },
  };
}

function targetLevels(values = []) {
  return [
    ...new Set(values.filter(Number.isFinite).map((value) => rounded(value))),
  ];
}

function confirmationCheck({ id, actual, operator, threshold, sourcePath }) {
  let met = false;
  if (Number.isFinite(actual) && Number.isFinite(threshold)) {
    if (operator === ">") met = actual > threshold;
    else if (operator === "<") met = actual < threshold;
    else if (operator === ">=") met = actual >= threshold;
    else if (operator === "<=") met = actual <= threshold;
  }
  return {
    id,
    met,
    actual: rounded(actual),
    operator,
    threshold: rounded(threshold),
    sourcePath,
  };
}

function rangeConfirmationCheck({ id, actual, lower, upper, sourcePath }) {
  return {
    id,
    met:
      Number.isFinite(actual) &&
      Number.isFinite(lower) &&
      Number.isFinite(upper) &&
      actual >= lower &&
      actual <= upper,
    actual: rounded(actual),
    operator: "between_inclusive",
    lower: rounded(lower),
    upper: rounded(upper),
    sourcePath,
  };
}

function fibonacciTargetEntries(fibonacci = {}, close, direction) {
  const candidates = [
    ...Object.entries(fibonacci.retracements || {}).map(([ratio, value]) => ({
      value,
      basis: `daily_fibonacci_retracement_${ratio}`,
      sourcePath: `timeframes.1d.levels.fibonacci.retracements.${ratio}`,
    })),
    ...Object.entries(fibonacci.extensions || {}).map(([ratio, value]) => ({
      value,
      basis: `daily_fibonacci_extension_${ratio}`,
      sourcePath: `timeframes.1d.levels.fibonacci.extensions.${ratio}`,
    })),
    {
      value: fibonacci.swing?.startPrice,
      basis: "daily_fibonacci_swing_start",
      sourcePath: "timeframes.1d.levels.fibonacci.swing.startPrice",
    },
    {
      value: fibonacci.swing?.endPrice,
      basis: "daily_fibonacci_swing_end",
      sourcePath: "timeframes.1d.levels.fibonacci.swing.endPrice",
    },
  ].filter(({ value }) => Number.isFinite(value));
  return candidates
    .filter(({ value }) =>
      direction === "above" ? value > close : value < close
    )
    .sort((left, right) =>
      direction === "above"
        ? left.value - right.value
        : right.value - left.value
    );
}

function structuredTargets(entries = []) {
  const seen = new Set();
  return entries
    .filter(({ value }) => Number.isFinite(value))
    .map((entry) => ({ ...entry, value: rounded(entry.value) }))
    .filter(({ value }) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function buildConfluence(timeframes) {
  const availableEntries = Object.entries(timeframes).filter(
    ([, timeframe]) => timeframe?.dataQuality?.status !== "insufficient"
  );
  const groups = {
    bullish: [],
    bearish: [],
    range: [],
    volatile: [],
    mixed: [],
  };
  for (const [id, timeframe] of availableEntries) {
    const state = timeframe.regime?.state;
    if (state === "bullish_trend") groups.bullish.push(id);
    else if (state === "bearish_trend") groups.bearish.push(id);
    else if (state === "range") groups.range.push(id);
    else if (state === "volatile") groups.volatile.push(id);
    else groups.mixed.push(id);
  }

  let state = "mixed";
  if (groups.bullish.length >= 3 && groups.bullish.includes("1d"))
    state = "bullish_alignment";
  else if (groups.bearish.length >= 3 && groups.bearish.includes("1d"))
    state = "bearish_alignment";
  else if (groups.range.length >= 2 && groups.range.includes("1d"))
    state = "range_alignment";

  const available =
    availableEntries.length >= 3 &&
    availableEntries.some(([id]) => id === "1d");
  return {
    status: available ? "available" : "unavailable",
    state: available ? state : "insufficient_data",
    availableTimeframes: availableEntries.map(([id]) => id),
    ...groups,
  };
}

function buildScenarios(timeframes, confluence) {
  if (confluence.status !== "available") return [];
  const daily = timeframes["1d"];
  const resistance20 = daily?.levels?.previous20?.resistance;
  const resistance50 = daily?.levels?.previous50?.resistance;
  const support20 = daily?.levels?.previous20?.support;
  const support50 = daily?.levels?.previous50?.support;
  const atr = daily?.indicators?.atr14?.value;
  const close = finite(daily?.candles?.[daily.candles.length - 1]?.[4]);
  if (![resistance20, support20, atr, close].every(Number.isFinite)) return [];
  const fibonacci = daily?.levels?.fibonacci;
  const fibonacciAbove = fibonacciTargetEntries(fibonacci, close, "above");
  const fibonacciBelow = fibonacciTargetEntries(fibonacci, close, "below");
  const dailyMacdHistogram = daily?.indicators?.macd?.histogram;
  const dailyVolumeRatio = daily?.indicators?.volume?.ratioToSma20;
  const dailyAdx = daily?.indicators?.adx14?.value;
  const bullishConfirmations = [
    confirmationCheck({
      id: "daily_macd_histogram_positive",
      actual: dailyMacdHistogram,
      operator: ">",
      threshold: 0,
      sourcePath: "timeframes.1d.indicators.macd.histogram",
    }),
    confirmationCheck({
      id: "at_least_two_bullish_timeframes",
      actual: confluence.bullish.length,
      operator: ">=",
      threshold: 2,
      sourcePath: "confluence.bullish.length",
    }),
    confirmationCheck({
      id: "volume_ratio_above_one",
      actual: dailyVolumeRatio,
      operator: ">",
      threshold: 1,
      sourcePath: "timeframes.1d.indicators.volume.ratioToSma20",
    }),
  ];
  const bearishConfirmations = [
    confirmationCheck({
      id: "daily_macd_histogram_negative",
      actual: dailyMacdHistogram,
      operator: "<",
      threshold: 0,
      sourcePath: "timeframes.1d.indicators.macd.histogram",
    }),
    confirmationCheck({
      id: "at_least_two_bearish_timeframes",
      actual: confluence.bearish.length,
      operator: ">=",
      threshold: 2,
      sourcePath: "confluence.bearish.length",
    }),
    confirmationCheck({
      id: "volume_ratio_above_one",
      actual: dailyVolumeRatio,
      operator: ">",
      threshold: 1,
      sourcePath: "timeframes.1d.indicators.volume.ratioToSma20",
    }),
  ];
  const bullishTargets = structuredTargets([
    {
      value: resistance50,
      basis: "daily_previous50_resistance",
      sourcePath: "timeframes.1d.levels.previous50.resistance",
    },
    {
      value: resistance20 + atr,
      basis: "daily_previous20_resistance_plus_atr14",
      sourcePath:
        "timeframes.1d.levels.previous20.resistance+timeframes.1d.indicators.atr14.value",
    },
    ...fibonacciAbove.slice(0, 2),
  ]);
  const bearishTargets = structuredTargets([
    {
      value: support50,
      basis: "daily_previous50_support",
      sourcePath: "timeframes.1d.levels.previous50.support",
    },
    {
      value: support20 - atr,
      basis: "daily_previous20_support_minus_atr14",
      sourcePath:
        "timeframes.1d.levels.previous20.support-timeframes.1d.indicators.atr14.value",
    },
    ...fibonacciBelow.slice(0, 2),
  ]);

  return [
    {
      id: "bullish_breakout",
      status: close > resistance20 ? "triggered" : "conditional",
      triggerMet: close > resistance20,
      trigger: { type: "daily_close_above", value: resistance20 },
      confirmations: bullishConfirmations.map(({ id }) => id),
      confirmationChecks: bullishConfirmations,
      confirmed:
        close > resistance20 && bullishConfirmations.every(({ met }) => met),
      targetLevels: targetLevels(bullishTargets.map(({ value }) => value)),
      targets: bullishTargets,
      invalidation: {
        type: "daily_close_below",
        value: rounded(resistance20 - atr),
        sourcePath:
          "timeframes.1d.levels.previous20.resistance-timeframes.1d.indicators.atr14.value",
      },
    },
    {
      id: "bearish_breakdown",
      status: close < support20 ? "triggered" : "conditional",
      triggerMet: close < support20,
      trigger: { type: "daily_close_below", value: support20 },
      confirmations: bearishConfirmations.map(({ id }) => id),
      confirmationChecks: bearishConfirmations,
      confirmed:
        close < support20 && bearishConfirmations.every(({ met }) => met),
      targetLevels: targetLevels(bearishTargets.map(({ value }) => value)),
      targets: bearishTargets,
      invalidation: {
        type: "daily_close_above",
        value: rounded(support20 + atr),
        sourcePath:
          "timeframes.1d.levels.previous20.support+timeframes.1d.indicators.atr14.value",
      },
    },
    {
      id: "range_continuation",
      status:
        close >= support20 && close <= resistance20 ? "active" : "conditional",
      triggerMet: close >= support20 && close <= resistance20,
      range: { lower: support20, upper: resistance20 },
      confirmation: "daily_adx_below_20",
      confirmationChecks: [
        confirmationCheck({
          id: "daily_adx_below_20",
          actual: dailyAdx,
          operator: "<",
          threshold: 20,
          sourcePath: "timeframes.1d.indicators.adx14.value",
        }),
        rangeConfirmationCheck({
          id: "daily_close_inside_previous20_range",
          actual: close,
          lower: support20,
          upper: resistance20,
          sourcePath: "timeframes.1d.candles.latest.close",
        }),
      ],
      confirmed:
        Number.isFinite(dailyAdx) &&
        dailyAdx < 20 &&
        close >= support20 &&
        close <= resistance20,
      invalidation: {
        type: "daily_close_outside_range",
        lower: rounded(support20 - atr),
        upper: rounded(resistance20 + atr),
        sourcePath:
          "timeframes.1d.levels.previous20+timeframes.1d.indicators.atr14.value",
      },
    },
  ];
}

function analysisStatus(timeframes) {
  const values = Object.values(timeframes);
  const participating = values.filter(
    (timeframe) => timeframe?.dataQuality?.status !== "insufficient"
  );
  if (!participating.length) return "unavailable";
  if (
    values.length === Object.keys(TIMEFRAME_CONFIG).length &&
    values.every(
      (timeframe) => timeframe?.barsCalculated >= COMPLETE_TIMEFRAME_BARS
    )
  )
    return "complete";
  return "partial";
}

function enforcePayloadBudget(result, maxBytes = MAX_ANALYSIS_PAYLOAD_BYTES) {
  let serializedBytes = Buffer.byteLength(JSON.stringify(result));
  let truncated = false;
  while (serializedBytes > maxBytes) {
    const candidates = Object.entries(result.timeframes || {})
      .filter(([, timeframe]) => (timeframe?.candles?.length || 0) > 30)
      .sort((left, right) => right[1].candles.length - left[1].candles.length);
    if (!candidates.length) break;
    const [, timeframe] = candidates[0];
    timeframe.candles.splice(0, Math.min(10, timeframe.candles.length - 30));
    timeframe.barsReturned = timeframe.candles.length;
    truncated = true;
    serializedBytes = Buffer.byteLength(JSON.stringify(result));
  }
  result.payload = {
    maxBytes,
    serializedBytes,
    truncated,
  };
  return result;
}

function buildQuantAnalysis({
  timeframePayloads = {},
  now = Date.now(),
  partialFailures = [],
  marketEvidence = {},
  relativeStrengthByTimeframe = {},
}) {
  const timeframes = {};
  for (const id of Object.keys(TIMEFRAME_CONFIG)) {
    const payload = timeframePayloads[id];
    if (!payload?.candles) continue;
    timeframes[id] = analyzeTimeframe({
      id,
      candles: payload.candles,
      now,
      cacheHit: payload.cacheHit,
      source: payload.source || "gate",
    });
  }
  const confluence = buildConfluence(timeframes);
  const scenarios = buildScenarios(timeframes, confluence);
  const supportingEvidence = buildSupportingEvidence({
    timeframes,
    confluence,
    scenarios,
    marketEvidence,
    relativeStrengthByTimeframe,
  });
  const result = {
    formulaVersion: FORMULA_VERSION,
    analysisStatus: analysisStatus(timeframes),
    candleSchema: ["timestampMs", "open", "high", "low", "close", "volume"],
    timeframes,
    confluence,
    scenarios,
    supportingEvidence,
    partialFailures,
  };
  return enforcePayloadBudget(result);
}

function relation(left, right) {
  if (!Number.isFinite(Number(left)) || !Number.isFinite(Number(right)))
    return "unavailable";
  if (Number(left) > Number(right)) return "above";
  if (Number(left) < Number(right)) return "below";
  return "equal";
}

function compactIndicatorView(indicators = null, currentClose = null) {
  if (!indicators) return null;
  const movingAverages = Object.fromEntries(
    Object.entries(indicators.movingAverages || {}).map(([id, value]) => [
      id,
      value?.value ?? null,
    ])
  );
  const ma5VsMa10 = relation(movingAverages.ma5, movingAverages.ma10);
  const ma10VsMa30 = relation(movingAverages.ma10, movingAverages.ma30);
  const flow = indicators.moneyFlow || {};
  const structure = indicators.trendStructure || {};
  const pivots = structure.pivots || {};
  return {
    ma: {
      ...movingAverages,
      relations: {
        ma5VsMa10,
        ma10VsMa30,
        alignment:
          ma5VsMa10 === "above" && ma10VsMa30 === "above"
            ? "bullish"
            : ma5VsMa10 === "below" && ma10VsMa30 === "below"
              ? "bearish"
              : "mixed",
        closeVsMa5: relation(currentClose, movingAverages.ma5),
        closeVsMa10: relation(currentClose, movingAverages.ma10),
        closeVsMa30: relation(currentClose, movingAverages.ma30),
        ema12VsEma26: relation(movingAverages.ema12, movingAverages.ema26),
      },
    },
    macd: {
      ...indicators.macd,
      relations: {
        histogramSign:
          Number(indicators.macd?.histogram) > 0
            ? "positive"
            : Number(indicators.macd?.histogram) < 0
              ? "negative"
              : Number(indicators.macd?.histogram) === 0
                ? "zero"
                : "unavailable",
        valueVsSignal: relation(
          indicators.macd?.value,
          indicators.macd?.signal
        ),
      },
    },
    rsi14: indicators.rsi14,
    atr14: indicators.atr14,
    adx14: indicators.adx14,
    volume: {
      ratioToSma20: indicators.volume?.ratioToSma20 ?? null,
      zScore20: indicators.volume?.zScore20 ?? null,
    },
    moneyFlow: {
      cmf20: flow.cmf20 ?? null,
      cmf20Slope3: flow.cmf20Slope3 ?? null,
      mfi14: flow.mfi14 ?? null,
      accumulationDistributionSlope:
        flow.accumulationDistribution?.shortTermSlope?.normalizedByVolume ??
        null,
    },
    trendStructure: {
      regressionSlopePctPerBar:
        structure.linearRegression20?.slopePctPerBar ?? null,
      regressionR2: structure.linearRegression20?.rSquared ?? null,
      efficiencyRatio20: structure.efficiencyRatio20 ?? null,
      pivots: {
        state: pivots.state || "insufficient",
        highState: pivots.highState || "insufficient",
        lowState: pivots.lowState || "insufficient",
      },
    },
    relativeStrength: indicators.relativeStrength,
  };
}

function compactLevelsView(levels = {}, currentClose = null) {
  const fibonacci = levels.fibonacci || {};
  const below = fibonacci.nearestBelow ?? null;
  const above = fibonacci.nearestAbove ?? null;
  const position =
    Number.isFinite(Number(currentClose)) && Number.isFinite(Number(below))
      ? Number.isFinite(Number(above))
        ? "between_nearest_levels"
        : "above_all_levels"
      : Number.isFinite(Number(currentClose)) && Number.isFinite(Number(above))
        ? "below_all_levels"
        : "unavailable";
  return {
    prev20: levels.previous20,
    prev50: levels.previous50,
    fib: {
      status: fibonacci.status,
      lookback: fibonacci.lookback,
      direction: fibonacci.direction,
      swing: fibonacci.swing
        ? {
            start: fibonacci.swing.startPrice,
            end: fibonacci.swing.endPrice,
            range: fibonacci.swing.range,
          }
        : null,
      currentPosition: {
        close: Number.isFinite(Number(currentClose))
          ? Number(currentClose)
          : null,
        relation: position,
        below,
        above,
      },
    },
  };
}

function compactSnapshotView(snapshot = {}) {
  const compactSource = (source = null) =>
    source
      ? {
          ok: source.ok,
          exchange: source.exchange,
          pair: source.pair,
          price: source.price,
          volume24h: source.volume_24h,
          quoteVolume24h: source.quote_volume_24h,
          high24h: source.high_24h,
          low24h: source.low_24h,
          changePercent: source.change_percent,
          error: source.error,
        }
      : null;
  return {
    gate: compactSource(snapshot.sources?.gate),
    binance: compactSource(snapshot.sources?.binance),
    comparison: snapshot.comparison,
    sourceSelection: snapshot.exchange_mode,
  };
}

function compactSourcePath(value = "") {
  return String(value || "")
    .replaceAll("timeframes.1d.", "1d.")
    .replaceAll("indicators.", "ind.")
    .replaceAll("levels.", "lvl.")
    .replaceAll("previous20", "prev20")
    .replaceAll("previous50", "prev50")
    .replaceAll("fibonacci.", "fib.")
    .replaceAll("confluence.", "conf.");
}

function compactSupportingEvidenceView(evidence = {}) {
  const micro = evidence.spotMicrostructure || {};
  const derivatives = evidence.derivatives || {};
  const compactWindow = (window = null) =>
    window
      ? {
          status: window.status,
          tradeCount: window.tradeCount,
          takerBuyRatio: window.takerBuyRatio,
          cumulativeVolumeDelta: window.cumulativeVolumeDelta,
          sampleCount: window.sampleCount,
          imbalance25bps: window.depth?.["25bps"]?.imbalanceMedian,
          positiveSampleRatio25bps:
            window.depth?.["25bps"]?.positiveSampleRatio,
          negativeSampleRatio25bps:
            window.depth?.["25bps"]?.negativeSampleRatio,
        }
      : null;
  return {
    formulaVersion: evidence.formulaVersion,
    status: evidence.status,
    spotMicrostructure: {
      status: micro.status,
      orderBookSynchronized: micro.orderBook?.synchronized,
      tradeFlow5m: compactWindow(micro.tradeFlow?.windows?.["5m"]),
      tradeFlow15m: compactWindow(micro.tradeFlow?.windows?.["15m"]),
      orderBook5m: compactWindow(micro.orderBook?.windows?.["5m"]),
    },
    derivatives: {
      status: derivatives.status,
      reason: derivatives.reason,
      market: {
        markVsSpotBasisPct: derivatives.market?.markVsSpotBasisPct,
        markVsIndexPremiumPct: derivatives.market?.markVsIndexPremiumPct,
      },
      openInterest: {
        currentUsd: derivatives.openInterest?.currentUsd,
        changePct: derivatives.openInterest?.changePct,
      },
      funding: {
        latestRate: derivatives.funding?.latestRate,
        zScore30: derivatives.funding?.zScore30,
        sampleCount: derivatives.funding?.sampleCount,
      },
      positioning: {
        takerLongShortRatio: derivatives.positioning?.takerLongShortRatio,
        accountLongShortRatio: derivatives.positioning?.accountLongShortRatio,
      },
      liquidations4h: {
        longLiquidationUsd:
          derivatives.liquidations?.["4h"]?.longLiquidationUsd,
        shortLiquidationUsd:
          derivatives.liquidations?.["4h"]?.shortLiquidationUsd,
      },
      dataQuality: {
        statsSampleCount: derivatives.dataQuality?.statsSampleCount,
        newestStatsTimestampMs: derivatives.dataQuality?.newestStatsTimestampMs,
      },
    },
    scenarioVerdicts: (evidence.scenarioVerdicts || []).map((verdict) => ({
      scenarioId: verdict.scenarioId,
      supportVerdict: verdict.supportVerdict,
      supportingFamilies: verdict.supportingFamilies,
      conflictingFamilies: verdict.conflictingFamilies,
      families: (verdict.families || []).map((family) => ({
        family: family.family,
        state: family.state,
      })),
    })),
  };
}

function buildModelAnalysisView(result = {}, toolRun = null) {
  const timeframes = Object.fromEntries(
    Object.entries(result.timeframes || {}).map(([id, timeframe]) => {
      const latestClosed =
        timeframe.candles?.[timeframe.candles.length - 1] || null;
      return [
        id,
        {
          latestClosedCandle: latestClosed
            ? {
                close: latestClosed[4],
                timing: "latest_closed_bar",
              }
            : null,
          formingCandle: timeframe.formingCandle
            ? {
                close: timeframe.formingCandle[4],
                excludedFromIndicators: true,
                timing: "current_unclosed_bar",
              }
            : null,
          regime: timeframe.regime,
          indicators: compactIndicatorView(
            timeframe.indicators,
            Number(latestClosed?.[4])
          ),
          levels: compactLevelsView(
            timeframe.levels,
            Number(latestClosed?.[4])
          ),
          events: (timeframe.events || [])
            .slice(-3)
            .map(({ name, barsAgo }) => ({
              name,
              closedBarsAgo: barsAgo,
              timing:
                barsAgo === 0
                  ? "latest_closed_bar"
                  : `${barsAgo}_closed_bars_ago`,
            })),
          dataQuality: {
            status: timeframe.dataQuality?.status,
            reason: timeframe.dataQuality?.reason,
            calculationInput: {
              barsUsed:
                timeframe.dataQuality?.calculationInput?.closedCandlesUsed,
              closedCandlesSha256:
                timeframe.dataQuality?.calculationInput?.closedCandlesSha256,
            },
          },
        },
      ];
    })
  );
  const monitoringSignalId = (scenarioId) =>
    ({
      bullish_breakout: "upper_breakout_condition",
      bearish_breakdown: "lower_breakdown_condition",
      range_continuation: "range_condition",
    })[scenarioId] || "market_condition";
  const supportingEvidence = compactSupportingEvidenceView(
    result.supportingEvidence
  );
  const monitoringSignals = (result.scenarios || []).map((scenario) => {
    const verdict = supportingEvidence.scenarioVerdicts?.find(
      ({ scenarioId }) => scenarioId === scenario.id
    );
    return {
      id: monitoringSignalId(scenario.id),
      observed: scenario.triggerMet === true,
      confirmedByClosedData: scenario.confirmed === true,
      supportVerdict: verdict?.supportVerdict || "insufficient",
      confirmationChecks: (scenario.confirmationChecks || []).map(
        ({ sourcePath, ...check }) => ({
          ...check,
          source: compactSourcePath(sourcePath),
        })
      ),
    };
  });
  if (supportingEvidence.scenarioVerdicts)
    supportingEvidence.monitoringSignalVerdicts =
      supportingEvidence.scenarioVerdicts.map(({ scenarioId, ...verdict }) => ({
        ...verdict,
        monitoringSignalId: monitoringSignalId(scenarioId),
      }));
  delete supportingEvidence.scenarioVerdicts;
  return {
    tool: result.tool,
    mode: result.mode,
    symbol: result.symbol,
    quote: result.quote,
    timestamp: result.timestamp,
    formulaVersion: result.formulaVersion,
    analysisStatus: result.analysisStatus,
    analysisPolicy: result.analysisPolicy,
    interpretationContract: {
      mandatory: true,
      rules: [
        "This is monitoring-only; never output a future direction, directional probability, return target, price target, trade instruction, or investment recommendation.",
        "regime.state describes already-closed data exactly and is not a forecast; formingCandle is excluded.",
        "Monitoring signals are observed event conditions; only confirmedByClosedData=true confirms one.",
        "Use fib.currentPosition; Fibonacci levels have no implied support/resistance role.",
        "Do not invent values, probabilities, failures, divergence, crossovers, causality, or calendar timing.",
        "MA/MACD comparisons must match relations; crossovers require an events entry.",
        "Event timing is closed-bar-relative, never calendar-relative.",
        "Volume, OBV, supporting evidence, and derivatives cannot identify institutions or create a price direction.",
        "Disclose source degradation and supportVerdict conflicts.",
        "Forecast research status and hashes are provenance only; prediction outputs are intentionally redacted.",
      ],
      requiredCoverage: {
        timeframeIds: Object.keys(timeframes),
        monitoringSignalIds: monitoringSignals.map(({ id }) => id),
        includeEveryObservedCondition: true,
        distinguishObservedFromClosedDataConfirmation: true,
      },
    },
    snapshot: compactSnapshotView(result.snapshot),
    sourceQuality: result.sourceQuality,
    timeframes,
    supportingEvidence,
    forecasting: result.forecasting || null,
    monitoringSignals,
    partialFailures: result.partialFailures,
    provenance: {
      fullToolRunId: toolRun?.runId || null,
      fullResultSha256: toolRun?.resultSha256 || null,
      fullResultStored: toolRun?.stored ?? null,
    },
  };
}

module.exports = {
  BARS_REQUESTED,
  BARS_RETURNED,
  COMPLETE_TIMEFRAME_BARS,
  FORMULA_VERSION,
  MAX_ANALYSIS_PAYLOAD_BYTES,
  MIN_ANALYSIS_BARS,
  TIMEFRAME_CONFIG,
  _internals: {
    bollingerSeries,
    directionalSeries,
    emaSeries,
    maximumDrawdown,
    realizedVolatility,
    rsiSeries,
    smaSeries,
    slopeDelta,
    splitClosedRows,
    stochasticSeries,
    fibonacciLevels,
  },
  analyzeTimeframe,
  buildModelAnalysisView,
  buildQuantAnalysis,
  enforcePayloadBudget,
};
