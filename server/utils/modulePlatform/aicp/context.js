const crypto = require("crypto");
const { canonicalJson, sha256 } = require("../canonical");
const {
  AICP_CONTEXT_HEADER,
  AICP_CONTEXT_SCHEMA,
  AICP_CONTEXT_VERSION,
  AICP_RESULT_HEADER,
  DATA_CLASSIFICATIONS,
  PRIORITIES,
} = require("./constants");
const {
  aicpContractError,
  decodeAicpHeader,
  encodeAicpHeader,
} = require("./contractRegistry");

const CONTEXT_CALL_TYPES = new Set([
  "Query",
  "Call",
  "Task",
  "Command",
  "Stream",
  "Event",
]);
const COORDINATION_CENTERS = new Set([
  "task",
  "data",
  "cache",
  "recovery",
  "optimistic",
]);

function normalizedPath(value) {
  try {
    const parsed = new URL(String(value), "http://athena.internal");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(value || "").split("#")[0];
  }
}

function payloadHash(payload) {
  return sha256(canonicalJson(payload ?? null));
}

function requestBinding({
  method,
  path,
  capability,
  version,
  payloadHash: digest,
  idempotencyKey = null,
} = {}) {
  return {
    method: String(method || "POST").toUpperCase(),
    path: normalizedPath(path),
    capability: String(capability || ""),
    version: String(version || ""),
    payloadHash: String(digest || ""),
    idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
  };
}

function requestBindingHash(value) {
  return sha256(canonicalJson(requestBinding(value)));
}

function createAicpContext({
  negotiation,
  payload = null,
  method = "POST",
  path = "/",
  coordinationContext = null,
  idempotencyKey = null,
  principalAssertion = null,
  approvalId = null,
  operationContext = {},
  deadlineAt = null,
  attempt = 1,
  messageId = crypto.randomUUID(),
} = {}) {
  if (!negotiation) throw aicpContractError("aicp_negotiation_required", 500);
  const now = Date.now();
  const effectiveDeadline =
    deadlineAt ||
    coordinationContext?.deadlineAt ||
    new Date(now + Math.max(1_000, negotiation.timeoutMs || 10_000)).toISOString();
  const digest = payloadHash(payload);
  const correlationId =
    coordinationContext?.correlationId ||
    operationContext.correlationId ||
    crypto.randomUUID();
  const operationId = operationContext.operationId || crypto.randomUUID();
  const context = {
    schema: AICP_CONTEXT_SCHEMA,
    schemaVersion: AICP_CONTEXT_VERSION,
    messageId: String(messageId),
    callType: negotiation.callType,
    capability: {
      id: negotiation.capability,
      version: negotiation.version,
      fingerprint: negotiation.contractFingerprint,
    },
    source: negotiation.callerModule,
    target: negotiation.targetModule,
    correlation: {
      traceId: operationContext.traceId || correlationId,
      correlationId,
      causationId:
        coordinationContext?.causationId || operationContext.causationId || null,
      operationId,
    },
    coordination: {
      runId:
        coordinationContext?.coordinationRunId || operationContext.runId || operationId,
      stepId: coordinationContext?.stepId || operationContext.stepId || messageId,
      center:
        coordinationContext?.center || operationContext.center || "optimistic",
      priority:
        coordinationContext?.priority || operationContext.priority || "P2",
      deadlineAt: effectiveDeadline,
    },
    delivery: {
      idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
      attempt: Math.max(1, Number(attempt) || 1),
    },
    security: {
      dataClassification: negotiation.dataClassification,
      principalAssertionHash: principalAssertion
        ? sha256(canonicalJson(principalAssertion))
        : null,
      approvalId: approvalId ? String(approvalId) : null,
    },
    payloadHash: digest,
    requestBindingHash: requestBindingHash({
      method,
      path,
      capability: negotiation.capability,
      version: negotiation.version,
      payloadHash: digest,
      idempotencyKey,
    }),
  };
  const validation = validateAicpContext(context, {
    payload,
    method,
    path,
  });
  if (!validation.valid)
    throw aicpContractError("aicp_context_invalid", 400, {
      findings: validation.findings,
    });
  return context;
}

