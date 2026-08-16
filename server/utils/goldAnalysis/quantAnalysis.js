const crypto = require("node:crypto");
const {
  FORMULA_VERSION,
  MAX_PAYLOAD_BYTES,
  RESULT_SCHEMA,
  RESULT_SCHEMA_VERSION,
  TIMEFRAMES,
  TOOL_NAME,
} = require("./constants");
const {
  FACTOR_REGISTRY,
  FACTOR_REGISTRY_SHA256,
  canonicalJson,
  sha256,
} = require("./contracts");

const OUNCE_GRAMS = 31.1034768;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value, digits = 8) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function mean(values = []) {
  const usable = values.filter(Number.isFinite);
  return usable.length
    ? usable.reduce((sum, value) => sum + value, 0) / usable.length
    : null;
}

function standardDeviation(values = []) {
  const average = mean(values);
  if (average === null || values.length < 2) return null;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length
  );
}

function zscore(value, history = []) {
  const usable = history.filter(Number.isFinite);
  const average = mean(usable);
  const deviation = standardDeviation(usable);
  return average === null || !deviation ? null : (value - average) / deviation;
}

function normalizedBars(bars = []) {
  const byOpen = new Map();
  for (const bar of bars) {
    const openTimeMs = finite(bar.openTimeMs);
    const closeTimeMs = finite(bar.closeTimeMs);
    const open = finite(bar.open);
    const high = finite(bar.high);
    const low = finite(bar.low);
    const close = finite(bar.close);
    const volume = finite(bar.volume);
    if (
      [openTimeMs, closeTimeMs, open, high, low, close].some(
        (item) => item === null
      ) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0
    )
      continue;
    byOpen.set(openTimeMs, {
      openTimeMs,
      closeTimeMs,
      open,
      high,
      low,
      close,
      volume,
      source: bar.source || "unknown",
      interval: bar.interval || null,
      forming: Boolean(bar.forming),
    });
  }
  return [...byOpen.values()].sort(
    (left, right) => left.openTimeMs - right.openTimeMs
  );
}

function closedBars(bars, now = Date.now()) {
  return normalizedBars(bars).filter(
    (bar) => !bar.forming && bar.closeTimeMs <= now
  );
}

function aggregateBars(bars, intervalMs, interval) {
  const groups = new Map();
  for (const bar of normalizedBars(bars)) {
    const openTimeMs = Math.floor(bar.openTimeMs / intervalMs) * intervalMs;
    const existing = groups.get(openTimeMs);
    if (!existing) {
      groups.set(openTimeMs, {
        ...bar,
        openTimeMs,
        closeTimeMs: openTimeMs + intervalMs,
        interval,
      });
      continue;
    }
    existing.high = Math.max(existing.high, bar.high);
    existing.low = Math.min(existing.low, bar.low);
    existing.close = bar.close;
    existing.volume =
      existing.volume === null || bar.volume === null
        ? null
        : existing.volume + bar.volume;
    existing.forming ||= bar.forming;
  }
  return [...groups.values()].sort(
    (left, right) => left.openTimeMs - right.openTimeMs
  );
}

function mondayStart(timestamp) {
  const date = new Date(timestamp);
  const day = date.getUTCDay() || 7;
  return (
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
    (day - 1) * 24 * 60 * 60 * 1_000
  );
}

function aggregateNaturalWeeks(bars) {
  const groups = new Map();
  for (const bar of normalizedBars(bars)) {
    const openTimeMs = mondayStart(bar.openTimeMs);
    const existing = groups.get(openTimeMs);
    if (!existing) {
      groups.set(openTimeMs, {
        ...bar,
        openTimeMs,
        closeTimeMs: openTimeMs + 7 * 24 * 60 * 60 * 1_000,
        interval: "1w",
      });
      continue;
    }
    existing.high = Math.max(existing.high, bar.high);
    existing.low = Math.min(existing.low, bar.low);
    existing.close = bar.close;
    existing.volume =
      existing.volume === null || bar.volume === null
        ? null
        : existing.volume + bar.volume;
    existing.forming ||= bar.forming;
  }
  return [...groups.values()].sort(
    (left, right) => left.openTimeMs - right.openTimeMs
  );
}

