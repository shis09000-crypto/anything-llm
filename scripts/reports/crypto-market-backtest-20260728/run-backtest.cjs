#!/usr/bin/env node

// CommonJS is required because the production quant-analysis modules use require().
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const {
  buildQuantAnalysis,
  FORMULA_VERSION,
} = require("../../../server/utils/agents/aibitat/plugins/crypto-market/quantAnalysis");
const {
  relativeStrength,
} = require("../../../server/utils/agents/aibitat/plugins/crypto-market/supportingEvidence");

const OUTPUT_DIR = __dirname;
const SOURCE_BASE = "https://api.gateio.ws/api/v4";
const ASSETS = ["BTC", "ETH", "SOL"];
const TIMEFRAMES = {
  // Gate limits public candlestick history to roughly 10,000 intervals.
  "1h": { intervalMs: 60 * 60_000, warmupStart: "2025-06-08T00:00:00Z" },
  "4h": {
    intervalMs: 4 * 60 * 60_000,
    warmupStart: "2024-09-01T00:00:00Z",
  },
  "1d": {
    intervalMs: 24 * 60 * 60_000,
    warmupStart: "2023-04-01T00:00:00Z",
  },
  "1w": {
    intervalMs: 7 * 24 * 60 * 60_000,
    warmupStart: "2016-01-01T00:00:00Z",
  },
};
const EVALUATION_START_MS = Date.parse("2025-07-01T00:00:00Z");
const DATA_END_MS = Date.parse("2026-07-28T00:00:00Z");
const MAX_HORIZON = 24;
const HORIZONS = [4, 12, 24];
const MARKET_EVIDENCE_UNAVAILABLE = {
  formulaVersion: "crypto-market-evidence-v1",
  status: "unavailable",
  spotMicrostructure: { status: "unavailable", reason: "historical_unavailable" },
  derivatives: { status: "unavailable", reason: "historical_unavailable" },
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(",")),
  ].join("\n");
}

function normalizeCandle(row) {
  return {
    ts: Number(row[0]) * 1_000,
    open: String(row[5]),
    high: String(row[3]),
    low: String(row[4]),
    close: String(row[2]),
    volume: String(row[1]),
  };
}

async function fetchJson(url, attempt = 1) {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return await response.json();
  } catch (error) {
    if (attempt >= 5) throw error;
    await new Promise((resolve) =>
      setTimeout(resolve, 500 * 2 ** (attempt - 1))
    );
    return fetchJson(url, attempt + 1);
  }
}

async function fetchCandles({ pair, interval, intervalMs, startMs, endMs }) {
  const byTimestamp = new Map();
  let cursorSeconds = Math.floor(endMs / 1_000);
  let requests = 0;
  while (cursorSeconds * 1_000 >= startMs) {
    const remainingIntervals =
      Math.floor((cursorSeconds * 1_000 - startMs) / intervalMs) + 1;
    const pageLimit = Math.max(1, Math.min(1_000, remainingIntervals));
    const pageFromSeconds = Math.max(
      Math.floor(startMs / 1_000),
      cursorSeconds - Math.floor((pageLimit - 1) * (intervalMs / 1_000))
    );
    const url = new URL(`${SOURCE_BASE}/spot/candlesticks`);
    url.search = new URLSearchParams({
      currency_pair: pair,
      interval,
      limit: String(pageLimit),
      from: String(pageFromSeconds),
      to: String(cursorSeconds),
    });
    const payload = await fetchJson(url);
    requests += 1;
    if (!Array.isArray(payload) || payload.length === 0) break;
    const rows = payload
      .map(normalizeCandle)
      .filter((row) => Number.isFinite(row.ts))
      .sort((left, right) => left.ts - right.ts);
    for (const row of rows) {
      if (row.ts <= endMs) byTimestamp.set(row.ts, row);
    }
    const oldest = rows[0]?.ts;
    if (!Number.isFinite(oldest) || oldest <= startMs) break;
    cursorSeconds = Math.floor(oldest / 1_000) - 1;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  return {
    rows: [...byTimestamp.values()]
      .filter((row) => row.ts >= startMs && row.ts <= endMs)
      .sort((left, right) => left.ts - right.ts),
    requests,
  };
}

function upperBound(rows, timestampMs) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].ts < timestampMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function payloadAt(rows, timestampMs) {
  const end = upperBound(rows, timestampMs);
  return {
    candles: rows.slice(Math.max(0, end - 499), end),
    cacheHit: false,
    source: "gate_backtest",
  };
}

