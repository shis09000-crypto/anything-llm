const SUPPORTING_EVIDENCE_VERSION = "crypto-market-evidence-v1";

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value, digits = 10) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function lastFinite(values = []) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(values[index])) return values[index];
  }
  return null;
}

function chaikinMoneyFlowSeries(rows = [], period = 20) {
  const result = Array(rows.length).fill(null);
  for (let index = period - 1; index < rows.length; index += 1) {
    const window = rows.slice(index - period + 1, index + 1);
    const totalVolume = window.reduce((sum, row) => sum + row.volume, 0);
    if (totalVolume === 0) continue;
    const moneyFlowVolume = window.reduce((sum, row) => {
      const range = row.high - row.low;
      const multiplier =
        range === 0
          ? 0
          : (row.close - row.low - (row.high - row.close)) / range;
      return sum + multiplier * row.volume;
    }, 0);
    result[index] = moneyFlowVolume / totalVolume;
  }
  return result;
}

function moneyFlowIndexSeries(rows = [], period = 14) {
  const result = Array(rows.length).fill(null);
  const typicalPrices = rows.map((row) => (row.high + row.low + row.close) / 3);
  const rawFlows = rows.map((row, index) => typicalPrices[index] * row.volume);
  for (let index = period; index < rows.length; index += 1) {
    let positive = 0;
    let negative = 0;
    for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
      if (typicalPrices[cursor] > typicalPrices[cursor - 1])
        positive += rawFlows[cursor];
      else if (typicalPrices[cursor] < typicalPrices[cursor - 1])
        negative += rawFlows[cursor];
    }
    if (positive === 0 && negative === 0) result[index] = 50;
    else if (negative === 0) result[index] = 100;
    else result[index] = 100 - 100 / (1 + positive / negative);
  }
  return result;
}

function accumulationDistributionSeries(rows = []) {
  const result = Array(rows.length).fill(null);
  let total = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const range = row.high - row.low;
    const multiplier =
      range === 0 ? 0 : (row.close - row.low - (row.high - row.close)) / range;
    total += multiplier * row.volume;
    result[index] = total;
  }
  return result;
}

function accumulationDistributionSlope(rows = [], series = [], bars = 3) {
  if (rows.length <= bars || series.length !== rows.length)
    return {
      bars,
      valueChange: null,
      normalizedByVolume: null,
    };
  const latest = series[series.length - 1];
  const previous = series[series.length - 1 - bars];
  const totalVolume = rows
    .slice(-bars)
    .reduce((sum, row) => sum + Number(row.volume || 0), 0);
  const valueChange =
    Number.isFinite(latest) && Number.isFinite(previous)
      ? latest - previous
      : null;
  return {
    bars,
    valueChange: rounded(valueChange),
    normalizedByVolume:
      Number.isFinite(valueChange) && totalVolume > 0
        ? rounded(valueChange / totalVolume)
        : null,
  };
}

function donchian(rows = [], period = 20) {
  const window = rows.slice(0, -1).slice(-period);
  if (!window.length) return { period, upper: null, lower: null, middle: null };
  const upper = Math.max(...window.map((row) => row.high));
  const lower = Math.min(...window.map((row) => row.low));
  return {
    period,
    upper: rounded(upper),
    lower: rounded(lower),
    middle: rounded((upper + lower) / 2),
  };
}

function linearRegression(values = [], period = 20) {
  const window = values.slice(-period);
  if (window.length < period || !window.every(Number.isFinite))
    return {
      period,
      slopePerBar: null,
      slopePctPerBar: null,
      rSquared: null,
    };
  const xMean = (period - 1) / 2;
  const yMean = window.reduce((sum, value) => sum + value, 0) / period;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < period; index += 1) {
    numerator += (index - xMean) * (window[index] - yMean);
    denominator += (index - xMean) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = yMean - slope * xMean;
  const total = window.reduce((sum, value) => sum + (value - yMean) ** 2, 0);
  const residual = window.reduce((sum, value, index) => {
    const predicted = intercept + slope * index;
    return sum + (value - predicted) ** 2;
  }, 0);
  return {
    period,
    slopePerBar: rounded(slope),
    slopePctPerBar: yMean === 0 ? null : rounded((slope / yMean) * 100),
    rSquared: total === 0 ? 1 : rounded(Math.max(0, 1 - residual / total)),
  };
}

