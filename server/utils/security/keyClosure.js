const crypto = require("crypto");
const fs = require("fs");
const { DataAccessCenter } = require("../dataAccess");
const { appEnvironment } = require("../environment");
const { SERVER_DATA_PURPOSE } = require("./keyCustody/providers");
const {
  initializeObservation,
  observationSummary,
} = require("./legacyKeyReadObservation");
const {
  closeLegacyWrites,
  readLegacyWritePolicy,
} = require("./legacyWritePolicy");
const { platformKeyRetirementProof } = require("./userDomainRetirementGuard");

const CLOSURE_PROOF_VERSION = "athena-key-closure-proof:v1";
const DRILL_EVIDENCE_FORMAT = "athena-key-closure-drill:v1";
const REQUIRED_EVIDENCE_KINDS = [
  "device-recovery",
  "agent-headless",
  "backup-restore",
];
const PRODUCTION_MINIMUM_OBSERVATION_MS = 30 * 24 * 60 * 60 * 1000;
const DEVELOPMENT_MINIMUM_OBSERVATION_MS = 24 * 60 * 60 * 1000;
const PRODUCTION_MAXIMUM_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEVELOPMENT_MAXIMUM_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

function normalizedKeyId(keyId) {
  const value = String(keyId || "");
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(value))
    throw new Error("key_closure_key_id_invalid");
  return value;
}

function minimumObservationMs(env = process.env) {
  const configured = Number(env.ATHENA_KEY_DECRYPT_ONLY_OBSERVATION_MS);
  if (env.NODE_ENV === "production" || env.APP_ENV === "production") {
    return Math.max(
      Number.isFinite(configured) ? configured : 0,
      PRODUCTION_MINIMUM_OBSERVATION_MS
    );
  }
  if (env.NODE_ENV === "test" && Number.isFinite(configured)) {
    return Math.max(0, configured);
  }
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEVELOPMENT_MINIMUM_OBSERVATION_MS;
}

