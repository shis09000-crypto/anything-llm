const fs = require("fs");
const path = require("path");
const { metrics } = require("../observability/metrics");
const {
  PQ_CAPABILITIES,
  expectedCapabilities,
  runtimeCapabilities,
} = require("./cryptoRuntimeCapabilities");

const TLS_CHANNELS = new Set(["edge", "workload", "nats", "collector"]);
const TLS_OUTCOMES = new Set([
  "hybrid",
  "classical",
  "downgrade_rejected",
  "failure",
]);
const FAILURE_REASONS = new Set([
  "invalid_signature",
  "corrupt_public_key",
  "unknown_suite",
  "expired_key_id",
  "untrusted_key",
  "policy_downgrade",
  "runtime_unavailable",
  "other",
]);
const CERTIFICATE_ROLES = new Set([
  "api",
  "background_worker",
  "realtime_gateway",
  "collector",
  "nats",
]);
const CERTIFICATE_SLOTS = new Set(["primary", "next", "selected"]);
const KEM_OPERATIONS = new Set([
  "register",
  "seal",
  "unseal",
  "store_envelope",
]);
const KEM_OUTCOMES = new Set([
  "success",
  "invalid_envelope",
  "decapsulation_failed",
  "aead_failed",
  "epoch_mismatch",
  "rejected",
]);
const EPOCH_KINDS = new Set(["invalid", "conflict", "stale"]);
const RUNTIME_REFRESH_MS = 5 * 60 * 1000;

let lastRuntimeRefresh = 0;
let lastTlsObservation = null;
let lastEdgeSampleSeq = 0;

function cryptoFamily(suite) {
  return suite?.pqAlgorithm ? "post_quantum" : "classical";
}

function observeSuiteOperation(suite, operation, outcome) {
  if (!suite?.suiteId || !suite?.purpose) return;
  metrics.cryptoSuiteOperations.inc({
    purpose: suite.purpose,
    suite: suite.suiteId,
    operation,
    outcome,
  });
}

function observeSignatureVerification(suite, startedAt, outcome) {
  if (!suite?.suiteId) return;
  const family = cryptoFamily(suite);
  observeSuiteOperation(suite, "verify", outcome);
  metrics.cryptoSignatureVerificationDuration.observe(
    { family, suite: suite.suiteId, outcome },
    Math.max(Number(process.hrtime.bigint() - startedAt), 0) / 1_000_000_000
  );
}

function observeVerificationFailure(reason, family = "unknown") {
  const safeReason = FAILURE_REASONS.has(reason) ? reason : "other";
  const safeFamily = [
    "classical",
    "post_quantum",
    "hybrid",
    "unknown",
  ].includes(family)
    ? family
    : "unknown";
  metrics.cryptoVerificationFailures.inc({
    reason: safeReason,
    family: safeFamily,
  });
}

function observeTlsNegotiation(channel, outcome, count = 1) {
  if (!TLS_CHANNELS.has(channel) || !TLS_OUTCOMES.has(outcome)) return false;
  const amount = Number(count);
  if (!Number.isSafeInteger(amount) || amount < 1) return false;
  metrics.cryptoTlsNegotiations.inc({ channel, outcome }, amount);
  if (channel === "edge") {
    const {
      PURPOSES,
      SUITE_IDS,
      cryptoSuite,
    } = require("./cryptoSuiteRegistry");
    const suite = cryptoSuite(SUITE_IDS.EDGE_TLS_X25519_MLKEM768_V1, {
      purpose: PURPOSES.EDGE_TLS_KEY_ESTABLISHMENT,
    });
    if (suite) {
      metrics.cryptoSuiteOperations.inc(
        {
          purpose: suite.purpose,
          suite: suite.suiteId,
          operation: "handshake",
          outcome,
        },
        amount
      );
    }
  }
  return true;
}

function observeVaultKem(operation, outcome) {
  if (!KEM_OPERATIONS.has(operation) || !KEM_OUTCOMES.has(outcome))
    return false;
  metrics.cryptoVaultKemOperations.inc({ operation, outcome });
  const { PURPOSES, SUITE_IDS, cryptoSuite } = require("./cryptoSuiteRegistry");
  const suite = cryptoSuite(SUITE_IDS.VAULT_XWING_MLDSA65_V1, {
    purpose: PURPOSES.VAULT_DEVICE_AUTHORIZATION,
  });
  if (suite) observeSuiteOperation(suite, operation, outcome);
  return true;
}

function observeDeviceEpochConflict(kind) {
  if (!EPOCH_KINDS.has(kind)) return false;
  metrics.cryptoDeviceEpochConflicts.inc({ kind });
  return true;
}

function normalizedRole(role) {
  return String(role || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/^worker$/, "background_worker");
}