function efficiencyRatio(values = [], period = 20) {
  const window = values.slice(-(period + 1));
  if (window.length < period + 1) return null;
  const direction = Math.abs(window[window.length - 1] - window[0]);
  let path = 0;
  for (let index = 1; index < window.length; index += 1)
    path += Math.abs(window[index] - window[index - 1]);
  return path === 0 ? 0 : direction / path;
}

function confirmedPivots(rows = [], radius = 2) {
  const highs = [];
  const lows = [];
  for (let index = radius; index < rows.length - radius; index += 1) {
    const window = rows.slice(index - radius, index + radius + 1);
    const row = rows[index];
    if (window.every((candidate) => row.high >= candidate.high))
      highs.push({ timestampMs: row.ts, price: row.high });
    if (window.every((candidate) => row.low <= candidate.low))
      lows.push({ timestampMs: row.ts, price: row.low });
  }
  return { highs, lows };
}

function marketStructure(rows = [], radius = 2) {
  const pivots = confirmedPivots(rows, radius);
  const recentHighs = pivots.highs.slice(-2);
  const recentLows = pivots.lows.slice(-2);
  const highState =
    recentHighs.length < 2
      ? "insufficient"
      : recentHighs[1].price > recentHighs[0].price
        ? "higher_high"
        : recentHighs[1].price < recentHighs[0].price
          ? "lower_high"
          : "equal_high";
  const lowState =
    recentLows.length < 2
      ? "insufficient"
      : recentLows[1].price > recentLows[0].price
        ? "higher_low"
        : recentLows[1].price < recentLows[0].price
          ? "lower_low"
          : "equal_low";
  const state =
    highState === "higher_high" && lowState === "higher_low"
      ? "bullish"
      : highState === "lower_high" && lowState === "lower_low"
        ? "bearish"
        : highState === "insufficient" || lowState === "insufficient"
          ? "insufficient"
          : "mixed";
  return {
    pivotRadius: radius,
    state,
    highState,
    lowState,
    latestConfirmedHigh: recentHighs[recentHighs.length - 1] || null,
    latestConfirmedLow: recentLows[recentLows.length - 1] || null,
  };
}

function enhancedIndicators(rows = []) {
  const closes = rows.map((row) => row.close);
  const cmf20 = chaikinMoneyFlowSeries(rows, 20);
  const mfi14 = moneyFlowIndexSeries(rows, 14);
  const adl = accumulationDistributionSeries(rows);
  return {
    moneyFlow: {
      cmf20: rounded(lastFinite(cmf20)),
      cmf20Slope3: rounded(
        (() => {
          const valid = cmf20.filter(Number.isFinite);
          if (valid.length <= 3) return null;
          return valid[valid.length - 1] - valid[valid.length - 4];
        })()
      ),
      mfi14: rounded(lastFinite(mfi14)),
      accumulationDistribution: {
        value: rounded(lastFinite(adl)),
        shortTermSlope: accumulationDistributionSlope(rows, adl, 3),
      },
    },
    trendStructure: {
      donchian20: donchian(rows, 20),
      donchian55: donchian(rows, 55),
      linearRegression20: linearRegression(closes, 20),
      efficiencyRatio20: rounded(efficiencyRatio(closes, 20)),
      pivots: marketStructure(rows, 2),
    },
  };
}