function sma(values, period) {
  if (values.length < period) return null;
  return mean(values.slice(-period));
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const alpha = 2 / (period + 1);
  const result = Array(values.length).fill(null);
  let current = mean(values.slice(0, period));
  result[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = values[index] * alpha + current * (1 - alpha);
    result[index] = current;
  }
  return result;
}

function lastFinite(values = []) {
  for (let index = values.length - 1; index >= 0; index -= 1)
    if (Number.isFinite(values[index])) return values[index];
  return null;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  gain /= period;
  loss /= period;
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

function macd(values) {
  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);
  const line = values.map((_, index) =>
    Number.isFinite(ema12[index]) && Number.isFinite(ema26[index])
      ? ema12[index] - ema26[index]
      : null
  );
  const compact = line.filter(Number.isFinite);
  const signalCompact = emaSeries(compact, 9);
  const lineValue = lastFinite(line);
  const signal = lastFinite(signalCompact);
  return {
    line: rounded(lineValue),
    signal: rounded(signal),
    histogram:
      lineValue === null || signal === null
        ? null
        : rounded(lineValue - signal),
  };
}

function trueRanges(bars) {
  return bars.map((bar, index) => {
    if (!index) return bar.high - bar.low;
    const previousClose = bars[index - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose)
    );
  });
}

function wilder(values, period) {
  if (values.length < period) return null;
  let current = mean(values.slice(0, period));
  for (let index = period; index < values.length; index += 1)
    current = (current * (period - 1) + values[index]) / period;
  return current;
}