function maximumEvidenceAgeMs(env = process.env) {
  const configured = Number(env.ATHENA_KEY_CLOSURE_EVIDENCE_MAX_AGE_MS);
  const production =
    env.NODE_ENV === "production" || env.APP_ENV === "production";
  const defaultValue = production
    ? PRODUCTION_MAXIMUM_EVIDENCE_AGE_MS
    : DEVELOPMENT_MAXIMUM_EVIDENCE_AGE_MS;
  if (!Number.isFinite(configured) || configured <= 0) return defaultValue;
  return production ? Math.min(configured, defaultValue) : configured;
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function evidenceEvent(kind) {
  if (!REQUIRED_EVIDENCE_KINDS.includes(kind))
    throw new Error("key_closure_evidence_kind_invalid");
  return `key_closure_${kind.replaceAll("-", "_")}_drill_passed`;
}

function validateDrillEvidence(
  evidence,
  expectedKind,
  {
    expectedKeyId,
    expectedEnvironment = appEnvironment(),
    now = new Date(),
  } = {}
) {
  const completedAt = Date.parse(evidence?.completedAt || "");
  const maxAgeMs = maximumEvidenceAgeMs();
  if (
    evidence?.format !== DRILL_EVIDENCE_FORMAT ||
    evidence?.kind !== expectedKind ||
    evidence?.keyId !== normalizedKeyId(expectedKeyId) ||
    evidence?.environment !== expectedEnvironment ||
    evidence?.success !== true ||
    !Array.isArray(evidence?.checks) ||
    evidence.checks.length === 0 ||
    evidence.checks.some((check) => check?.passed !== true) ||
    !Number.isFinite(completedAt) ||
    completedAt > now.getTime() + 60_000 ||
    now.getTime() - completedAt > maxAgeMs
  )
    throw new Error("key_closure_drill_evidence_invalid");
  return {
    evidenceHash: stableHash(evidence),
    completedAt: new Date(completedAt).toISOString(),
    checkCount: evidence.checks.length,
    environment: String(evidence.environment || "unknown").slice(0, 64),
    keyId: evidence.keyId,
    keyStatus: evidence.keyStatus || null,
    maxAgeMs,
  };
}

async function startDecryptOnlyObservation(
  keyId,
  { createdBy = null, now = new Date() } = {}
) {
  const id = normalizedKeyId(keyId);
  const registry = await DataAccessCenter.securityKey.registryByKeyId({
    keyId: id,
  });
  if (registry?.status !== "decrypt_only")
    throw new Error("key_closure_requires_decrypt_only_key");
  const observation = initializeObservation(id, now);
  return DataAccessCenter.securityKey.appendEvent({
    event: "key_closure_observation_started",
    keyId: id,
    purpose: registry.purpose || SERVER_DATA_PURPOSE,
    metadata: {
      startedAt: observation.startedAt,
      observationId: observation.observationId,
      minimumObservationMs: minimumObservationMs(),
    },
    createdBy,
    occurredAt: now,
  });
}

async function recordClosureEvidence(
  keyId,
  kind,
  evidence,
  { createdBy = null, now = new Date() } = {}
) {
  const id = normalizedKeyId(keyId);
  const registry = await DataAccessCenter.securityKey.registryByKeyId({
    keyId: id,
  });
  if (!registry) throw new Error("key_closure_key_not_registered");
  if (registry.status !== "decrypt_only")
    throw new Error("key_closure_evidence_requires_decrypt_only_key");
  const observation = latestEvent(
    await DataAccessCenter.securityKey.listEvents({
      keyId: id,
      limit: 500,
    }),
    "key_closure_observation_started"
  );
  if (!observation) throw new Error("key_closure_observation_not_started");
  const validated = validateDrillEvidence(evidence, kind, {
    expectedKeyId: id,
    expectedEnvironment: appEnvironment(),
    now,
  });
  return DataAccessCenter.securityKey.appendEvent({
    event: evidenceEvent(kind),
    keyId: id,
    purpose: registry.purpose || SERVER_DATA_PURPOSE,
    metadata: {
      ...validated,
      evidence,
      recordedAt: now.toISOString(),
    },
    createdBy,
    occurredAt: now,
  });
}

function latestEvent(events, eventName) {
  return events
    .filter((event) => event.event === eventName)
    .sort(
      (left, right) =>
        Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
    )[0];
}

function closureGateHash(audit) {
  return stableHash({
    version: CLOSURE_PROOF_VERSION,
    keyId: audit.keyId,
    registryStatus: audit.registryStatus,
    migrationAllowed: audit.migration.retirementAllowed,
    migrationBlockers: audit.migration.blockers,
    observation: {
      startedAt: audit.observation.startedAt,
      requiredMs: audit.observation.requiredMs,
      readHits: audit.observation.readHits,
      firstHitAt: audit.observation.firstHitAt,
      lastHitAt: audit.observation.lastHitAt,
    },
    evidence: Object.fromEntries(
      REQUIRED_EVIDENCE_KINDS.map((kind) => [
        kind,
        {
          passed: audit.evidence[kind].passed,
          evidenceHash: audit.evidence[kind].evidenceHash || null,
          completedAt: audit.evidence[kind].completedAt || null,
        },
      ])
    ),
  });
}

async function keyClosureAudit(keyId, { now = new Date() } = {}) {
  const id = normalizedKeyId(keyId);
  const [registry, events, migration] = await Promise.all([
    DataAccessCenter.securityKey.registryByKeyId({ keyId: id }),
    DataAccessCenter.securityKey.listEvents({ keyId: id, limit: 500 }),
    platformKeyRetirementProof(id, now),
  ]);
  const observationEvent = latestEvent(
    events,
    "key_closure_observation_started"
  );
  const observationStartedAt =
    observationEvent?.metadata?.startedAt ||
    observationEvent?.occurredAt?.toISOString?.() ||
    observationEvent?.occurredAt ||
    null;
  const observationId = observationEvent?.metadata?.observationId || null;
  const observationElapsedMs = observationStartedAt
    ? Math.max(0, now.getTime() - Date.parse(observationStartedAt))
    : 0;
  const requiredObservationMs = minimumObservationMs();
  const reads = observationSummary(id, {
    since: observationStartedAt,
    observationId,
  });
  const evidence = Object.fromEntries(
    REQUIRED_EVIDENCE_KINDS.map((kind) => {
      const event = latestEvent(events, evidenceEvent(kind));
      const completedAt = Date.parse(event?.metadata?.completedAt || "");
      const bound =
        event?.metadata?.keyId === id &&
        event?.metadata?.environment === appEnvironment();
      const afterObservation =
        Number.isFinite(completedAt) &&
        observationStartedAt &&
        completedAt >= Date.parse(observationStartedAt);
      const fresh =
        Number.isFinite(completedAt) &&
        now.getTime() - completedAt <= maximumEvidenceAgeMs() &&
        completedAt <= now.getTime() + 60_000;
      const passed = Boolean(event && bound && afterObservation && fresh);
      return [
        kind,
        event
          ? {
              passed,
              bound,
              afterObservation,
              fresh,
              evidenceHash: event.metadata?.evidenceHash || null,
              completedAt: event.metadata?.completedAt || null,
              recordedAt:
                event.metadata?.recordedAt ||
                event.occurredAt?.toISOString?.() ||
                event.occurredAt,
              checkCount: event.metadata?.checkCount || 0,
            }
          : { passed: false },
      ];
    })
  );
  const policy = readLegacyWritePolicy();
  const blockers = [];
  if (!registry) blockers.push("key_not_registered");
  else if (registry.status !== "decrypt_only")
    blockers.push("key_not_decrypt_only");
  if (!migration.retirementAllowed)
    blockers.push("migration_coverage_incomplete");
  if (!observationStartedAt) blockers.push("observation_not_started");
  else if (observationElapsedMs < requiredObservationMs)
    blockers.push("observation_period_incomplete");
  if (reads.readHits > 0) blockers.push("decrypt_only_read_hits_detected");
  if (
    observationStartedAt &&
    (!observationId ||
      !reads.logPresent ||
      !reads.startMarkerPresent ||
      !reads.chainValid ||
      reads.invalidRecords > 0)
  )
    blockers.push("observation_log_integrity_failed");
  for (const kind of REQUIRED_EVIDENCE_KINDS) {
    if (!evidence[kind].passed) blockers.push(`${kind}_drill_missing`);
  }
  const gateAudit = {
    version: CLOSURE_PROOF_VERSION,
    keyId: id,
    generatedAt: now.toISOString(),
    registryStatus: registry?.status || null,
    migration,
    observation: {
      startedAt: observationStartedAt,
      observationId,
      elapsedMs: observationElapsedMs,
      requiredMs: requiredObservationMs,
      readHits: reads.readHits,
      firstHitAt: reads.firstHitAt,
      lastHitAt: reads.lastHitAt,
      byDomain: reads.byDomain,
      byRuntimeRole: reads.byRuntimeRole,
      logPresent: reads.logPresent,
      startMarkerPresent: reads.startMarkerPresent,
      chainValid: reads.chainValid,
      invalidRecords: reads.invalidRecords,
    },
    evidence,
    blockers,
  };
  const gateHash = closureGateHash(gateAudit);
  const eligibleToCloseLegacyWrites = blockers.length === 0;
  const legacyWritesClosed = policy.legacyWritesClosed === true;
  const retirementBlockers = [
    ...blockers,
    ...(legacyWritesClosed ? [] : ["legacy_writes_not_closed"]),
  ];
  return {
    ...gateAudit,
    gateHash,
    eligibleToCloseLegacyWrites,
    legacyWritePolicy: policy,
    legacyWritesClosed,
    retirementAllowed: retirementBlockers.length === 0,
    retirementBlockers,
  };
}

async function closeLegacyWritesAfterAudit(
  keyId,
  { createdBy = null, now = new Date() } = {}
) {
  const audit = await keyClosureAudit(keyId, { now });
  if (!audit.eligibleToCloseLegacyWrites)
    throw new Error("key_closure_prerequisites_incomplete");
  const policy = closeLegacyWrites({
    keyId: audit.keyId,
    evidenceHash: audit.gateHash,
    now,
  });
  await DataAccessCenter.securityKey.appendEvent({
    event: "key_closure_legacy_writes_closed",
    keyId: audit.keyId,
    purpose: SERVER_DATA_PURPOSE,
    metadata: { gateHash: audit.gateHash, policy },
    createdBy,
    occurredAt: now,
  });
  return { audit, policy };
}

async function keyClosureRetirementProof(keyId, { now = new Date() } = {}) {
  const audit = await keyClosureAudit(keyId, { now });
  return {
    version: CLOSURE_PROOF_VERSION,
    keyId: audit.keyId,
    generatedAt: now.toISOString(),
    retirementAllowed: audit.retirementAllowed,
    gateHash: audit.gateHash,
    legacyWritesClosed: audit.legacyWritesClosed,
    blockers: audit.retirementBlockers,
    observation: audit.observation,
    evidence: audit.evidence,
  };
}

function assertKeyClosureRetirementProof(proof, keyId, now = new Date()) {
  const id = normalizedKeyId(keyId);
  const generatedAt = Date.parse(proof?.generatedAt || "");
  if (
    proof?.version !== CLOSURE_PROOF_VERSION ||
    proof?.keyId !== id ||
    proof?.retirementAllowed !== true ||
    proof?.legacyWritesClosed !== true ||
    !Number.isFinite(generatedAt) ||
    Math.abs(now.getTime() - generatedAt) > 5 * 60 * 1000 ||
    !Array.isArray(proof?.blockers) ||
    proof.blockers.length !== 0 ||
    Number(proof?.observation?.readHits) !== 0 ||
    proof?.observation?.logPresent !== true ||
    proof?.observation?.startMarkerPresent !== true ||
    proof?.observation?.chainValid !== true ||
    Number(proof?.observation?.invalidRecords) !== 0 ||
    Number(proof?.observation?.elapsedMs) <
      Number(proof?.observation?.requiredMs) ||
    REQUIRED_EVIDENCE_KINDS.some(
      (kind) =>
        proof?.evidence?.[kind]?.passed !== true ||
        proof?.evidence?.[kind]?.bound !== true ||
        proof?.evidence?.[kind]?.afterObservation !== true ||
        proof?.evidence?.[kind]?.fresh !== true
    )
  )
    throw new Error("key_closure_retirement_incomplete");
  return true;
}

function readDrillEvidence(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

module.exports = {
  CLOSURE_PROOF_VERSION,
  DRILL_EVIDENCE_FORMAT,
  REQUIRED_EVIDENCE_KINDS,
  assertKeyClosureRetirementProof,
  closeLegacyWritesAfterAudit,
  keyClosureAudit,
  keyClosureRetirementProof,
  maximumEvidenceAgeMs,
  minimumObservationMs,
  readDrillEvidence,
  recordClosureEvidence,
  startDecryptOnlyObservation,
  validateDrillEvidence,
};