function compactRows(candles = []) {
  return candles
    .map((candle) => {
      if (Array.isArray(candle))
        return {
          ts: finite(candle[0]),
          close: finite(candle[4]),
        };
      return {
        ts: finite(candle?.ts),
        close: finite(candle?.close),
      };
    })
    .filter(
      ({ ts, close }) =>
        Number.isFinite(ts) && Number.isFinite(close) && close > 0
    )
    .sort((left, right) => left.ts - right.ts);
}

function returnPct(values, bars) {
  if (values.length <= bars) return null;
  const latest = values[values.length - 1];
  const previous = values[values.length - 1 - bars];
  if (!Number.isFinite(latest) || !Number.isFinite(previous) || previous === 0)
    return null;
  return ((latest - previous) / Math.abs(previous)) * 100;
}

function pearsonCorrelation(left = [], right = []) {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator === 0 ? null : numerator / denominator;
}

function relativeStrength(targetCandles = [], benchmarkCandles = []) {
  const target = compactRows(targetCandles);
  const benchmarkByTs = new Map(
    compactRows(benchmarkCandles).map((row) => [row.ts, row.close])
  );
  const aligned = target
    .filter(({ ts }) => benchmarkByTs.has(ts))
    .map(({ ts, close }) => ({
      ts,
      target: close,
      benchmark: benchmarkByTs.get(ts),
    }));
  const targetCloses = aligned.map(({ target }) => target);
  const benchmarkCloses = aligned.map(({ benchmark }) => benchmark);
  const targetReturns = [];
  const benchmarkReturns = [];
  for (
    let index = Math.max(1, aligned.length - 30);
    index < aligned.length;
    index += 1
  ) {
    targetReturns.push(Math.log(targetCloses[index] / targetCloses[index - 1]));
    benchmarkReturns.push(
      Math.log(benchmarkCloses[index] / benchmarkCloses[index - 1])
    );
  }
  const target5 = returnPct(targetCloses, 5);
  const target20 = returnPct(targetCloses, 20);
  const benchmark5 = returnPct(benchmarkCloses, 5);
  const benchmark20 = returnPct(benchmarkCloses, 20);
  return {
    benchmark: "BTC_USDT",
    alignedBars: aligned.length,
    returnDifferencePct: {
      bars5:
        Number.isFinite(target5) && Number.isFinite(benchmark5)
          ? rounded(target5 - benchmark5)
          : null,
      bars20:
        Number.isFinite(target20) && Number.isFinite(benchmark20)
          ? rounded(target20 - benchmark20)
          : null,
    },
    returnCorrelation30: rounded(
      pearsonCorrelation(targetReturns, benchmarkReturns)
    ),
    status: aligned.length >= 31 ? "available" : "insufficient",
  };
}

function evidenceCheck({
  id,
  family,
  state,
  actual,
  operator,
  threshold,
  sourcePath,
}) {
  return {
    id,
    family,
    state,
    actual: rounded(actual),
    operator,
    threshold: rounded(threshold),
    sourcePath,
  };
}

function directionalFamily({ family, direction, checks, minimumAligned = 2 }) {
  const available = checks.filter(({ actual }) => Number.isFinite(actual));
  if (available.length < minimumAligned)
    return {
      family,
      state: "insufficient",
      checks,
      reason: "insufficient_independent_checks",
    };
  const supports = available.filter(({ state }) => state === "supports").length;
  const conflicts = available.filter(
    ({ state }) => state === "conflicts"
  ).length;
  return {
    family,
    direction,
    state:
      supports >= minimumAligned && conflicts === 0
        ? "supports"
        : conflicts >= minimumAligned
          ? "conflicts"
          : "neutral",
    checks,
  };
}