function adx(bars, period = 14) {
  if (bars.length <= period * 2) return null;
  const tr = trueRanges(bars);
  const plus = [0];
  const minus = [0];
  for (let index = 1; index < bars.length; index += 1) {
    const up = bars[index].high - bars[index - 1].high;
    const down = bars[index - 1].low - bars[index].low;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  const dx = [];
  for (let end = period; end <= bars.length; end += 1) {
    const atrValue = wilder(tr.slice(0, end), period);
    const plusDi = atrValue
      ? (100 * wilder(plus.slice(0, end), period)) / atrValue
      : null;
    const minusDi = atrValue
      ? (100 * wilder(minus.slice(0, end), period)) / atrValue
      : null;
    if (
      Number.isFinite(plusDi) &&
      Number.isFinite(minusDi) &&
      plusDi + minusDi > 0
    )
      dx.push((100 * Math.abs(plusDi - minusDi)) / (plusDi + minusDi));
  }
  return rounded(wilder(dx, period));
}

function bollinger(values, period = 20, multiplier = 2) {
  if (values.length < period) return null;
  const selected = values.slice(-period);
  const middle = mean(selected);
  const deviation = standardDeviation(selected);
  const latest = values.at(-1);
  return {
    middle: rounded(middle),
    upper: rounded(middle + multiplier * deviation),
    lower: rounded(middle - multiplier * deviation),
    zscore: deviation ? rounded((latest - middle) / deviation) : 0,
  };
}

function donchian(bars, period = 20) {
  if (bars.length <= period) return null;
  const reference = bars.slice(-(period + 1), -1);
  const high = Math.max(...reference.map((bar) => bar.high));
  const low = Math.min(...reference.map((bar) => bar.low));
  const current = bars.at(-1).close;
  return {
    high: rounded(high),
    low: rounded(low),
    position: high === low ? null : rounded((current - low) / (high - low), 6),
    upperBreakout: current > high,
    lowerBreakdown: current < low,
  };
}

function parkinson(bars) {
  const selected = bars.slice(-20).filter((bar) => bar.high > 0 && bar.low > 0);
  if (!selected.length) return null;
  return Math.sqrt(
    selected.reduce((sum, bar) => sum + Math.log(bar.high / bar.low) ** 2, 0) /
      (4 * Math.log(2) * selected.length)
  );
}

function compactBar(bar) {
  return [
    String(bar.openTimeMs),
    String(bar.open),
    String(bar.high),
    String(bar.low),
    String(bar.close),
    bar.volume === null ? null : String(bar.volume),
  ];
}

function analyzeTimeframe(id, bars) {
  const closes = bars.map((bar) => bar.close);
  const latest = bars.at(-1);
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma30 = sma(closes, 30);
  const macdValue = macd(closes);
  const atr14 = wilder(trueRanges(bars), 14);
  const adx14 = adx(bars);
  const channel = donchian(bars);
  const state =
    !latest || ma20 === null || macdValue.histogram === null
      ? "insufficient"
      : latest.close > ma20 && macdValue.histogram > 0
        ? adx14 !== null && adx14 >= 25
          ? "rising_trend"
          : "rising_bias"
        : latest.close < ma20 && macdValue.histogram < 0
          ? adx14 !== null && adx14 >= 25
            ? "falling_trend"
            : "falling_bias"
          : "range_or_mixed";
  return {
    timeframe: id,
    source: latest?.source || "unavailable",
    status: bars.length >= 30 ? "complete" : "insufficient",
    closedBarsUsed: bars.length,
    latestClosedAtMs: latest?.closeTimeMs || null,
    candles: bars.slice(-120).map(compactBar),
    volumeAvailability: bars.some((bar) => bar.volume !== null)
      ? "provider_volume"
      : "unavailable_no_central_xau_volume",
    indicators: {
      return1:
        closes.length > 1
          ? rounded(Math.log(closes.at(-1) / closes.at(-2)))
          : null,
      momentum5:
        closes.length > 5
          ? rounded(Math.log(closes.at(-1) / closes.at(-6)))
          : null,
      momentum20:
        closes.length > 20
          ? rounded(Math.log(closes.at(-1) / closes.at(-21)))
          : null,
      movingAverages: {
        sma5: rounded(ma5),
        sma20: rounded(ma20),
        sma30: rounded(ma30),
        gap20: ma20 ? rounded(latest.close / ma20 - 1) : null,
        ema12: rounded(lastFinite(emaSeries(closes, 12))),
        ema26: rounded(lastFinite(emaSeries(closes, 26))),
      },
      rsi14: rounded(rsi(closes, 14)),
      macd: macdValue,
      atr14: rounded(atr14),
      adx14,
      bollinger20: bollinger(closes),
      donchian20: channel,
      parkinson20: rounded(parkinson(bars)),
    },
    observedState: state,
  };
}

function dailyRealizedVolatility(hourlyBars) {
  const groups = new Map();
  for (const bar of hourlyBars) {
    const day = new Date(bar.closeTimeMs).toISOString().slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(bar);
  }
  const days = [];
  for (const [day, bars] of groups) {
    if (bars.length < 6) continue;
    const returns = bars
      .slice(1)
      .map((bar, index) => Math.log(bar.close / bars[index].close));
    const rv = returns.reduce((sum, value) => sum + value ** 2, 0);
    const downside = returns
      .filter((value) => value < 0)
      .reduce((sum, value) => sum + value ** 2, 0);
    const bpv =
      (Math.PI / 2) *
      returns
        .slice(1)
        .reduce(
          (sum, value, index) =>
            sum + Math.abs(value) * Math.abs(returns[index]),
          0
        );
    days.push({
      day,
      rv,
      downsideSemivariance: downside,
      bipowerVariation: bpv,
      jumpIntensity: Math.max(rv - bpv, 0),
    });
  }
  const latest = days.at(-1);
  if (!latest)
    return {
      status: "insufficient",
      proxyNotice: "Hourly returns are unavailable.",
    };
  const rv = days.map((day) => day.rv);
  return {
    status: days.length >= 22 ? "complete" : "partial",
    proxyNotice:
      "Realized measures use closed hourly XAU/USD returns and are not tick-level COMEX realized volatility.",
    latestDay: latest.day,
    dailyRealizedVariance: rounded(latest.rv, 12),
    downsideSemivariance: rounded(latest.downsideSemivariance, 12),
    bipowerVariation: rounded(latest.bipowerVariation, 12),
    jumpIntensity: rounded(latest.jumpIntensity, 12),
    harWeek: rounded(mean(rv.slice(-5)), 12),
    harMonth: rounded(mean(rv.slice(-22)), 12),
    observations: days.length,
  };
}

function macroSeriesView(entry, now) {
  if (!entry?.rows?.length) return null;
  const latest = entry.rows.at(-1);
  const previous = entry.rows.at(-2);
  const five = entry.rows.at(-6);
  return {
    seriesId: entry.seriesId,
    value: latest.value,
    observedAtMs: latest.observedAtMs,
    dataAgeMs: Math.max(0, now - latest.observedAtMs),
    change1: previous ? rounded(latest.value - previous.value, 6) : null,
    change5: five ? rounded(latest.value - five.value, 6) : null,
    zscore60: rounded(
      zscore(
        latest.value,
        entry.rows.slice(-60).map((row) => row.value)
      ),
      6
    ),
    availabilityQuality: "estimated",
    conservativeAvailabilityLagMs: 36 * 60 * 60 * 1_000,
  };
}

function macroContext(fred, now) {
  const views = Object.fromEntries(
    Object.entries(fred?.series || {}).map(([name, value]) => [
      name,
      macroSeriesView(value, now),
    ])
  );
  if (views.nominal10y && views.nominal2y)
    views.nominalCurve10y2y = {
      value: rounded(views.nominal10y.value - views.nominal2y.value, 6),
      observedAtMs: Math.min(
        views.nominal10y.observedAtMs,
        views.nominal2y.observedAtMs
      ),
      availabilityQuality: "estimated",
    };
  const headwinds = [
    views.dxy?.change5 > 0.5,
    views.realYield10y?.change5 > 0.1,
  ].filter(Boolean).length;
  const tailwinds = [
    views.dxy?.change5 < -0.5,
    views.realYield10y?.change5 < -0.1,
  ].filter(Boolean).length;
  return {
    status: Object.keys(views).length ? "complete" : "unavailable",
    series: views,
    observedState:
      headwinds >= 2
        ? "contemporaneous_headwind"
        : tailwinds >= 2
          ? "contemporaneous_tailwind"
          : "mixed",
    interpretation:
      "Tailwind/headwind describes contemporaneous dollar and real-yield conditions, not a future gold-price prediction.",
  };
}

function positioningContext(cot, now) {
  const rows = cot?.rows || [];
  const latest = rows.at(-1);
  if (!latest) return { status: "unavailable" };
  const crowding = zscore(
    latest.managedNetRatio,
    rows.slice(-156).map((row) => row.managedNetRatio)
  );
  return {
    status: rows.length >= 156 ? "complete" : "partial",
    reportDate: latest.reportDate,
    reportAtMs: latest.reportAtMs,
    availableAtMs: latest.availableAtMs,
    availabilityQuality: latest.availabilityQuality || "estimated",
    availabilityEstimated:
      (latest.availabilityQuality || "estimated") !== "exact",
    releaseCalendarVersion: latest.releaseCalendarVersion || null,
    dataAgeMs: Math.max(0, now - latest.availableAtMs),
    openInterest: latest.openInterest,
    managedMoney: {
      longRatio: rounded(latest.managedLongRatio, 6),
      shortRatio: rounded(latest.managedShortRatio, 6),
      netRatio: rounded(latest.managedNetRatio, 6),
      spreadingRatio: rounded(latest.spreadingRatio, 6),
      crowdingZ156w: rounded(crowding, 6),
    },
    commercialNetRatio: rounded(latest.commercialNetRatio, 6),
    observedState:
      crowding === null
        ? "insufficient_history"
        : crowding >= 2
          ? "managed_money_long_crowded"
          : crowding <= -2
            ? "managed_money_short_crowded"
            : "not_extreme",
    warning:
      "COT crowding is a positioning-risk observation and does not imply reversal or continuation.",
  };
}

function etfContext(etf, previous = null, now = Date.now()) {
  if (!etf) return { status: "unavailable" };
  const delta = (current, prior) =>
    Number.isFinite(current) && Number.isFinite(prior)
      ? rounded(current - prior, 6)
      : null;
  return {
    status: "partial",
    receivedAtMs: etf.receivedAtMs,
    dataAgeMs: Math.max(0, now - etf.receivedAtMs),
    gld: {
      ...etf.gld,
      tonnesChange: delta(etf.gld?.tonnesInTrust, previous?.gld?.tonnesInTrust),
    },
    iau: {
      ...etf.iau,
      tonnesChange: delta(etf.iau?.tonnesInTrust, previous?.iau?.tonnesInTrust),
    },
    observedState:
      previous === null
        ? "baseline_only"
        : "changes_available_when_issuer_values_parse",
    limitations: [
      "Issuer current pages are used; restricted historical archives are not copied.",
      "ETF price and holdings are flow proxies, not XAU/USD centralized volume.",
    ],
  };
}

function sgeSessionAtMs(row) {
  if (!row?.date || !/^\d{8}$/.test(row.date)) return null;
  const year = Number(row.date.slice(0, 4));
  const month = Number(row.date.slice(4, 6)) - 1;
  const day = Number(row.date.slice(6, 8));
  const localHour = row.session === "am" ? 10 : 14;
  const localMinute = 15;
  return Date.UTC(year, month, day, localHour - 8, localMinute);
}

function chinaContext({ sge, usdCny, xauReference, now }) {
  const latest = sge?.rows?.at(-1);
  const sgeObservedAtMs = sgeSessionAtMs(latest);
  if (
    !latest ||
    !Number.isFinite(sgeObservedAtMs) ||
    !Number.isFinite(usdCny?.rate) ||
    !Number.isFinite(usdCny?.observedAtMs) ||
    usdCny.observedAtMs > sgeObservedAtMs ||
    !Number.isFinite(xauReference?.price) ||
    !Number.isFinite(xauReference?.observedAtMs) ||
    xauReference.observedAtMs > sgeObservedAtMs
  )
    return { status: "unavailable" };
  const usdPerOunce = (latest.priceCnyPerGram * OUNCE_GRAMS) / usdCny.rate;
  const premium = usdPerOunce / xauReference.price - 1;
  return {
    status: "available",
    date: latest.date,
    session: latest.session,
    observedAtMs: sgeObservedAtMs,
    dataAgeMs: Math.max(0, now - sgeObservedAtMs),
    priceCnyPerGram: latest.priceCnyPerGram,
    usdCny: usdCny.rate,
    convertedUsdPerOunce: rounded(usdPerOunce, 6),
    internationalReferenceUsdPerOunce: rounded(xauReference.price, 6),
    internationalReferenceObservedAtMs: xauReference.observedAtMs,
    usdCnyObservedAtMs: usdCny.observedAtMs,
    maximumClockSkewMs: Math.max(
      sgeObservedAtMs - xauReference.observedAtMs,
      sgeObservedAtMs - usdCny.observedAtMs
    ),
    premiumRatio: rounded(premium, 8),
    observedState:
      premium >= 0.01
        ? "shanghai_premium"
        : premium <= -0.01
          ? "shanghai_discount"
          : "near_international_reference",
    limitations: [
      "This is a timestamp-bounded SGE versus XAU/USD reference comparison, not LBMA Gold Price.",
      "FX and XAU reference clocks may differ; source timestamps must be reviewed.",
    ],
  };
}

function goldSilverContext(xauDaily, xagDaily) {
  const gold = closedBars(xauDaily).at(-1);
  const silver = closedBars(xagDaily).at(-1);
  if (!gold || !silver) return { status: "unavailable", ratio: null };
  return {
    status: "available",
    ratio: rounded(gold.close / silver.close, 6),
    goldClosedAtMs: gold.closeTimeMs,
    silverClosedAtMs: silver.closeTimeMs,
  };
}

function currentMarket({ xauBars, dailyBars = [], crosscheck, now }) {
  const latest = xauBars.at(-1);
  const daily = dailyBars.at(-1);
  const primary = latest || daily;
  if (!primary && !Number.isFinite(crosscheck?.price))
    return { status: "unavailable" };
  const crossPrice = crosscheck?.price;
  const primaryPrice = primary?.close ?? crossPrice;
  const deviationBps =
    primary && Number.isFinite(crossPrice)
      ? (Math.abs(primaryPrice - crossPrice) /
          ((primaryPrice + crossPrice) / 2)) *
        10_000
      : null;
  return {
    status:
      !latest || (deviationBps !== null && deviationBps > 50)
        ? "degraded"
        : "available",
    symbol: "XAU/USD",
    price: rounded(primaryPrice, 6),
    observedAtMs: primary?.closeTimeMs || crosscheck?.observedAtMs || null,
    dataFreshnessMs: Math.max(
      0,
      now - (primary?.closeTimeMs || crosscheck?.observedAtMs || now)
    ),
    primarySource: primary?.source || "gold_api",
    primaryInterval: latest ? "5min" : daily ? "1day" : "reference_price",
    crosscheck: {
      source: "gold_api",
      price: rounded(crossPrice, 6),
      observedAtMs: crosscheck?.observedAtMs || null,
      deviationBps: rounded(deviationBps, 4),
      thresholdBps: 50,
      withinTolerance: deviationBps === null ? null : deviationBps <= 50,
    },
  };
}

function monitoringSignals({ macro, positioning, volatility, china, etf }) {
  return [
    {
      id: "dollar_real_yield_condition",
      observed: macro.observedState !== "mixed",
      state: macro.observedState,
      sourcePaths: [
        "macroContext.series.dxy.change5",
        "macroContext.series.realYield10y.change5",
      ],
    },
    {
      id: "implied_volatility_elevated",
      observed: (macro.series?.gvz?.zscore60 ?? 0) >= 1.5,
      state:
        (macro.series?.gvz?.zscore60 ?? 0) >= 1.5 ? "elevated" : "not_elevated",
      sourcePaths: ["macroContext.series.gvz.zscore60"],
    },
    {
      id: "cot_crowding",
      observed: [
        "managed_money_long_crowded",
        "managed_money_short_crowded",
      ].includes(positioning.observedState),
      state: positioning.observedState,
      sourcePaths: ["positioning.managedMoney.crowdingZ156w"],
    },
    {
      id: "realized_jump_component",
      observed:
        Number.isFinite(volatility.jumpIntensity) &&
        Number.isFinite(volatility.dailyRealizedVariance) &&
        volatility.jumpIntensity > volatility.dailyRealizedVariance * 0.25,
      state: "closed_hourly_proxy",
      sourcePaths: [
        "volatilityRisk.jumpIntensity",
        "volatilityRisk.dailyRealizedVariance",
      ],
    },
    {
      id: "sge_cross_market_premium",
      observed: ["shanghai_premium", "shanghai_discount"].includes(
        china.observedState
      ),
      state: china.observedState || "unavailable",
      sourcePaths: ["chinaMarket.premiumRatio"],
    },
    {
      id: "issuer_holdings_change",
      observed: [etf.gld?.tonnesChange, etf.iau?.tonnesChange].some(
        Number.isFinite
      ),
      state: etf.observedState || "unavailable",
      sourcePaths: ["etfFlows.gld.tonnesChange", "etfFlows.iau.tonnesChange"],
    },
  ];
}

function datasetManifestSha(data) {
  const compact = {
    xau: (data.xau5m?.bars || []).map((bar) => [
      bar.openTimeMs,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
    ]),
    daily: (data.xauDaily?.bars || []).map((bar) => [
      bar.openTimeMs,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
    ]),
    fred: Object.fromEntries(
      Object.entries(data.fred?.series || {}).map(([name, entry]) => [
        name,
        entry.rows.at(-1) || null,
      ])
    ),
    cot: data.cot?.rows?.at(-1) || null,
    sge: data.sge?.rows?.at(-1) || null,
  };
  return sha256(compact);
}

function enforcePayloadBudget(result) {
  let serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) <= MAX_PAYLOAD_BYTES) return result;
  const next = JSON.parse(serialized);
  for (const timeframe of Object.values(next.timeframes || {}))
    if (Array.isArray(timeframe.candles))
      timeframe.candles = timeframe.candles.slice(-60);
  serialized = JSON.stringify(next);
  if (Buffer.byteLength(serialized) <= MAX_PAYLOAD_BYTES) return next;
  for (const timeframe of Object.values(next.timeframes || {}))
    if (Array.isArray(timeframe.candles))
      timeframe.candles = timeframe.candles.slice(-30);
  return next;
}

