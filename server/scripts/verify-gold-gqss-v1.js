#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FACTOR_REGISTRY,
  FACTOR_REGISTRY_SHA256,
} = require("../utils/goldAnalysis/contracts");
const { GoldAnalysisRuntime } = require("../utils/goldAnalysis/runtime");
const { GoldAnalysisStore } = require("../utils/goldAnalysis/store");
const {
  goldMarketAgent,
} = require("../utils/agents/aibitat/plugins/gold-market");
const {
  prepareGoldResultForModel,
  renderGoldMonitoringReport,
} = require("../utils/agents/aibitat/plugins/gold-market/interpretation");
const {
  managedSecretStatus,
} = require("../utils/agents/aibitat/plugins/market-data/secrets");
const {
  resolveCotRelease,
} = require("../utils/goldAnalysis/cftcReleaseCalendar");

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "probabilities",
  "predictedState",
  "priceTarget",
  "returnQuantiles",
  "tradeInstruction",
]);

function forbiddenKeys(value, currentPath = "$", findings = []) {
  if (!value || typeof value !== "object") return findings;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${currentPath}.${key}`;
    if (FORBIDDEN_PUBLIC_KEYS.has(key)) findings.push(itemPath);
    forbiddenKeys(item, itemPath, findings);
  }
  return findings;
}

function verifyMlDsa65() {
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ml-dsa-65");
    const payload = Buffer.from("athena-gold-gqss-v1");
    const signature = crypto.sign(null, payload, privateKey);
    return {
      signatureBytes: signature.length,
      verified: crypto.verify(null, payload, publicKey, signature),
      errorCode: null,
    };
  } catch (error) {
    return {
      signatureBytes: 0,
      verified: false,
      errorCode: error?.code || "ml_dsa_65_unavailable",
    };
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-gold-gqss-"));
  const store = new GoldAnalysisStore({ root });
  const runtime = new GoldAnalysisRuntime({ store });
  const startedAt = Date.now();
  const result = await runtime.analyze({ force: true });
  const durationMs = Date.now() - startedAt;
  const cacheStartedAt = Date.now();
  const cachedResult = await runtime.analyze();
  const cacheDurationMs = Date.now() - cacheStartedAt;
  const report = renderGoldMonitoringReport({ result });
  const projection = prepareGoldResultForModel(result);
  const definitions = [];
  goldMarketAgent.plugin[0].plugin().setup({
    function: (definition) => definitions.push(definition),
  });
  const factorContractComplete = FACTOR_REGISTRY.factors.every(
    (factor) =>
      factor.name &&
      factor.formula &&
      factor.sources?.length &&
      factor.frequency &&
      Number.isFinite(factor.maximumUsableDelayMs) &&
      factor.missingStrategy &&
      factor.modelEligibility
  );
  const publicKeyFindings = forbiddenKeys(result.shadowResearch);
  const reportFindings = [
    /目标价/,
    /上涨概率/,
    /下跌概率/,
    /建议(?:买入|卖出|做多|做空)/,
  ]
    .filter((pattern) => pattern.test(report))
    .map(String);
  const mlDsa65 = verifyMlDsa65();
  const shutdownRelease = resolveCotRelease("2025-09-30");
  const normalRelease = resolveCotRelease("2026-07-28");
  const checks = {
    node24: Number(process.versions.node.split(".")[0]) >= 24,
    openssl35: process.versions.openssl.startsWith("3.5."),
    uid1000: process.getuid?.() === 1000,
    mlDsa65: mlDsa65.verified,
    cftcShutdownRelease:
      new Date(shutdownRelease.availableAtMs).toISOString() ===
        "2025-11-19T20:30:00.000Z" &&
      shutdownRelease.availabilityQuality === "exact",
    cftcFallbackConservative:
      new Date(normalRelease.availableAtMs).toISOString() ===
        "2026-07-31T19:30:00.000Z" &&
      normalRelease.availabilityQuality === "estimated",
    factorCount: FACTOR_REGISTRY.factors.length === 65,
    factorContractComplete,
    toolContract:
      definitions.length === 1 &&
      definitions[0].name === "gold_market_analysis" &&
      Object.keys(definitions[0].parameters.properties || {}).length === 0 &&
      definitions[0].parameters.required.length === 0 &&
      definitions[0].modelResultMaxChars === 20_000 &&
      typeof definitions[0].prepareResultForModel === "function" &&
      typeof definitions[0].validatedContinuation === "function",
    partialOrComplete: ["partial", "complete"].includes(result.analysisStatus),
    deterministicReport: report.includes("字段：`currentMarket`"),
    publicResearchSanitized: publicKeyFindings.length === 0,
    reportPolicyValidated: reportFindings.length === 0,
    projectionBounded: projection.length <= 20_000,
    payloadBounded: result.provenance.payloadBytes <= 100 * 1_024,
    coldDurationWithinBudget: durationMs <= 8_000,
    cacheDurationWithinBudget: cacheDurationMs < 2_000,
    cacheResultStable:
      cachedResult.provenance.resultSha256 === result.provenance.resultSha256,
  };
  const twelveDataConfigured = managedSecretStatus().twelveData === true;
  const completeAcceptance =
    twelveDataConfigured &&
    result.analysisStatus === "complete" &&
    Object.values(result.timeframes || {}).every(
      (timeframe) => timeframe.status === "complete"
    );
  const output = {
    success: Object.values(checks).every(Boolean),
    completeAcceptance,
    acceptanceStatus: completeAcceptance
      ? "complete"
      : twelveDataConfigured
        ? "partial"
        : "partial/provider_not_configured",
    checks,
    runtime: {
      node: process.version,
      openssl: process.versions.openssl,
      uid: process.getuid?.(),
      durationMs,
      cacheDurationMs,
    },
    mlDsa65,
    factorRegistry: {
      count: FACTOR_REGISTRY.factors.length,
      sha256: FACTOR_REGISTRY_SHA256,
    },
    cftcReleaseCalendar: {
      shutdown: {
        availableAt: new Date(shutdownRelease.availableAtMs).toISOString(),
        availabilityQuality: shutdownRelease.availabilityQuality,
      },
      normal: {
        availableAt: new Date(normalRelease.availableAtMs).toISOString(),
        availabilityQuality: normalRelease.availabilityQuality,
      },
    },
    tool: {
      name: definitions[0]?.name || null,
      parameterCount: Object.keys(definitions[0]?.parameters?.properties || {})
        .length,
      modelResultMaxChars: definitions[0]?.modelResultMaxChars || null,
      deterministicContinuation:
        typeof definitions[0]?.validatedContinuation === "function",
    },
    result: {
      analysisStatus: result.analysisStatus,
      sourceStatuses: result.dataQuality.sourceStatuses,
      partialFailures: result.partialFailures,
      timeframes: Object.fromEntries(
        Object.entries(result.timeframes || {}).map(([id, timeframe]) => [
          id,
          {
            status: timeframe.status,
            closedBarsUsed: timeframe.closedBarsUsed,
            volumeAvailability: timeframe.volumeAvailability,
          },
        ])
      ),
      shadowStatus: result.shadowResearch.status,
      shadowAbstained: Object.values(
        result.shadowResearch.horizons || {}
      ).every((horizon) => horizon.abstained === true),
      payloadBytes: result.provenance.payloadBytes,
      projectionChars: projection.length,
      resultSha256: result.provenance.resultSha256,
      datasetManifestSha256: result.provenance.datasetManifestSha256,
      publicKeyFindings,
      reportFindings,
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  await runtime.stop();
  if (!output.success) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      success: false,
      error: error?.code || error?.message || "gold_gqss_verification_failed",
    })}\n`
  );
  process.exitCode = 1;
});