function observeCertificateRemaining({
  role,
  slot,
  validTo,
  now = Date.now(),
}) {
  const safeRole = normalizedRole(role);
  if (!CERTIFICATE_ROLES.has(safeRole) || !CERTIFICATE_SLOTS.has(String(slot)))
    return false;
  const expiresAt =
    validTo instanceof Date ? validTo.getTime() : Date.parse(validTo);
  if (!Number.isFinite(expiresAt)) return false;
  metrics.cryptoCertificateRemaining.set(
    { role: safeRole, slot: String(slot) },
    Math.max((expiresAt - now) / 1000, 0)
  );
  return true;
}

function refreshRuntimeCapabilities({ force = false, env = process.env } = {}) {
  const now = Date.now();
  if (!force && now - lastRuntimeRefresh < RUNTIME_REFRESH_MS) return;
  const current = runtimeCapabilities();
  const expected = expectedCapabilities(current, env);
  for (const capability of PQ_CAPABILITIES) {
    const actualValue = current[capability] ? 1 : 0;
    const expectedValue = expected[capability] ? 1 : 0;
    metrics.cryptoRuntimePqCapability.set({ capability }, actualValue);
    metrics.cryptoRuntimePqCapabilityExpected.set(
      { capability },
      expectedValue
    );
    metrics.cryptoRuntimePqCapabilityDrift.set(
      { capability },
      actualValue === expectedValue ? 0 : 1
    );
  }
  lastRuntimeRefresh = now;
}

function tlsObservationFile(env = process.env) {
  const configured = String(env.ATHENA_CRYPTO_OBSERVATION_FILE || "").trim();
  return configured ? path.resolve(configured) : null;
}

function readTlsObservation(env = process.env) {
  const file = tlsObservationFile(env);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version !== 1 || typeof parsed?.tls !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function refreshTlsObservations(env = process.env) {
  const rolloutFile = String(
    env.ATHENA_EDGE_TLS_ROLLOUT_STATE_FILE || ""
  ).trim();
  if (rolloutFile) {
    try {
      const rollout = JSON.parse(
        fs.readFileSync(path.resolve(rolloutFile), "utf8")
      );
      if (
        rollout?.policy === "edge-enforced" &&
        [0, 1, 5, 25, 100].includes(Number(rollout?.cohortPercent))
      )
        metrics.cryptoTlsRolloutPercent.set(Number(rollout.cohortPercent));
    } catch {}
  }
  const observed = readTlsObservation(env);
  if (!observed) return;
  const current = observed.tls || {};
  const previousObservation = lastTlsObservation || {};
  for (const channel of TLS_CHANNELS) {
    for (const outcome of TLS_OUTCOMES) {
      const value = Number(current?.[channel]?.[outcome] || 0);
      const previous = Number(previousObservation?.[channel]?.[outcome] || 0);
      const delta = value >= previous ? value - previous : value;
      if (delta > 0) observeTlsNegotiation(channel, outcome, delta);
    }
  }
  lastTlsObservation = structuredClone(current);
  const samples = Array.isArray(observed.edgeSamples)
    ? observed.edgeSamples
    : [];
  if (samples.length && Number(samples.at(-1)?.seq || 0) < lastEdgeSampleSeq)
    lastEdgeSampleSeq = 0;
  const newSamples = samples.filter(
    (sample) => Number(sample?.seq || 0) > lastEdgeSampleSeq
  );
  for (const sample of newSamples) {
    const cohort = String(sample.cohort);
    const outcome = TLS_OUTCOMES.has(sample.outcome)
      ? sample.outcome
      : "failure";
    const handshakeSeconds = Number(sample.handshakeDurationMs) / 1000;
    const ttfbSeconds = Number(sample.ttfbMs) / 1000;
    if (Number.isFinite(handshakeSeconds) && handshakeSeconds >= 0)
      metrics.cryptoTlsHandshakeDuration.observe(
        { cohort, outcome },
        handshakeSeconds
      );
    if (Number.isFinite(ttfbSeconds) && ttfbSeconds >= 0)
      metrics.cryptoTlsTtfbDuration.observe({ cohort, outcome }, ttfbSeconds);
    metrics.cryptoTlsClientCompatibility.inc({
      client_class: sample.clientClass,
      outcome,
      reason: sample.reason,
    });
    if (Number.isFinite(sample.cpuUtilization))
      metrics.cryptoTlsEdgeCpuUtilization.set(
        { cohort },
        Number(sample.cpuUtilization)
      );
    lastEdgeSampleSeq = Math.max(lastEdgeSampleSeq, Number(sample.seq || 0));
  }
}

function refreshCryptoObservability(options = {}) {
  refreshRuntimeCapabilities(options);
  refreshTlsObservations(options.env || process.env);
}

module.exports = {
  observeCertificateRemaining,
  observeDeviceEpochConflict,
  observeSignatureVerification,
  observeSuiteOperation,
  observeTlsNegotiation,
  observeVaultKem,
  observeVerificationFailure,
  refreshCryptoObservability,
  refreshRuntimeCapabilities,
  refreshTlsObservations,
  tlsObservationFile,
};
