const crypto = require("crypto");
const { canonicalJson, sha256 } = require("./canonical");

const EVENT_ENVELOPE_SCHEMA = "athena.event-envelope";
const EVENT_ENVELOPE_VERSION = "1.0";
const MAX_EVENT_BYTES = 64 * 1024;
const SENSITIVE_KEY_PATTERN =
  /(?:password|passphrase|secret|credential|private.?key|root.?key|api.?key|api.?secret|access.?token|refresh.?token|ciphertext|wrapped.?dek|plaintext.?dek|recovery.?handle|account.?balance|holdings?|positions?|trade.?content)/i;

function sensitivePaths(value, prefix = "payload", findings = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      sensitivePaths(entry, `${prefix}.${index}`, findings)
    );
    return findings;
  }
  if (!value || typeof value !== "object") return findings;
  for (const [key, entry] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (SENSITIVE_KEY_PATTERN.test(key)) findings.push(path);
    sensitivePaths(entry, path, findings);
  }
  return findings;
}

function normalizeSubject(subject = {}) {
  return {
    type: String(subject.type || "")
      .trim()
      .slice(0, 80),
    id: String(subject.id || "")
      .trim()
      .slice(0, 160),
  };
}

function createEventEnvelope({
  eventId = crypto.randomUUID(),
  eventType,
  producer,
  correlationId,
  causationId = null,
  subject,
  occurredAt = new Date().toISOString(),
  payload = {},
} = {}) {
  const envelope = {
    schema: EVENT_ENVELOPE_SCHEMA,
    schemaVersion: EVENT_ENVELOPE_VERSION,
    eventId: String(eventId),
    eventType: String(eventType || ""),
    producer: String(producer || ""),
    correlationId: String(correlationId || ""),
    causationId: causationId ? String(causationId) : null,
    subject: normalizeSubject(subject),
    occurredAt: String(occurredAt),
    payload,
    payloadHash: sha256(canonicalJson(payload)),
  };
  const validation = validateEventEnvelope(envelope);
  if (!validation.valid) {
    const error = new Error("event_envelope_invalid");
    error.code = "EVENT_ENVELOPE_INVALID";
    error.findings = validation.findings;
    throw error;
  }
  return envelope;
}

function validateEventEnvelope(value = {}) {
  const findings = [];
  if (value.schema !== EVENT_ENVELOPE_SCHEMA) findings.push("schema_invalid");
  if (value.schemaVersion !== EVENT_ENVELOPE_VERSION)
    findings.push("schema_version_invalid");
  for (const field of [
    "eventId",
    "eventType",
    "producer",
    "correlationId",
    "occurredAt",
    "payloadHash",
  ]) {
    if (!String(value[field] || "").trim()) findings.push(`${field}_missing`);
  }
  if (!Number.isFinite(Date.parse(value.occurredAt)))
    findings.push("occurred_at_invalid");
  if (
    !value.subject ||
    typeof value.subject !== "object" ||
    !String(value.subject.type || "") ||
    !String(value.subject.id || "")
  )
    findings.push("subject_invalid");
  const body = canonicalJson(value.payload ?? {});
  if (Buffer.byteLength(body) > MAX_EVENT_BYTES)
    findings.push("payload_too_large");
  if (sha256(body) !== value.payloadHash)
    findings.push("payload_hash_mismatch");
  const sensitive = sensitivePaths(value.payload ?? {});
  if (sensitive.length)
    findings.push(...sensitive.map((path) => `sensitive_field:${path}`));
  return { valid: findings.length === 0, findings };
}

module.exports = {
  EVENT_ENVELOPE_SCHEMA,
  EVENT_ENVELOPE_VERSION,
  MAX_EVENT_BYTES,
  createEventEnvelope,
  sensitivePaths,
  validateEventEnvelope,
};