function priceTrendFamily(scenario, timeframes = {}, confluence = {}) {
  const dailyState = timeframes["1d"]?.regime?.state;
  let state = "neutral";
  if (scenario.id === "bullish_breakout")
    state =
      confluence.bullish?.length >= 2 || dailyState === "bullish_trend"
        ? "supports"
        : confluence.bearish?.length >= 2
          ? "conflicts"
          : "neutral";
  else if (scenario.id === "bearish_breakdown")
    state =
      confluence.bearish?.length >= 2 || dailyState === "bearish_trend"
        ? "supports"
        : confluence.bullish?.length >= 2
          ? "conflicts"
          : "neutral";
  else if (scenario.id === "range_continuation")
    state =
      dailyState === "range"
        ? "supports"
        : ["bullish_trend", "bearish_trend"].includes(dailyState)
          ? "conflicts"
          : "neutral";
  return {
    family: "price_trend",
    state,
    checks: [
      {
        id: "daily_regime",
        family: "price_trend",
        state,
        actual: dailyState || "unavailable",
        operator: "scenario_specific",
        threshold: null,
        sourcePath: "timeframes.1d.regime.state",
      },
    ],
  };
}

function priceVolumeFamily(scenario, timeframes = {}) {
  const daily = timeframes["1d"];
  const cmf = finite(daily?.indicators?.moneyFlow?.cmf20);
  const mfi = finite(daily?.indicators?.moneyFlow?.mfi14);
  const adlSlope = finite(
    daily?.indicators?.moneyFlow?.accumulationDistribution?.shortTermSlope
      ?.normalizedByVolume
  );
  const direction =
    scenario.id === "bullish_breakout"
      ? "bullish"
      : scenario.id === "bearish_breakdown"
        ? "bearish"
        : "range";
  if (direction === "range") {
    const checks = [
      evidenceCheck({
        id: "cmf_neutral",
        family: "price_volume",
        state:
          Number.isFinite(cmf) && Math.abs(cmf) <= 0.05
            ? "supports"
            : "neutral",
        actual: cmf,
        operator: "abs<=",
        threshold: 0.05,
        sourcePath: "timeframes.1d.indicators.moneyFlow.cmf20",
      }),
      evidenceCheck({
        id: "mfi_neutral",
        family: "price_volume",
        state:
          Number.isFinite(mfi) && mfi >= 45 && mfi <= 55
            ? "supports"
            : "neutral",
        actual: mfi,
        operator: "between",
        threshold: 50,
        sourcePath: "timeframes.1d.indicators.moneyFlow.mfi14",
      }),
    ];
    return directionalFamily({
      family: "price_volume",
      direction,
      checks,
    });
  }
  const bullish = direction === "bullish";
  const checks = [
    evidenceCheck({
      id: "cmf_direction",
      family: "price_volume",
      state:
        Number.isFinite(cmf) && (bullish ? cmf > 0 : cmf < 0)
          ? "supports"
          : Number.isFinite(cmf) && (bullish ? cmf < 0 : cmf > 0)
            ? "conflicts"
            : "neutral",
      actual: cmf,
      operator: bullish ? ">" : "<",
      threshold: 0,
      sourcePath: "timeframes.1d.indicators.moneyFlow.cmf20",
    }),
    evidenceCheck({
      id: "mfi_direction",
      family: "price_volume",
      state:
        Number.isFinite(mfi) && (bullish ? mfi >= 55 : mfi <= 45)
          ? "supports"
          : Number.isFinite(mfi) && (bullish ? mfi <= 45 : mfi >= 55)
            ? "conflicts"
            : "neutral",
      actual: mfi,
      operator: bullish ? ">=" : "<=",
      threshold: bullish ? 55 : 45,
      sourcePath: "timeframes.1d.indicators.moneyFlow.mfi14",
    }),
    evidenceCheck({
      id: "adl_slope_direction",
      family: "price_volume",
      state:
        Number.isFinite(adlSlope) && (bullish ? adlSlope > 0 : adlSlope < 0)
          ? "supports"
          : Number.isFinite(adlSlope) && (bullish ? adlSlope < 0 : adlSlope > 0)
            ? "conflicts"
            : "neutral",
      actual: adlSlope,
      operator: bullish ? ">" : "<",
      threshold: 0,
      sourcePath:
        "timeframes.1d.indicators.moneyFlow.accumulationDistribution.shortTermSlope.normalizedByVolume",
    }),
  ];
  return directionalFamily({
    family: "price_volume",
    direction,
    checks,
  });
}

