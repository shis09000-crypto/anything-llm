const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROLLOUT_STAGES = Object.freeze([0, 1, 5, 25, 100]);
const REQUIRED_EDGE_COMPONENTS = Object.freeze([
  "cdn",
  "loadBalancer",
  "envoy",
]);

const DEFAULT_GATES = Object.freeze({
  minimumSamples: 100,
  minimumHandshakeSuccessRate: 0.995,
  minimumHybridNegotiationRate: 0.99,
  minimumCertificateValidationRate: 1,
  maximumMiddleboxBlockRate: 0.005,
  maximumClassicalFallbackRate: 0.01,
  maximumCpuUtilization: 0.8,
  maximumTtfbRegressionRate: 0.1,
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function evidenceDigest(evidence) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(evidence))
    .digest("hex");
}

function emptyRolloutState() {
  return {
    version: 1,
    cohortPercent: 0,
    previousCohortPercent: 0,
    status: "disabled",
    policy: "edge-enforced",
    hybridGroup: "X25519MLKEM768",
    fallbackGroup: "X25519",
    updatedAt: new Date(0).toISOString(),
    evidenceSha256: null,
    changeReason: "not_started",
  };
}

function assertState(state) {
  if (
    state?.version !== 1 ||
    !ROLLOUT_STAGES.includes(Number(state?.cohortPercent)) ||
    state?.policy !== "edge-enforced"
  )
    throw new Error("edge_tls_rollout_state_invalid");
  return state;
}

function readRolloutState(file) {
  if (!file) return emptyRolloutState();
  const target = path.resolve(file);
  try {
    return assertState(JSON.parse(fs.readFileSync(target, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyRolloutState();
    if (error?.message === "edge_tls_rollout_state_invalid") throw error;
    throw new Error("edge_tls_rollout_state_invalid");
  }
}

function numericRate(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1)
    throw new Error(`edge_tls_evidence_${name}_invalid`);
  return number;
}

function validateEvidence(evidence, gates = DEFAULT_GATES) {
  if (!evidence || evidence.version !== 1)
    throw new Error("edge_tls_evidence_invalid");
  const support = evidence.providerSupport || {};
  const failures = [];
  for (const component of REQUIRED_EDGE_COMPONENTS) {
    if (support[component] !== true)
      failures.push(`provider_${component}_unsupported`);
  }
  if (String(evidence.negotiatedGroup) !== "X25519MLKEM768")
    failures.push("hybrid_group_not_observed");

  const sampleCount = Number(evidence.sampleCount);
  if (!Number.isSafeInteger(sampleCount) || sampleCount < gates.minimumSamples)
    failures.push("insufficient_samples");

  const handshakeSuccessRate = numericRate(
    evidence.handshakeSuccessRate,
    "handshake_success_rate"
  );
  const hybridNegotiationRate = numericRate(
    evidence.hybridNegotiationRate,
    "hybrid_negotiation_rate"
  );
  const certificateValidationRate = numericRate(
    evidence.certificateValidationRate,
    "certificate_validation_rate"
  );
  const middleboxBlockRate = numericRate(
    evidence.middleboxBlockRate,
    "middlebox_block_rate"
  );
  const classicalFallbackRate = numericRate(
    evidence.classicalFallbackRate,
    "classical_fallback_rate"
  );
  const cpuUtilization = numericRate(
    evidence.cpuUtilization,
    "cpu_utilization"
  );
  const ttfbRegressionRate = numericRate(
    evidence.ttfbRegressionRate,
    "ttfb_regression_rate"
  );

  if (handshakeSuccessRate < gates.minimumHandshakeSuccessRate)
    failures.push("handshake_success_rate_below_gate");
  if (hybridNegotiationRate < gates.minimumHybridNegotiationRate)
    failures.push("hybrid_negotiation_rate_below_gate");
  if (certificateValidationRate < gates.minimumCertificateValidationRate)
    failures.push("certificate_validation_rate_below_gate");
  if (middleboxBlockRate > gates.maximumMiddleboxBlockRate)
    failures.push("middlebox_block_rate_above_gate");
  if (classicalFallbackRate > gates.maximumClassicalFallbackRate)
    failures.push("classical_fallback_rate_above_gate");
  if (cpuUtilization > gates.maximumCpuUtilization)
    failures.push("cpu_utilization_above_gate");
  if (ttfbRegressionRate > gates.maximumTtfbRegressionRate)
    failures.push("ttfb_regression_rate_above_gate");

  return {
    ok: failures.length === 0,
    failures,
    digest: evidenceDigest(evidence),
  };
}

function nextRolloutStage(current) {
  const index = ROLLOUT_STAGES.indexOf(Number(current));
  return index >= 0 && index < ROLLOUT_STAGES.length - 1
    ? ROLLOUT_STAGES[index + 1]
    : null;
}

function planPromotion({ state, targetPercent, evidence }) {
  const current = assertState(state || emptyRolloutState());
  const target = Number(targetPercent);
  if (!ROLLOUT_STAGES.includes(target) || target === 0)
    throw new Error("edge_tls_rollout_target_invalid");
  if (target !== nextRolloutStage(current.cohortPercent))
    throw new Error("edge_tls_rollout_stage_skip_forbidden");
  const validation = validateEvidence(evidence);
  if (!validation.ok) {
    const error = new Error("edge_tls_rollout_gate_failed");
    error.failures = validation.failures;
    throw error;
  }
  return {
    ...current,
    cohortPercent: target,
    previousCohortPercent: current.cohortPercent,
    status: target === 100 ? "fully_enabled" : "canary",
    updatedAt: new Date().toISOString(),
    evidenceSha256: validation.digest,
    changeReason: `promote_${current.cohortPercent}_to_${target}`,
  };
}

function planRollback({
  state,
  targetPercent = 0,
  reason = "operator_rollback",
}) {
  const current = assertState(state || emptyRolloutState());
  const target = Number(targetPercent);
  if (
    !ROLLOUT_STAGES.includes(target) ||
    target >= Number(current.cohortPercent)
  )
    throw new Error("edge_tls_rollout_rollback_target_invalid");
  return {
    ...current,
    cohortPercent: target,
    previousCohortPercent: current.cohortPercent,
    status: target === 0 ? "disabled" : "rolled_back",
    updatedAt: new Date().toISOString(),
    changeReason: String(reason || "operator_rollback").slice(0, 120),
  };
}

function writeRolloutState(file, state) {
  if (!file) throw new Error("edge_tls_rollout_state_file_required");
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify(assertState(state), null, 2)}\n`,
    {
      mode: 0o600,
      flag: "wx",
    }
  );
  fs.renameSync(temporary, target);
  return target;
}

module.exports = {
  DEFAULT_GATES,
  ROLLOUT_STAGES,
  emptyRolloutState,
  evidenceDigest,
  nextRolloutStage,
  planPromotion,
  planRollback,
  readRolloutState,
  validateEvidence,
  writeRolloutState,
};