function scenarioVerdict(analysis, scenarioId) {
  return (
    analysis.supportingEvidence?.scenarioVerdicts?.find(
      (entry) => entry.scenarioId === scenarioId
    )?.supportVerdict || "insufficient"
  );
}

function targetFor(scenario, entry, direction) {
  const eligible = (scenario.targets || [])
    .map(({ value }) => Number(value))
    .filter(Number.isFinite)
    .filter((value) => (direction === "bullish" ? value > entry : value < entry))
    .sort((left, right) =>
      direction === "bullish" ? left - right : right - left
    );
  return eligible[0] ?? null;
}

function directionalOutcome({
  scenario,
  direction,
  entry,
  futureRows,
  horizon,
}) {
  const finalClose = Number(futureRows.at(-1).close);
  const rawReturn = finalClose / entry - 1;
  const signedReturn = direction === "bullish" ? rawReturn : -rawReturn;
  const target = targetFor(scenario, entry, direction);
  const invalidation = Number(scenario.invalidation?.value);
  let firstTargetBar = null;
  let firstInvalidationBar = null;
  futureRows.forEach((bar, index) => {
    if (
      firstTargetBar === null &&
      Number.isFinite(target) &&
      (direction === "bullish"
        ? Number(bar.high) >= target
        : Number(bar.low) <= target)
    )
      firstTargetBar = index + 1;
    if (
      firstInvalidationBar === null &&
      Number.isFinite(invalidation) &&
      (direction === "bullish"
        ? Number(bar.close) < invalidation
        : Number(bar.close) > invalidation)
    )
      firstInvalidationBar = index + 1;
  });
  const targetBeforeInvalidation =
    firstTargetBar !== null &&
    (firstInvalidationBar === null || firstTargetBar < firstInvalidationBar);
  return {
    horizon,
    outcome_start_timestamp_ms: futureRows[0].ts,
    outcome_end_timestamp_ms: futureRows.at(-1).ts,
    final_close: finalClose,
    raw_return: rawReturn,
    signed_return: signedReturn,
    direction_correct: signedReturn > 0,
    direction_correct_after_10bps: signedReturn > 0.001,
    target,
    invalidation_value: invalidation,
    target_hit: firstTargetBar !== null,
    invalidated: firstInvalidationBar !== null,
    target_before_invalidation: targetBeforeInvalidation,
    first_target_bar: firstTargetBar,
    first_invalidation_bar: firstInvalidationBar,
  };
}

function rangeOutcome({ scenario, entry, futureRows, horizon }) {
  const finalClose = Number(futureRows.at(-1).close);
  const lower = Number(scenario.range?.lower);
  const upper = Number(scenario.range?.upper);
  const relaxedLower = Number(scenario.invalidation?.lower);
  const relaxedUpper = Number(scenario.invalidation?.upper);
  const finalInside = finalClose >= lower && finalClose <= upper;
  const strictPathInside = futureRows.every((bar) => {
    const close = Number(bar.close);
    return close >= lower && close <= upper;
  });
  const relaxedPathInside = futureRows.every((bar) => {
    const close = Number(bar.close);
    return close >= relaxedLower && close <= relaxedUpper;
  });
  return {
    horizon,
    outcome_start_timestamp_ms: futureRows[0].ts,
    outcome_end_timestamp_ms: futureRows.at(-1).ts,
    final_close: finalClose,
    raw_return: finalClose / entry - 1,
    signed_return: null,
    direction_correct: finalInside,
    direction_correct_after_10bps: null,
    target: null,
    invalidation_value: null,
    target_hit: null,
    invalidated: !relaxedPathInside,
    target_before_invalidation: null,
    first_target_bar: null,
    first_invalidation_bar: null,
    range_final_inside: finalInside,
    range_strict_path_inside: strictPathInside,
    range_relaxed_path_inside: relaxedPathInside,
    range_lower: lower,
    range_upper: upper,
    range_invalidation_lower: relaxedLower,
    range_invalidation_upper: relaxedUpper,
  };
}