function validateAicpContext(
  value = {},
  { payload, method = null, path = null, now = Date.now() } = {}
) {
  const findings = [];
  if (value.schema !== AICP_CONTEXT_SCHEMA) findings.push("schema_invalid");
  if (value.schemaVersion !== AICP_CONTEXT_VERSION)
    findings.push("schema_version_invalid");
  for (const field of ["messageId", "source", "target", "payloadHash"])
    if (!String(value[field] || "")) findings.push(`${field}_missing`);
  if (!CONTEXT_CALL_TYPES.has(value.callType)) findings.push("call_type_invalid");
  if (!value.capability || typeof value.capability !== "object")
    findings.push("capability_missing");
  else {
    for (const field of ["id", "version", "fingerprint"])
      if (!String(value.capability[field] || ""))
        findings.push(`capability_${field}_missing`);
    if (!/^[a-f0-9]{64}$/.test(String(value.capability.fingerprint || "")))
      findings.push("capability_fingerprint_invalid");
  }
  const correlation = value.correlation || {};
  for (const field of ["traceId", "correlationId", "operationId"])
    if (!String(correlation[field] || ""))
      findings.push(`correlation_${field}_missing`);
  const coordination = value.coordination || {};
  for (const field of ["runId", "stepId", "deadlineAt"])
    if (!String(coordination[field] || ""))
      findings.push(`coordination_${field}_missing`);
  if (!COORDINATION_CENTERS.has(coordination.center))
    findings.push("coordination_center_invalid");
  if (!PRIORITIES.has(coordination.priority))
    findings.push("coordination_priority_invalid");
  const deadline = Date.parse(coordination.deadlineAt);
  if (!Number.isFinite(deadline)) findings.push("deadline_invalid");
  else if (deadline <= now) findings.push("deadline_expired");
  if (!Number.isInteger(value.delivery?.attempt) || value.delivery.attempt < 1)
    findings.push("delivery_attempt_invalid");
  if (!DATA_CLASSIFICATIONS.has(value.security?.dataClassification))
    findings.push("security_classification_invalid");
  if (!/^[a-f0-9]{64}$/.test(String(value.payloadHash || "")))
    findings.push("payload_hash_invalid");
  if (payload !== undefined && payloadHash(payload) !== value.payloadHash)
    findings.push("payload_hash_mismatch");
  if (method && path) {
    const expected = requestBindingHash({
      method,
      path,
      capability: value.capability?.id,
      version: value.capability?.version,
      payloadHash: value.payloadHash,
      idempotencyKey: value.delivery?.idempotencyKey,
    });
    if (expected !== value.requestBindingHash)
      findings.push("request_binding_hash_mismatch");
  }
  return { valid: findings.length === 0, findings };
}

function encodeAicpContext(value) {
  return encodeAicpHeader(value);
}

function decodeAicpContext(value) {
  return decodeAicpHeader(value);
}

function createAicpResult({ context, status, payload = null, errorCode = null }) {
  return {
    schema: "athena.aicp.result",
    schemaVersion: AICP_CONTEXT_VERSION,
    messageId: context.messageId,
    capability: { ...context.capability },
    status,
    resultHash: payloadHash(payload),
    errorCode: errorCode ? String(errorCode) : null,
    terminalAt: new Date().toISOString(),
  };
}

module.exports = {
  AICP_CONTEXT_HEADER,
  AICP_RESULT_HEADER,
  createAicpContext,
  createAicpResult,
  decodeAicpContext,
  encodeAicpContext,
  normalizedPath,
  payloadHash,
  requestBinding,
  requestBindingHash,
  validateAicpContext,
};
