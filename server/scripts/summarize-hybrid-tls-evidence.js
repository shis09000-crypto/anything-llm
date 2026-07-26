#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function argument(name) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(Math.ceil(sorted.length * fraction) - 1, sorted.length - 1)
  ];
}

function booleanArgument(name) {
  return String(argument(name) || "").toLowerCase() === "true";
}

try {
  const observationFile =
    argument("--observation-file") ||
    process.env.ATHENA_CRYPTO_OBSERVATION_FILE;
  if (!observationFile) throw new Error("crypto_observation_file_required");
  const cohort = Number(argument("--cohort"));
  if (![1, 5, 25, 100].includes(cohort))
    throw new Error("edge_tls_cohort_invalid");
  const baselineTtfbMs = Number(argument("--baseline-ttfb-ms"));
  if (!Number.isFinite(baselineTtfbMs) || baselineTtfbMs <= 0)
    throw new Error("edge_tls_baseline_ttfb_invalid");
  const observation = JSON.parse(
    fs.readFileSync(path.resolve(observationFile), "utf8")
  );
  const samples = (observation.edgeSamples || []).filter(
    (sample) => Number(sample.cohort) === cohort
  );
  const count = (predicate) => samples.filter(predicate).length;
  const sampleCount = samples.length;
  const ttfbValues = samples
    .map((sample) => Number(sample.ttfbMs))
    .filter(Number.isFinite);
  const handshakeValues = samples
    .map((sample) => Number(sample.handshakeDurationMs))
    .filter(Number.isFinite);
  const cpuValues = samples
    .map((sample) => Number(sample.cpuUtilization))
    .filter(Number.isFinite);
  const p95TtfbMs = percentile(ttfbValues, 0.95);
  const evidence = {
    version: 1,
    cohortPercent: cohort,
    providerSupport: {
      cdn: booleanArgument("--cdn-supported"),
      loadBalancer: booleanArgument("--load-balancer-supported"),
      envoy: booleanArgument("--envoy-supported"),
    },
    negotiatedGroup: count(
      (sample) => sample.negotiatedGroup === "X25519MLKEM768"
    )
      ? "X25519MLKEM768"
      : "unknown",
    sampleCount,
    handshakeSuccessRate:
      sampleCount > 0
        ? count((sample) => sample.outcome !== "failure") / sampleCount
        : 0,
    hybridNegotiationRate:
      sampleCount > 0
        ? count((sample) => sample.outcome === "hybrid") / sampleCount
        : 0,
    certificateValidationRate:
      sampleCount > 0
        ? count((sample) => sample.certificateVerified === true) / sampleCount
        : 0,
    middleboxBlockRate:
      sampleCount > 0
        ? count((sample) => sample.reason === "middlebox_blocked") / sampleCount
        : 0,
    classicalFallbackRate:
      sampleCount > 0
        ? count((sample) => sample.outcome === "classical") / sampleCount
        : 0,
    cpuUtilization: cpuValues.length ? Math.max(...cpuValues) : 1,
    p95HandshakeMs: percentile(handshakeValues, 0.95),
    p95TtfbMs,
    ttfbRegressionRate:
      p95TtfbMs === null
        ? 1
        : Math.max((p95TtfbMs - baselineTtfbMs) / baselineTtfbMs, 0),
    incompatibleClients: samples.reduce((acc, sample) => {
      if (sample.reason !== "none")
        acc[sample.clientClass] = (acc[sample.clientClass] || 0) + 1;
      return acc;
    }, {}),
  };
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      { success: false, error: error?.message || "edge_tls_summary_failed" },
      null,
      2
    )
  );
  process.exitCode = 1;
}