function signalRowsForAsset(
  asset,
  candlesByTimeframe,
  benchmarkCandlesByTimeframe
) {
  const daily = candlesByTimeframe["1d"];
  const records = [];
  const signalEndMs = DATA_END_MS - MAX_HORIZON * 24 * 60 * 60_000;
  for (let dailyIndex = 0; dailyIndex < daily.length; dailyIndex += 1) {
    const signalBar = daily[dailyIndex];
    const signalNow = signalBar.ts + 24 * 60 * 60_000;
    if (signalBar.ts < EVALUATION_START_MS || signalBar.ts > signalEndMs)
      continue;
    const futureMax = daily.slice(dailyIndex + 1, dailyIndex + 1 + MAX_HORIZON);
    if (futureMax.length < MAX_HORIZON) continue;

    const timeframePayloads = Object.fromEntries(
      Object.keys(TIMEFRAMES).map((id) => [
        id,
        payloadAt(candlesByTimeframe[id], signalNow),
      ])
    );
    const relativeStrengthByTimeframe =
      asset === "BTC"
        ? {}
        : Object.fromEntries(
            Object.keys(TIMEFRAMES).map((id) => [
              id,
              relativeStrength(
                timeframePayloads[id].candles,
                payloadAt(benchmarkCandlesByTimeframe[id], signalNow).candles
              ),
            ])
          );
    const analysis = buildQuantAnalysis({
      timeframePayloads,
      now: signalNow,
      partialFailures: [],
      marketEvidence: MARKET_EVIDENCE_UNAVAILABLE,
      relativeStrengthByTimeframe,
    });
    const entry = Number(signalBar.close);
    const dailyRegime = analysis.timeframes["1d"]?.regime?.state || null;
    for (const scenario of analysis.scenarios || []) {
      const direction =
        scenario.id === "bullish_breakout"
          ? "bullish"
          : scenario.id === "bearish_breakdown"
            ? "bearish"
            : "range";
      for (const horizon of HORIZONS) {
        const futureRows = futureMax.slice(0, horizon);
        const outcome =
          direction === "range"
            ? rangeOutcome({ scenario, entry, futureRows, horizon })
            : directionalOutcome({
                scenario,
                direction,
                entry,
                futureRows,
                horizon,
              });
        records.push({
          asset,
          signal_date: new Date(signalBar.ts).toISOString().slice(0, 10),
          signal_timestamp_ms: signalBar.ts,
          decision_timestamp_ms: signalNow,
          scenario_id: scenario.id,
          direction,
          trigger_met: scenario.triggerMet,
          confirmed: scenario.confirmed,
          support_verdict: scenarioVerdict(analysis, scenario.id),
          confluence_state: analysis.confluence.state,
          daily_regime: dailyRegime,
          entry_close: entry,
          ...outcome,
        });
      }
    }
  }
  return records;
}

