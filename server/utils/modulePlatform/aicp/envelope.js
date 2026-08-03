const crypto = require("crypto");
const { canonicalJson, sha256 } = require("../canonical");
const { sensitivePaths } = require("../eventEnvelope");
const {
  AICP_SCHEMA,
  AICP_VERSION,
  CALL_TYPE_SET,
  CONTROL_CALL_TYPES,
  DATA_CLASSIFICATIONS,
  MAX_AICP_PAYLOAD_BYTES,
  PRIORITIES,
} = require("./constants");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/;
const CAPABILITY_ID = /^[a-z0-9][a-z0-9_.:-]{1,159}$/;

function cleanId(value, max = 192) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function normalizeAuth(auth = {}) {
  return {
    principalAssertionId: cleanId(auth.principalAssertionId),
    scopes: Array.isArray(auth.scopes)
      ? [
          ...new Set(
            auth.scopes.map((scope) => cleanId(scope, 120)).filter(Boolean)
          ),
        ].sort()
      : [],
    approvalId: cleanId(auth.approvalId) || null,
  };
}

function normalizeError(error = null) {
  if (!error || typeof error !== "object") return null;
  return {
    code: cleanId(error.code, 160),
    retryable: error.retryable === true,
    detailsHash: /^[a-f0-9]{64}$/.test(String(error.detailsHash || ""))
      ? String(error.detailsHash)
      : null,
  };
}

function normalizeTelemetry(telemetry = {}) {
  return {
    sampled: telemetry.sampled === true,
    metricSet: Array.isArray(telemetry.metricSet)
      ? [
          ...new Set(
            telemetry.metricSet
              .map((entry) => cleanId(entry, 120))
              .filter(Boolean)
          ),
        ].sort()
      : [],
  };
}

function validateAicpEnvelope(value = {}, { now = Date.now() } = {}) {
  const findings = [];
  if (value.schema !== AICP_SCHEMA) findings.push("schema_invalid");
  if (value.schemaVersion !== AICP_VERSION)
    findings.push("schema_version_invalid");
  for (const field of [
    "envelopeId",
    "callType",
    "capability",
    "producer",
    "target",
    "correlationId",
    "occurredAt",
    "deadlineAt",
    "priority",
    "dataClassification",
    "payloadHash",
    "resultHash",
  ]) {
    if (!String(value[field] || "").trim()) findings.push(`${field}_missing`);
  }
  for (const field of ["envelopeId", "producer", "target", "correlationId"]) {
    if (value[field] && !SAFE_ID.test(String(value[field])))
      findings.push(`${field}_invalid`);
  }
  if (!CALL_TYPE_SET.has(value.callType)) findings.push("call_type_invalid");
  if (!PRIORITIES.has(value.priority)) findings.push("priority_invalid");
  if (!DATA_CLASSIFICATIONS.has(value.dataClassification))
    findings.push("data_classification_invalid");
  if (!CAPABILITY_ID.test(String(value.capability || "")))
    findings.push("capability_invalid");
  const occurredAt = Date.parse(value.occurredAt);
  const deadlineAt = Date.parse(value.deadlineAt);
  if (!Number.isFinite(occurredAt) || !Number.isFinite(deadlineAt))
    findings.push("time_invalid");
  else {
    if (occurredAt > now + 5_000) findings.push("occurred_in_future");
    if (deadlineAt <= occurredAt) findings.push("deadline_invalid");
    if (deadlineAt - occurredAt > 24 * 60 * 60 * 1_000)
      findings.push("deadline_too_long");
  }
  if (
    ["Task", "Command"].includes(value.callType) &&
    !String(value.idempotencyKey || "")
  )
    findings.push("idempotency_key_required");
  if (value.idempotencyKey && !SAFE_ID.test(String(value.idempotencyKey)))
    findings.push("idempotency_key_invalid");
  if (!value.auth || typeof value.auth !== "object")
    findings.push("auth_missing");
  else {
    if (!String(value.auth.principalAssertionId || ""))
      findings.push("principal_assertion_id_missing");
    if (!Array.isArray(value.auth.scopes)) findings.push("auth_scopes_invalid");
    if (
      CONTROL_CALL_TYPES.has(value.callType) &&
      !String(value.auth.approvalId || "")
    )
      findings.push("approval_id_required");
  }
  if (!value.flags || typeof value.flags !== "object")
    findings.push("flags_missing");
  else if (
    CONTROL_CALL_TYPES.has(value.callType) &&
    value.flags.requiresApproval !== true
  )
    findings.push("approval_flag_required");
  if (!value.telemetry || typeof value.telemetry !== "object")
    findings.push("telemetry_missing");
  if (
    value.error !== null &&
    (!value.error || typeof value.error !== "object" || !value.error.code)
  )
    findings.push("error_invalid");
  const payload = value.payload ?? {};
  const result = value.result ?? null;
  const body = canonicalJson(payload);
  const resultBody = canonicalJson(result);
  if (
    Buffer.byteLength(body) + Buffer.byteLength(resultBody) >
    MAX_AICP_PAYLOAD_BYTES
  )
    findings.push("payload_too_large");
  if (sha256(body) !== value.payloadHash)
    findings.push("payload_hash_mismatch");
  if (sha256(resultBody) !== value.resultHash)
    findings.push("result_hash_mismatch");
  const sensitive = sensitivePaths(payload);
  sensitivePaths(result, "result", sensitive);
  if (sensitive.length)
    findings.push(...sensitive.map((path) => `sensitive_field:${path}`));
  return { valid: findings.length === 0, findings };
}

