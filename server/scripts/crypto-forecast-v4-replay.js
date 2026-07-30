#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const {
  FEATURE_REGISTRY_V3_SHA256,
  FEATURE_REGISTRY_V4_SHA256,
  FEATURE_REGISTRY_V5_SHA256,
  canonicalJson,
  sha256,
} = require("../utils/cryptoForecasting/contracts");
const {
  HORIZONS,
  SUPPORTED_SYMBOLS,
} = require("../utils/cryptoForecasting/constants");
const {
  buildFeatureVectorV3,
  buildFeatureVectorV4,
  buildFeatureVectorV5,
  costFirstTouchBarrierRatio,
  labelBandRatio,
} = require("../utils/cryptoForecasting/features");
const {
  ForecastModelRuntime,
  _internals: { featureNamesForEntry },
} = require("../utils/cryptoForecasting/modelRuntime");

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`missing_${name.replaceAll("-", "_")}`);
  return value;
}

function rowToBar(row) {
  return {
    symbol: row.symbol,
    interval: row.interval,
    openTimeMs: row.open_time_ms,
    closeTimeMs: row.close_time_ms,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    quoteVolume: row.quote_volume,
    tradeCount: row.trade_count,
    takerBuyBaseVolume: row.taker_buy_base_volume,
    takerBuyQuoteVolume: row.taker_buy_quote_volume,
    source: row.source,
    availableAtMs: row.available_at_ms ?? row.close_time_ms + 1,
    availabilityEstimated:
      row.availability_estimated === null
        ? true
        : Boolean(row.availability_estimated),
    availabilityQuality:
      row.availability_quality ||
      (row.availability_estimated ? "estimated" : "exact"),
    gapDetected: Boolean(row.gap_detected),
  };
}

function upperBound(bars, closeTimeMs) {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle].closeTimeMs <= closeTimeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function candidateState(probabilityDetails, entry) {
  const thresholds = entry.thresholds || {};
  const action = Number(probabilityDetails.actionProbability || 0);
  if (entry.decisionLayers) {
    if (action < Number(thresholds.minActionProbability ?? 1)) return "range";
    return Number(
      probabilityDetails.conditionalDirectionProbability?.up || 0
    ) >= Number(probabilityDetails.conditionalDirectionProbability?.down || 0)
      ? "up"
      : "down";
  }
  const probabilities = probabilityDetails.probabilities;
  return entry.classOrder[probabilities.indexOf(Math.max(...probabilities))];
}

function independentlySelected(probabilityDetails, entry, features) {
  const thresholds = entry.thresholds || {};
  if (features.evidenceCoverage < Number(thresholds.minEvidenceCoverage ?? 0.9))
    return false;
  if (!entry.decisionLayers) {
    const ordered = [...probabilityDetails.probabilities].sort(
      (left, right) => right - left
    );
    return (
      ordered[0] >= Number(thresholds.default ?? 1) &&
      ordered[0] - ordered[1] >= Number(thresholds.margin ?? 0.1)
    );
  }
  const direction = Math.max(
    Number(probabilityDetails.conditionalDirectionProbability?.up || 0),
    Number(probabilityDetails.conditionalDirectionProbability?.down || 0)
  );
  if (
    Number(probabilityDetails.predictionHeads?.tailRisk?.probability || 0) >
    Number(thresholds.maxTailRiskProbability ?? 1)
  )
    return false;
  if (
    Number(
      probabilityDetails.predictionHeads?.marketState?.probabilities?.stress ||
        0
    ) > Number(thresholds.maxStressProbability ?? 1)
  )
    return false;
  if (
    entry.decisionLayers?.tradeabilityMeta &&
    Number(entry.derivativesCoverage?.shortExecutionCoverage || 0) <
      Number(thresholds.minimumDerivativesCoverage ?? 0.95)
  )
    return false;
  return (
    Number(probabilityDetails.actionProbability || 0) >=
      Number(thresholds.minActionProbability ?? 1) &&
    direction >= Number(thresholds.minDirectionProbability ?? 1)
  );
}