async function main() {
  const startedAt = new Date();
  const rawPath = path.join(OUTPUT_DIR, "raw-candles.json.gz");
  const metadataPath = path.join(OUTPUT_DIR, "metadata.json");
  let rawData = {};
  let requestCounts = {};
  let rawDataOrigin = "gate_live_fetch";
  if (process.env.BACKTEST_REUSE_RAW === "1" && fs.existsSync(rawPath)) {
    rawData = JSON.parse(zlib.gunzipSync(fs.readFileSync(rawPath)));
    requestCounts = fs.existsSync(metadataPath)
      ? JSON.parse(fs.readFileSync(metadataPath)).requestCounts
      : {};
    rawDataOrigin = "reused_sha_pinned_raw_candles";
    console.log("reusing existing SHA-pinned raw candle snapshot");
  } else {
    for (const asset of ASSETS) {
      rawData[asset] = {};
      requestCounts[asset] = {};
      for (const [id, config] of Object.entries(TIMEFRAMES)) {
        const pair = `${asset}_USDT`;
        process.stdout.write(`fetch ${pair} ${id} ... `);
        const fetched = await fetchCandles({
          pair,
          interval: id,
          intervalMs: config.intervalMs,
          startMs: Date.parse(config.warmupStart),
          endMs: DATA_END_MS,
        });
        rawData[asset][id] = fetched.rows;
        requestCounts[asset][id] = fetched.requests;
        console.log(`${fetched.rows.length} rows`);
      }
    }
  }

  const records = ASSETS.flatMap((asset) =>
    signalRowsForAsset(asset, rawData[asset], rawData.BTC)
  );
  const rawJson = JSON.stringify(rawData);
  const rawGzip = zlib.gzipSync(rawJson, { level: 9 });
  const csv = toCsv(records);
  const metadata = {
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    source: {
      provider: "Gate",
      endpoint: `${SOURCE_BASE}/spot/candlesticks`,
      market: "spot",
      quote: "USDT",
      snapshotOrigin: rawDataOrigin,
    },
    assets: ASSETS,
    timeframes: Object.keys(TIMEFRAMES),
    evaluationStart: new Date(EVALUATION_START_MS).toISOString(),
    dataEnd: new Date(DATA_END_MS).toISOString(),
    maximumOutcomeHorizonBars: MAX_HORIZON,
    horizonsBars: HORIZONS,
    outcomeBar: "natural UTC daily candle",
    formulaVersion: FORMULA_VERSION,
    supportingEvidenceScope:
      "K-line price-trend, price-volume, and relative-to-BTC families only; historical order-flow and derivatives snapshots unavailable.",
    historicalClosedCandleLimitPerTimeframe: 499,
    requestCounts,
    rowCount: records.length,
    signalDateCount: new Set(
      records.map((row) => `${row.asset}:${row.signal_date}`)
    ).size,
    rawDataBytes: Buffer.byteLength(rawJson),
    rawDataGzipBytes: rawGzip.length,
    rawDataSha256: sha256(rawJson),
    recordsSha256: sha256(csv),
    codeSha256: {
      quantAnalysis: sha256(
        fs.readFileSync(
          path.join(
            __dirname,
            "../../../server/utils/agents/aibitat/plugins/crypto-market/quantAnalysis.js"
          )
        )
      ),
      supportingEvidence: sha256(
        fs.readFileSync(
          path.join(
            __dirname,
            "../../../server/utils/agents/aibitat/plugins/crypto-market/supportingEvidence.js"
          )
        )
      ),
    },
    limitations: [
      "Overlapping daily signals are correlated; notebook reports cooldown sensitivity.",
      "Accuracy is descriptive, not a calibrated probability.",
      "No survivorship-free universe: only BTC, ETH, and SOL are tested.",
      "No historical order-book, trade-flow, derivatives, or latency replay.",
      "A 10 bps round-trip threshold is a sensitivity check, not a trading cost guarantee.",
    ],
  };

  fs.writeFileSync(path.join(OUTPUT_DIR, "backtest-records.csv"), csv);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "raw-candles.json.gz"),
    rawGzip
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "metadata.json"),
    JSON.stringify(metadata, null, 2)
  );
  console.log(
    JSON.stringify(
      {
        records: records.length,
        signalDates: metadata.signalDateCount,
        rawDataSha256: metadata.rawDataSha256,
        recordsSha256: metadata.recordsSha256,
        elapsedMs: Date.now() - startedAt.getTime(),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
