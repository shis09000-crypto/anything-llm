const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { storagePath } = require("../environment");

const OBSERVATION_FORMAT = "athena-decrypt-only-read-observation:v1";

function normalizedKeyId(keyId) {
  const value = String(keyId || "");
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(value))
    throw new Error("decrypt_only_observation_key_id_invalid");
  return value;
}

function observationPath(keyId) {
  return storagePath(
    "security",
    "key-closure",
    `${normalizedKeyId(keyId)}.reads.jsonl`
  );
}

function boundedLabel(value, fallback, limit = 128) {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_");
  return (normalized || fallback).slice(0, limit);
}

function resourceDigest(value) {
  if (value === null || value === undefined || value === "") return null;
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 24);
}

function appendPrivateJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(filePath, 0o600);
}

function recordHash(record) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        format: record.format,
        event: record.event,
        keyId: record.keyId,
        observationId: record.observationId,
        sequence: record.sequence,
        previousHash: record.previousHash,
        purpose: record.purpose || null,
        domain: record.domain || null,
        runtimeRole: record.runtimeRole || null,
        resourceDigest: record.resourceDigest || null,
        occurredAt: record.occurredAt,
      })
    )
    .digest("hex");
}

function readRecords(keyId) {
  const filePath = observationPath(keyId);
  if (!fs.existsSync(filePath))
    return { filePath, exists: false, records: [], invalidLines: 0 };
  let invalidLines = 0;
  const records = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        invalidLines += 1;
        return null;
      }
    })
    .filter(Boolean);
  return { filePath, exists: true, records, invalidLines };
}

function initializeObservation(keyId, now = new Date()) {
  const id = normalizedKeyId(keyId);
  const observationId = crypto.randomUUID();
  const record = {
    format: OBSERVATION_FORMAT,
    event: "observation_started",
    keyId: id,
    observationId,
    sequence: 0,
    previousHash: null,
    occurredAt: now.toISOString(),
  };
  record.recordHash = recordHash(record);
  appendPrivateJsonLine(observationPath(id), record);
  return { observationId, startedAt: record.occurredAt };
}

function activeObservation(keyId) {
  const { records } = readRecords(keyId);
  return records
    .filter(
      (record) =>
        record?.format === OBSERVATION_FORMAT &&
        record?.event === "observation_started" &&
        record?.keyId === keyId
    )
    .at(-1);
}

function incrementMetric(record) {
  try {
    const { metrics } = require("../observability/metrics");
    metrics.decryptOnlyKeyReads.inc({
      key_id: record.keyId,
      domain: record.domain,
      runtime_role: record.runtimeRole,
    });
  } catch {
    // Durable observation is authoritative. Metrics must never break decrypts.
  }
}

function recordDecryptOnlyKeyRead(descriptor, context = {}, now = new Date()) {
  if (descriptor?.status !== "decrypt_only") return null;
  const keyId = normalizedKeyId(descriptor.keyId);
  const observation = activeObservation(keyId);
  const records = observation
    ? readRecords(keyId).records.filter(
        (record) => record?.observationId === observation.observationId
      )
    : [];
  const previous = records.at(-1) || null;
  const record = {
    format: OBSERVATION_FORMAT,
    event: "decrypt_only_key_read",
    keyId,
    observationId: observation?.observationId || null,
    sequence: previous ? Number(previous.sequence) + 1 : 0,
    previousHash: previous?.recordHash || null,
    purpose: boundedLabel(descriptor.purpose, "server-data-at-rest"),
    domain: boundedLabel(context.domain || context.purpose, "secret-store", 96),
    runtimeRole: boundedLabel(
      context.runtimeRole || process.env.ATHENA_RUNTIME_ROLE,
      "api",
      64
    ),
    resourceDigest: resourceDigest(context.resource),
    occurredAt: now.toISOString(),
  };
  record.recordHash = recordHash(record);
  appendPrivateJsonLine(observationPath(record.keyId), record);
  incrementMetric(record);
  return record;
}

function observationSummary(
  keyId,
  { since = null, observationId = null } = {}
) {
  const id = normalizedKeyId(keyId);
  const { exists, records: allRecords, invalidLines } = readRecords(id);
  const sinceTimestamp = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  if (since && !Number.isFinite(sinceTimestamp))
    throw new Error("decrypt_only_observation_since_invalid");
  if (!exists) {
    return {
      format: OBSERVATION_FORMAT,
      keyId: id,
      since,
      observationId,
      logPresent: false,
      startMarkerPresent: false,
      chainValid: false,
      invalidRecords: 0,
      readHits: 0,
      firstHitAt: null,
      lastHitAt: null,
      byDomain: {},
      byRuntimeRole: {},
    };
  }
  const observationRecords = allRecords.filter(
    (record) =>
      record?.format === OBSERVATION_FORMAT &&
      record?.keyId === id &&
      (!observationId || record?.observationId === observationId) &&
      Date.parse(record.occurredAt) >= sinceTimestamp
  );
  const startMarker = observationRecords.find(
    (record) =>
      record.event === "observation_started" &&
      (!observationId || record.observationId === observationId)
  );
  let previousHash = null;
  let expectedSequence = 0;
  let chainValid = Boolean(startMarker);
  for (const record of observationRecords) {
    if (
      record.sequence !== expectedSequence ||
      record.previousHash !== previousHash ||
      record.recordHash !== recordHash(record)
    ) {
      chainValid = false;
      break;
    }
    previousHash = record.recordHash;
    expectedSequence += 1;
  }
  const records = observationRecords.filter(
    (record) => record.event === "decrypt_only_key_read"
  );
  const byDomain = {};
  const byRuntimeRole = {};
  for (const record of records) {
    byDomain[record.domain] = (byDomain[record.domain] || 0) + 1;
    byRuntimeRole[record.runtimeRole] =
      (byRuntimeRole[record.runtimeRole] || 0) + 1;
  }
  return {
    format: OBSERVATION_FORMAT,
    keyId: id,
    since,
    observationId,
    logPresent: true,
    startMarkerPresent: Boolean(startMarker),
    chainValid,
    invalidRecords: invalidLines,
    readHits: records.length,
    firstHitAt: records[0]?.occurredAt || null,
    lastHitAt: records.at(-1)?.occurredAt || null,
    byDomain,
    byRuntimeRole,
  };
}

module.exports = {
  OBSERVATION_FORMAT,
  observationPath,
  observationSummary,
  initializeObservation,
  recordDecryptOnlyKeyRead,
};