function microstructureFamily(scenario, microstructure = {}) {
  const trade5 = microstructure?.tradeFlow?.windows?.["5m"];
  const trade15 = microstructure?.tradeFlow?.windows?.["15m"];
  const depth5 = microstructure?.orderBook?.windows?.["5m"]?.depth?.["25bps"];
  const direction =
    scenario.id === "bullish_breakout"
      ? "bullish"
      : scenario.id === "bearish_breakdown"
        ? "bearish"
        : "range";
  if (
    !["available"].includes(trade5?.status) ||
    !["available"].includes(trade15?.status) ||
    microstructure?.orderBook?.windows?.["5m"]?.status !== "available"
  )
    return {
      family: "spot_microstructure",
      state: "insufficient",
      checks: [],
      reason: microstructure?.status || "warming",
    };
  const ratio5 = finite(trade5.takerBuyRatio);
  const ratio15 = finite(trade15.takerBuyRatio);
  const imbalance = finite(depth5?.imbalanceMedian);
  const positiveRatio = finite(depth5?.positiveSampleRatio);
  const negativeRatio = finite(depth5?.negativeSampleRatio);
  if (direction === "range") {
    const checks = [
      evidenceCheck({
        id: "taker_flow_balanced_5m",
        family: "spot_microstructure",
        state:
          Number.isFinite(ratio5) && ratio5 >= 0.45 && ratio5 <= 0.55
            ? "supports"
            : "neutral",
        actual: ratio5,
        operator: "between",
        threshold: 0.5,
        sourcePath:
          "supportingEvidence.spotMicrostructure.tradeFlow.windows.5m.takerBuyRatio",
      }),
      evidenceCheck({
        id: "depth_balanced_5m",
        family: "spot_microstructure",
        state:
          Number.isFinite(imbalance) && Math.abs(imbalance) <= 0.1
            ? "supports"
            : "neutral",
        actual: imbalance,
        operator: "abs<=",
        threshold: 0.1,
        sourcePath:
          "supportingEvidence.spotMicrostructure.orderBook.windows.5m.depth.25bps.imbalanceMedian",
      }),
    ];
    return directionalFamily({
      family: "spot_microstructure",
      direction,
      checks,
    });
  }
  const bullish = direction === "bullish";
  const checks = [
    evidenceCheck({
      id: "taker_flow_5m",
      family: "spot_microstructure",
      state:
        Number.isFinite(ratio5) && (bullish ? ratio5 >= 0.55 : ratio5 <= 0.45)
          ? "supports"
          : Number.isFinite(ratio5) &&
              (bullish ? ratio5 <= 0.45 : ratio5 >= 0.55)
            ? "conflicts"
            : "neutral",
      actual: ratio5,
      operator: bullish ? ">=" : "<=",
      threshold: bullish ? 0.55 : 0.45,
      sourcePath:
        "supportingEvidence.spotMicrostructure.tradeFlow.windows.5m.takerBuyRatio",
    }),
    evidenceCheck({
      id: "taker_flow_15m",
      family: "spot_microstructure",
      state:
        Number.isFinite(ratio15) &&
        (bullish ? ratio15 >= 0.55 : ratio15 <= 0.45)
          ? "supports"
          : Number.isFinite(ratio15) &&
              (bullish ? ratio15 <= 0.45 : ratio15 >= 0.55)
            ? "conflicts"
            : "neutral",
      actual: ratio15,
      operator: bullish ? ">=" : "<=",
      threshold: bullish ? 0.55 : 0.45,
      sourcePath:
        "supportingEvidence.spotMicrostructure.tradeFlow.windows.15m.takerBuyRatio",
    }),
    evidenceCheck({
      id: "persistent_depth_imbalance_5m",
      family: "spot_microstructure",
      state:
        Number.isFinite(imbalance) &&
        Number.isFinite(bullish ? positiveRatio : negativeRatio) &&
        (bullish ? imbalance >= 0.1 : imbalance <= -0.1) &&
        (bullish ? positiveRatio : negativeRatio) >= 0.6
          ? "supports"
          : Number.isFinite(imbalance) &&
              Number.isFinite(bullish ? negativeRatio : positiveRatio) &&
              (bullish ? imbalance <= -0.1 : imbalance >= 0.1) &&
              (bullish ? negativeRatio : positiveRatio) >= 0.6
            ? "conflicts"
            : "neutral",
      actual: imbalance,
      operator: bullish ? ">=" : "<=",
      threshold: bullish ? 0.1 : -0.1,
      sourcePath:
        "supportingEvidence.spotMicrostructure.orderBook.windows.5m.depth.25bps.imbalanceMedian",
    }),
  ];
  return directionalFamily({
    family: "spot_microstructure",
    direction,
    checks,
  });
}