async function main() {
  const databasePath = path.resolve(requiredOption("database"));
  const modelRoot = path.resolve(requiredOption("model-root"));
  const outputPath = path.resolve(requiredOption("output"));
  const fromMs = Date.parse(option("from", "2025-01-01T00:00:00.000Z"));
  const toMs = Date.parse(option("to", new Date().toISOString()));
  const cadence = option("cadence", "nonoverlap");
  const traceLimit = Math.max(
    0,
    Math.min(500, Number(option("trace-limit", "50")))
  );
  const requestedHorizons = option("horizons", "4h,24h")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => ["4h", "24h"].includes(value));
  if (!requestedHorizons.length) throw new Error("invalid_replay_horizons");
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs)
    throw new Error("invalid_replay_range");
  if (!["nonoverlap", "hourly"].includes(cadence))
    throw new Error("invalid_replay_cadence");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const db = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  const historyFromMs = fromMs - 40 * 24 * 60 * 60 * 1_000;
  const barsBySymbol = {};
  try {
    for (const symbol of SUPPORTED_SYMBOLS)
      barsBySymbol[symbol] = db
        .prepare(
          `SELECT * FROM market_bars
           WHERE symbol=? AND interval='5m'
             AND close_time_ms>=? AND open_time_ms<=?
           ORDER BY open_time_ms`
        )
        .all(symbol, historyFromMs, toMs)
        .map(rowToBar);
  } finally {
    db.close();
  }
  const runtime = new ForecastModelRuntime({
    root: path.dirname(path.dirname(modelRoot)),
    env: {
      ...process.env,
      ATHENA_CRYPTO_FORECAST_REQUIRE_SIGNATURE:
        process.env.ATHENA_CRYPTO_FORECAST_REQUIRE_SIGNATURE || "false",
    },
  });
  runtime.activeRoot = modelRoot;
  runtime.previousRoot = modelRoot;
  await runtime.load({ force: true });
  const manifest = runtime.loaded.manifest;
  const featureRegistrySha256 = manifest.featureRegistrySha256;
  const buildFeatures =
    featureRegistrySha256 === FEATURE_REGISTRY_V5_SHA256
      ? buildFeatureVectorV5
      : featureRegistrySha256 === FEATURE_REGISTRY_V4_SHA256
        ? buildFeatureVectorV4
        : featureRegistrySha256 === FEATURE_REGISTRY_V3_SHA256
          ? buildFeatureVectorV3
          : null;
  if (!buildFeatures) throw new Error("replay_requires_v3_v4_or_v5_registry");
  const auditTraceQuotaPerGroup =
    [FEATURE_REGISTRY_V4_SHA256, FEATURE_REGISTRY_V5_SHA256].includes(
      featureRegistrySha256
    ) && traceLimit > 0
      ? Math.ceil(
          traceLimit / (requestedHorizons.length * SUPPORTED_SYMBOLS.length)
        )
      : 0;
  const handle = fs.openSync(outputPath, "w", 0o600);
  let written = 0;
  let traces = 0;
  try {
    for (const horizon of requestedHorizons) {
      const horizonEntry = manifest.horizons[horizon];
      const featureNames = featureNamesForEntry(
        manifest,
        horizon,
        horizonEntry
      );
      const stepMs =
        cadence === "hourly" ? 60 * 60 * 1_000 : HORIZONS[horizon].durationMs;
      const groups = await Promise.all(
        SUPPORTED_SYMBOLS.map(async (symbol) => {
          const records = [];
          const symbolBars = barsBySymbol[symbol];
          let previousDecision = -Infinity;
          let previousRiskHeadDecision = -Infinity;
          let groupTraces = 0;
          for (const bar of symbolBars) {
            const decisionAtMs = bar.closeTimeMs + 1;
            if (decisionAtMs < fromMs || decisionAtMs > toMs) continue;
            if (new Date(bar.openTimeMs).getUTCMinutes() !== 55) continue;
            if (decisionAtMs - previousDecision < stepMs) continue;
            previousDecision = decisionAtMs;
            const windowBySymbol = Object.fromEntries(
              SUPPORTED_SYMBOLS.map((candidate) => {
                const candidateBars = barsBySymbol[candidate];
                const end = upperBound(candidateBars, bar.closeTimeMs);
                return [
                  candidate,
                  candidateBars.slice(Math.max(0, end - 10_000), end),
                ];
              })
            );
            const features = buildFeatures({
              horizon,
              symbol,
              bars: windowBySymbol[symbol],
              marketBarsBySymbol: windowBySymbol,
              featureNames,
              asOfMs: bar.closeTimeMs,
              decisionAtMs,
            });
            if (!features.vector) continue;
            const details = await runtime.probabilityDetails(
              horizon,
              features.vector,
              { values: features.values }
            );
            const shouldTrace = groupTraces < auditTraceQuotaPerGroup;
            const shouldAuditRiskHeads =
              [FEATURE_REGISTRY_V4_SHA256, FEATURE_REGISTRY_V5_SHA256].includes(
                featureRegistrySha256
              ) &&
              decisionAtMs - previousRiskHeadDecision >=
                HORIZONS[horizon].durationMs;
            if (shouldAuditRiskHeads) previousRiskHeadDecision = decisionAtMs;
            const heads =
              shouldTrace || shouldAuditRiskHeads
                ? details.predictionHeads ||
                  (await runtime.predictionHeads(
                    horizon,
                    features.vector,
                    features.values
                  ))
                : null;
            if (shouldTrace) groupTraces += 1;
            records.push({
              schema: "athena.crypto.forecast-audit-replay",
              schemaVersion: "1.0",
              replayCadence: cadence,
              modelVersion: manifest.modelVersion,
              modelManifestSha256: runtime.loaded.manifestSha256,
              modelSignatureValid: runtime.loaded.signatureValid,
              featureRegistrySha256,
              passportRef: sha256(
                canonicalJson({
                  modelManifestSha256: runtime.loaded.manifestSha256,
                  featureRegistrySha256,
                  symbol,
                  horizon,
                  decisionAtMs,
                })
              ),
              symbol,
              horizon,
              decisionAtMs,
              asOfMs: bar.closeTimeMs,
              outcomeDueMs: bar.closeTimeMs + HORIZONS[horizon].durationMs,
              probabilities: Object.fromEntries(
                horizonEntry.classOrder.map((name, index) => [
                  name,
                  Number(details.probabilities[index].toFixed(12)),
                ])
              ),
              actionProbability: details.actionProbability,
              tradeabilityProbability: details.tradeabilityProbability ?? null,
              conditionalDirectionProbability:
                details.conditionalDirectionProbability,
              conditionalSideProbability:
                details.conditionalSideProbability || null,
              labelPolicyVersion: horizonEntry.labelPolicyVersion || null,
              metaVector: shouldTrace ? details.metaVector || null : null,
              candidateState: candidateState(details, horizonEntry),
              selectedIgnoringShadow: independentlySelected(
                details,
                horizonEntry,
                features
              ),
              evidenceCoverage: features.evidenceCoverage,
              labelBandRatio: labelBandRatio(
                windowBySymbol[symbol],
                HORIZONS[horizon].durationMs
              ),
              labelBarrierRatio:
                horizonEntry.labelPolicyVersion === "cost-first-touch-v5"
                  ? costFirstTouchBarrierRatio(
                      windowBySymbol[symbol],
                      horizonEntry.labelContract?.selectedBarrierMultiplier,
                      {
                        horizonDurationMs: HORIZONS[horizon].durationMs,
                        feeBpsPerSide:
                          horizonEntry.labelContract?.feeBpsPerSide,
                        slippageBpsPerSide:
                          horizonEntry.labelContract?.labelSlippageBpsPerSide,
                        safetyBufferBps:
                          horizonEntry.labelContract?.safetyBufferBps,
                      }
                    )
                  : null,
              featureVectorSha256: sha256(canonicalJson(features.vector)),
              maximumAvailableAtMs: Math.max(
                ...windowBySymbol[symbol].map((value) => value.availableAtMs)
              ),
              availabilityEstimated: windowBySymbol[symbol].some(
                (value) => value.availabilityEstimated
              ),
              riskHeads:
                featureRegistrySha256 === FEATURE_REGISTRY_V5_SHA256
                  ? heads
                  : shouldAuditRiskHeads
                    ? heads
                    : null,
              trace: shouldTrace
                ? {
                    featureNames,
                    featureValues: features.values,
                    featureVector: features.vector,
                    missing: features.missing,
                    predictionHeads: heads,
                  }
                : null,
            });
          }
          return { records, traces: groupTraces };
        })
      );
      for (const group of groups) {
        for (const record of group.records)
          fs.writeSync(handle, `${JSON.stringify(record)}\n`);
        written += group.records.length;
        traces += group.traces;
      }
    }
  } finally {
    fs.closeSync(handle);
  }
  const outputSha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(outputPath))
    .digest("hex");
  process.stdout.write(
    `${JSON.stringify({
      output: outputPath,
      outputSha256,
      records: written,
      traces,
      cadence,
      modelVersion: manifest.modelVersion,
      signatureValid: runtime.loaded.signatureValid,
    })}\n`
  );
}

if (require.main === module)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error: error?.code || error?.message || "forecast_replay_failed",
      })
    );
    process.exitCode = 1;
  });

module.exports = { main };