function buildGoldAnalysis({
  data,
  partialFailures = [],
  previousSnapshot = null,
  now = Date.now(),
  shadowResearch = null,
}) {
  const fiveMinute = closedBars(data.xau5m?.bars || [], now);
  const hourly = closedBars(
    aggregateBars(fiveMinute, TIMEFRAMES["1h"].intervalMs, "1h"),
    now
  );
  const fourHourly = closedBars(
    aggregateBars(fiveMinute, TIMEFRAMES["4h"].intervalMs, "4h"),
    now
  );
  const daily = closedBars(data.xauDaily?.bars || [], now);
  const weekly = closedBars(aggregateNaturalWeeks(daily), now);
  const byTimeframe = {
    "1h": hourly,
    "4h": fourHourly,
    "1d": daily,
    "1w": weekly,
  };
  const timeframes = Object.fromEntries(
    Object.entries(byTimeframe).map(([id, bars]) => [
      id,
      analyzeTimeframe(id, bars),
    ])
  );
  const market = currentMarket({
    xauBars: fiveMinute,
    dailyBars: daily,
    crosscheck: data.gold,
    now,
  });
  const macro = macroContext(data.fred, now);
  const positioning = positioningContext(data.cot, now);
  const volatility = dailyRealizedVolatility(hourly);
  const etf = etfContext(data.etf, previousSnapshot?.etfFlows || null, now);
  const sgeObservedAtMs = sgeSessionAtMs(data.sge?.rows?.at(-1));
  const xauReferenceBar = [...fiveMinute, ...daily]
    .filter((bar) => bar.closeTimeMs <= sgeObservedAtMs)
    .sort((left, right) => left.closeTimeMs - right.closeTimeMs)
    .at(-1);
  const china = chinaContext({
    sge: data.sge,
    usdCny: data.usdCny,
    xauReference: xauReferenceBar
      ? {
          price: xauReferenceBar.close,
          observedAtMs: xauReferenceBar.closeTimeMs,
        }
      : null,
    now,
  });
  const goldSilver = goldSilverContext(
    data.xauDaily?.bars || [],
    data.xagDaily?.bars || []
  );
  const sourceStatuses = data.sourceStatuses || {};
  const requiredAvailable = ["twelve_data", "gold_api", "fred", "cftc"].filter(
    (source) =>
      ["available", "fallback_available"].includes(sourceStatuses[source])
  ).length;
  const supportingEvidenceAvailable =
    market.status !== "unavailable" ||
    macro.status !== "unavailable" ||
    positioning.status !== "unavailable" ||
    etf.status !== "unavailable" ||
    china.status !== "unavailable";
  const analysisStatus =
    fiveMinute.length === 0 && daily.length === 0
      ? supportingEvidenceAvailable
        ? "partial"
        : "unavailable"
      : requiredAvailable === 4 &&
          Object.values(timeframes).every(
            (timeframe) => timeframe.status === "complete"
          )
        ? "complete"
        : "partial";
  const macroAges = Object.values(macro.series || {})
    .map((value) => value.dataAgeMs)
    .filter(Number.isFinite);
  const result = {
    tool: TOOL_NAME,
    ok: analysisStatus !== "unavailable",
    schema: RESULT_SCHEMA,
    schemaVersion: RESULT_SCHEMA_VERSION,
    formulaVersion: FORMULA_VERSION,
    factorRegistryVersion: FACTOR_REGISTRY.registryVersion,
    factorRegistrySha256: FACTOR_REGISTRY_SHA256,
    asOf: new Date(now).toISOString(),
    analysisStatus,
    analysisPolicy: {
      mode: "analysis_only",
      directDirectionalPrediction: false,
      directionalProbabilitiesExposed: false,
      returnTargetsExposed: false,
      priceTargetsExposed: false,
      tradeInstructionsExposed: false,
      deterministicReport: true,
      reason: "gqss_v1_shadow_research_not_promoted",
    },
    currentMarket: market,
    timeframes,
    macroContext: macro,
    positioning,
    etfFlows: etf,
    chinaMarket: china,
    crossMarket: { goldSilver },
    volatilityRisk: volatility,
    factorFamilies: {
      priceTrend: {
        stateByTimeframe: Object.fromEntries(
          Object.entries(timeframes).map(([id, value]) => [
            id,
            value.observedState,
          ])
        ),
      },
      macro: { state: macro.observedState, status: macro.status },
      positioning: {
        state: positioning.observedState,
        status: positioning.status,
      },
      volatility: {
        state:
          (macro.series?.gvz?.zscore60 ?? 0) >= 1.5
            ? "implied_volatility_elevated"
            : "not_elevated",
        status: volatility.status,
      },
      crossMarket: {
        state: china.observedState || "insufficient",
        status: china.status,
      },
      liquidityAndOrderFlow: {
        state: "insufficient",
        status: "unavailable",
        reason:
          "No licensed centralized XAU/COMEX L1/L2 or aggressor-side trade feed.",
      },
    },
    monitoringSignals: [],
    shadowResearch,
    dataQuality: {
      status:
        analysisStatus === "complete" && partialFailures.length === 0
          ? "complete"
          : analysisStatus === "unavailable"
            ? "unavailable"
            : "degraded",
      sourceStatuses,
      sourceAgesMs: {
        currentMarket: market.dataFreshnessMs ?? null,
        macroLatest: macroAges.length ? Math.min(...macroAges) : null,
        positioning: positioning.dataAgeMs ?? null,
        etfIssuers: etf.dataAgeMs ?? null,
        shanghaiGold: china.dataAgeMs ?? null,
      },
      partialFailureCount: partialFailures.length,
      volumePolicy:
        "Missing centralized XAU volume remains null; ETF volume is a labeled proxy and is never substituted into XAU indicators.",
      lbmaPolicy:
        "LBMA benchmark prices are not fetched or stored without an authorized licence.",
    },
    partialFailures,
    provenance: {
      datasetManifestSha256: datasetManifestSha(data),
      factorRegistrySha256: FACTOR_REGISTRY_SHA256,
      dataAvailableThroughMs: Math.max(
        0,
        ...fiveMinute.map((bar) => bar.closeTimeMs),
        ...daily.map((bar) => bar.closeTimeMs)
      ),
      generatedAtMs: now,
    },
  };
  result.monitoringSignals = monitoringSignals({
    macro,
    positioning,
    volatility,
    china,
    etf,
  });
  const bounded = enforcePayloadBudget(result);
  bounded.provenance.resultSha256 = crypto
    .createHash("sha256")
    .update(canonicalJson(bounded))
    .digest("hex");
  bounded.provenance.payloadBytes = Buffer.byteLength(JSON.stringify(bounded));
  return bounded;
}

module.exports = {
  OUNCE_GRAMS,
  _internals: {
    adx,
    aggregateBars,
    aggregateNaturalWeeks,
    bollinger,
    dailyRealizedVolatility,
    donchian,
    emaSeries,
    macd,
    parkinson,
    rsi,
    sma,
  },
  buildGoldAnalysis,
  closedBars,
  enforcePayloadBudget,
};
