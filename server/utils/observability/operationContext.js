const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const api = require("@opentelemetry/api");

const storage = new AsyncLocalStorage();
const tracer = api.trace.getTracer("athena-operations");
const IDENTIFIER_FIELDS = [
  "operationId",
  "correlationId",
  "interactionId",
  "requestId",
  "sourceActionId",
  "clientTurnId",
  "invocationId",
  "toolCallId",
  "clientId",
  "workspaceId",
  "threadId",
  "taskId",
  "coordinationRunId",
  "stepId",
];

function compactIdentifier(value, maxLength = 160) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeOperationContext(value = {}) {
  const normalized = {};
  for (const field of IDENTIFIER_FIELDS) {
    const next = compactIdentifier(value[field]);
    if (next) normalized[field] = next;
  }
  if (value.journey) normalized.journey = compactIdentifier(value.journey, 64);
  if (value.platform)
    normalized.platform = compactIdentifier(value.platform, 32);
  if (value.taskPriority)
    normalized.taskPriority = compactIdentifier(value.taskPriority, 8);
  if (value.coordinationCenter)
    normalized.coordinationCenter = compactIdentifier(
      value.coordinationCenter,
      32
    );
  if (value.coordinationDeadlineAt)
    normalized.coordinationDeadlineAt = compactIdentifier(
      value.coordinationDeadlineAt,
      64
    );
  if (value.coordinationCausationId)
    normalized.coordinationCausationId = compactIdentifier(
      value.coordinationCausationId,
      192
    );
  if (value.traceId) normalized.traceId = compactIdentifier(value.traceId, 32);
  if (value.spanId) normalized.spanId = compactIdentifier(value.spanId, 16);
  return normalized;
}

function currentOperationContext() {
  return storage.getStore() || null;
}

function runWithOperationContext(context, fn) {
  const parent = currentOperationContext() || {};
  return storage.run(
    {
      ...parent,
      ...normalizeOperationContext(context),
      operationId:
        compactIdentifier(context?.operationId) ||
        parent.operationId ||
        crypto.randomUUID(),
    },
    fn
  );
}

function enrichOperationContext(context = {}) {
  const store = currentOperationContext();
  const normalized = normalizeOperationContext(context);
  if (!store) return normalized;
  Object.assign(store, normalized);
  const span = api.trace.getActiveSpan();
  if (span) span.setAttributes(operationAttributes(store));
  return { ...store };
}

function operationAttributes(context = currentOperationContext() || {}) {
  const attributes = {};
  for (const field of IDENTIFIER_FIELDS) {
    if (context[field])
      attributes[`athena.operation.${field}`] = context[field];
  }
  if (context.journey) attributes["athena.operation.journey"] = context.journey;
  if (context.platform) attributes["client.platform"] = context.platform;
  if (context.taskPriority)
    attributes["athena.task.priority"] = context.taskPriority;
  if (context.coordinationCenter)
    attributes["athena.coordination.center"] = context.coordinationCenter;
  if (context.coordinationDeadlineAt)
    attributes["athena.coordination.deadline_at"] =
      context.coordinationDeadlineAt;
  return attributes;
}

function startOperationSpan(name, { attributes = {}, kind } = {}) {
  const span = tracer.startSpan(
    name,
    {
      kind,
      attributes: {
        ...operationAttributes(),
        ...attributes,
      },
    },
    api.context.active()
  );
  let ended = false;
  return {
    span,
    fail(error) {
      if (!error) return;
      span.recordException(error);
      span.setStatus({
        code: api.SpanStatusCode.ERROR,
        message: String(
          error?.code || error?.message || "operation_failed"
        ).slice(0, 160),
      });
    },
    end(attributesToAdd = {}) {
      if (ended) return;
      ended = true;
      span.setAttributes(attributesToAdd);
      span.end();
    },
  };
}

async function withOperationSpan(name, options, fn) {
  if (typeof options === "function") {
    fn = options;
    options = {};
  }
  return tracer.startActiveSpan(
    name,
    {
      kind: options?.kind,
      attributes: {
        ...operationAttributes(),
        ...(options?.attributes || {}),
      },
    },
    async (span) => {
      const spanContext = span.spanContext();
      try {
        return await runWithOperationContext(
          {
            traceId: spanContext.traceId,
            spanId: spanContext.spanId,
          },
          () => fn(span)
        );
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: api.SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

function correlationCoverage(requiredFields = []) {
  const context = currentOperationContext() || {};
  const required = [...new Set(["operationId", "traceId", ...requiredFields])];
  const missing = required.filter((field) => !context[field]);
  return {
    complete: missing.length === 0,
    missing,
    present: required.filter((field) => Boolean(context[field])),
  };
}

module.exports = {
  correlationCoverage,
  currentOperationContext,
  enrichOperationContext,
  normalizeOperationContext,
  operationAttributes,
  runWithOperationContext,
  startOperationSpan,
  withOperationSpan,
};