function createAicpEnvelope({
  envelopeId = crypto.randomUUID(),
  callType,
  capability,
  producer,
  target,
  correlationId = crypto.randomUUID(),
  causationId = null,
  operationId = null,
  traceId = null,
  occurredAt = new Date().toISOString(),
  timeoutMs = 30_000,
  deadlineAt = null,
  idempotencyKey = null,
  priority = "P2",
  dataClassification = "internal",
  auth,
  flags = {},
  payload = {},
  result = null,
  error = null,
  telemetry = {},
} = {}) {
  const occurredMs = Date.parse(occurredAt);
  const boundedTimeout = Math.max(
    1_000,
    Math.min(Number(timeoutMs) || 30_000, 24 * 60 * 60 * 1_000)
  );
  const envelope = {
    schema: AICP_SCHEMA,
    schemaVersion: AICP_VERSION,
    envelopeId: cleanId(envelopeId),
    callType: String(callType || ""),
    capability: cleanId(capability, 160),
    producer: cleanId(producer),
    target: cleanId(target),
    correlationId: cleanId(correlationId),
    causationId: cleanId(causationId) || null,
    operationId: cleanId(operationId) || null,
    traceId: cleanId(traceId) || null,
    occurredAt: String(occurredAt),
    deadlineAt:
      deadlineAt ||
      new Date(
        (Number.isFinite(occurredMs) ? occurredMs : Date.now()) + boundedTimeout
      ).toISOString(),
    idempotencyKey: cleanId(idempotencyKey) || null,
    priority: String(priority || "P2"),
    dataClassification: String(dataClassification || "internal"),
    auth: normalizeAuth(auth),
    flags: {
      dryRun: flags.dryRun === true,
      requiresApproval: flags.requiresApproval === true,
      expectStream: flags.expectStream === true,
    },
    payload,
    result,
    error: normalizeError(error),
    telemetry: normalizeTelemetry(telemetry),
    payloadHash: sha256(canonicalJson(payload)),
    resultHash: sha256(canonicalJson(result)),
  };
  const validation = validateAicpEnvelope(envelope);
  if (!validation.valid) {
    const error = new Error("aicp_envelope_invalid");
    error.code = "AICP_ENVELOPE_INVALID";
    error.findings = validation.findings;
    throw error;
  }
  return envelope;
}

module.exports = {
  createAicpEnvelope,
  validateAicpEnvelope,
};