function derivativesFamily(scenario, derivatives = {}) {
  if (!["complete", "partial"].includes(derivatives?.status))
    return {
      family: "derivatives_positioning",
      state: "insufficient",
      checks: [],
      reason: derivatives?.reason || derivatives?.status || "unavailable",
    };
  const oi4h = finite(derivatives?.openInterest?.changePct?.["4h"]);
  const takerRatio = finite(derivatives?.positioning?.takerLongShortRatio);
  const fundingZ = finite(derivatives?.funding?.zScore30);
  const direction =
    scenario.id === "bullish_breakout"
      ? "bullish"
      : scenario.id === "bearish_breakdown"
        ? "bearish"
        : "range";
  if (direction === "range") {
    const checks = [
      evidenceCheck({
        id: "open_interest_stable_4h",
        family: "derivatives_positioning",
        state:
          Number.isFinite(oi4h) && Math.abs(oi4h) <= 1 ? "supports" : "neutral",
        actual: oi4h,
        operator: "abs<=",
        threshold: 1,
        sourcePath: "supportingEvidence.derivatives.openInterest.changePct.4h",
      }),
      evidenceCheck({
        id: "funding_not_extreme",
        family: "derivatives_positioning",
        state:
          Number.isFinite(fundingZ) && Math.abs(fundingZ) < 1
            ? "supports"
            : "neutral",
        actual: fundingZ,
        operator: "abs<",
        threshold: 1,
        sourcePath: "supportingEvidence.derivatives.funding.zScore30",
      }),
    ];
    return directionalFamily({
      family: "derivatives_positioning",
      direction,
      checks,
    });
  }
  const bullish = direction === "bullish";
  const crowded =
    Number.isFinite(fundingZ) && (bullish ? fundingZ >= 2 : fundingZ <= -2);
  const checks = [
    evidenceCheck({
      id: "open_interest_expanding_4h",
      family: "derivatives_positioning",
      state:
        Number.isFinite(oi4h) && oi4h > 0
          ? "supports"
          : Number.isFinite(oi4h) && oi4h < 0
            ? "conflicts"
            : "neutral",
      actual: oi4h,
      operator: ">",
      threshold: 0,
      sourcePath: "supportingEvidence.derivatives.openInterest.changePct.4h",
    }),
    evidenceCheck({
      id: "taker_positioning_direction",
      family: "derivatives_positioning",
      state:
        Number.isFinite(takerRatio) &&
        (bullish ? takerRatio > 1 : takerRatio < 1)
          ? "supports"
          : Number.isFinite(takerRatio) &&
              (bullish ? takerRatio < 1 : takerRatio > 1)
            ? "conflicts"
            : "neutral",
      actual: takerRatio,
      operator: bullish ? ">" : "<",
      threshold: 1,
      sourcePath:
        "supportingEvidence.derivatives.positioning.takerLongShortRatio",
    }),
    evidenceCheck({
      id: "funding_crowding_risk",
      family: "derivatives_positioning",
      state: crowded ? "conflicts" : "neutral",
      actual: fundingZ,
      operator: bullish ? "<" : ">",
      threshold: bullish ? 2 : -2,
      sourcePath: "supportingEvidence.derivatives.funding.zScore30",
    }),
  ];
  return directionalFamily({
    family: "derivatives_positioning",
    direction,
    checks,
  });
}

function verdictForScenario({
  scenario,
  timeframes,
  confluence,
  spotMicrostructure,
  derivatives,
}) {
  const families = [
    priceTrendFamily(scenario, timeframes, confluence),
    priceVolumeFamily(scenario, timeframes),
    microstructureFamily(scenario, spotMicrostructure),
    derivativesFamily(scenario, derivatives),
  ];
  const available = families.filter(({ state }) => state !== "insufficient");
  const supports = available.filter(({ state }) => state === "supports");
  const conflicts = available.filter(({ state }) => state === "conflicts");
  const supportVerdict =
    available.length < 2
      ? "insufficient"
      : supports.length >= 2 && conflicts.length === 0
        ? "supports"
        : conflicts.length >= 2
          ? "conflicts"
          : "mixed";
  return {
    scenarioId: scenario.id,
    triggerMet: scenario.triggerMet,
    confirmed: scenario.confirmed,
    supportVerdict,
    availableFamilyCount: available.length,
    supportingFamilies: supports.map(({ family }) => family),
    conflictingFamilies: conflicts.map(({ family }) => family),
    families,
  };
}

function buildSupportingEvidence({
  timeframes = {},
  confluence = {},
  scenarios = [],
  marketEvidence = {},
  relativeStrengthByTimeframe = {},
}) {
  for (const [id, relative] of Object.entries(relativeStrengthByTimeframe)) {
    if (!timeframes[id]?.indicators) continue;
    timeframes[id].indicators.relativeStrength = relative;
  }
  const result = {
    formulaVersion:
      marketEvidence.formulaVersion || SUPPORTING_EVIDENCE_VERSION,
    status: marketEvidence.status || "unavailable",
    priceVolume: Object.fromEntries(
      Object.entries(timeframes).map(([id, timeframe]) => [
        id,
        timeframe?.indicators?.moneyFlow || null,
      ])
    ),
    trendStructure: Object.fromEntries(
      Object.entries(timeframes).map(([id, timeframe]) => [
        id,
        {
          ...(timeframe?.indicators?.trendStructure || {}),
          relativeStrength: timeframe?.indicators?.relativeStrength || null,
        },
      ])
    ),
    spotMicrostructure: marketEvidence.spotMicrostructure || {
      status: "unavailable",
    },
    derivatives: marketEvidence.derivatives || {
      status: "unavailable",
    },
    scenarioVerdicts: [],
  };
  result.scenarioVerdicts = scenarios.map((scenario) =>
    verdictForScenario({
      scenario,
      timeframes,
      confluence,
      spotMicrostructure: result.spotMicrostructure,
      derivatives: result.derivatives,
    })
  );
  return result;
}

module.exports = {
  SUPPORTING_EVIDENCE_VERSION,
  _internals: {
    accumulationDistributionSeries,
    accumulationDistributionSlope,
    chaikinMoneyFlowSeries,
    confirmedPivots,
    donchian,
    efficiencyRatio,
    linearRegression,
    marketStructure,
    moneyFlowIndexSeries,
    pearsonCorrelation,
  },
  buildSupportingEvidence,
  enhancedIndicators,
  relativeStrength,
  verdictForScenario,
};
