const api = require("@opentelemetry/api");
const crypto = require("crypto");
const { classifyGoldenJourney } = require("./goldenJourneys");
const {
  currentOperationContext,
  enrichOperationContext,
  operationAttributes,
  runWithOperationContext,
  startOperationSpan,
  withOperationSpan,
} = require("./operationContext");

const tracer = api.trace.getTracer("athena-server");

function compact(value, max) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function incomingTraceId(request) {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(
    String(request.headers.traceparent || "")
  );
  return match?.[1]?.toLowerCase() || null;
}

function currentCorrelation() {
  return currentOperationContext();
}

function withCorrelation(correlation, fn) {
  return runWithOperationContext(correlation, fn);
}

function observabilityContextMiddleware(request, response, next) {
  const requestId =
    compact(request.headers["x-communication-request-id"], 128) ||
    compact(request.headers["x-request-id"], 128) ||
    crypto.randomUUID();
  const extracted = api.propagation.extract(
    api.context.active(),
    request.headers
  );
  const span = tracer.startSpan(
    `${String(request.method || "HTTP").toUpperCase()} request`,
    {
      kind: api.SpanKind.SERVER,
      attributes: {
        "http.request.method": String(request.method || ""),
        "url.path": String(request.path || request.url || "").split("?")[0],
        "athena.request_id": requestId,
      },
    },
    extracted
  );
  const spanContext = span.spanContext();
  const traceId =
    (spanContext.traceId && spanContext.traceId !== "0".repeat(32)
      ? spanContext.traceId
      : incomingTraceId(request)) || crypto.randomBytes(16).toString("hex");
  const spanId =
    spanContext.spanId && spanContext.spanId !== "0".repeat(16)
      ? spanContext.spanId
      : crypto.randomBytes(8).toString("hex");
  const correlation = {
    operationId: compact(request.headers["x-athena-operation-id"], 160),
    interactionId:
      compact(request.headers["x-athena-interaction-id"], 160) ||
      crypto.randomUUID(),
    requestId,
    sourceActionId: compact(request.headers["x-athena-source-action-id"], 160),
    clientTurnId: compact(request.headers["x-athena-client-turn-id"], 160),
    invocationId: compact(request.headers["x-athena-invocation-id"], 160),
    clientId: compact(request.headers["x-athena-client-id"], 160),
    platform: compact(request.headers["x-athena-platform"], 32),
    journey: classifyGoldenJourney(request),
    traceId,
    spanId,
  };
  if (!correlation.operationId) correlation.operationId = requestId;
  request.correlationRequestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("Traceparent", `00-${traceId}-${spanId}-01`);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    span.setAttribute(
      "http.response.status_code",
      Number(response.statusCode || 0)
    );
    if (response.statusCode >= 500)
      span.setStatus({ code: api.SpanStatusCode.ERROR });
    span.end();
  };
  response.once("finish", end);
  response.once("close", end);
  span.setAttributes(operationAttributes(correlation));
  const active = api.trace.setSpan(extracted, span);
  runWithOperationContext(correlation, () => {
    request.athenaTraceContext = currentOperationContext();
    return api.context.with(active, next);
  });
}

function operationContextBodyMiddleware(request, _response, next) {
  const body =
    request.body &&
    typeof request.body === "object" &&
    !Buffer.isBuffer(request.body)
      ? request.body
      : {};
  enrichOperationContext({
    sourceActionId:
      body.sourceActionId ||
      body.editContext?.sourceActionId ||
      body.regenerateContext?.sourceActionId,
    clientTurnId: body.clientTurnId,
    invocationId: body.invocationId || body.invocationUuid,
    toolCallId: body.toolCallId,
  });
  return next();
}

module.exports = {
  currentCorrelation,
  currentOperationContext,
  enrichOperationContext,
  observabilityContextMiddleware,
  operationContextBodyMiddleware,
  startOperationSpan,
  withOperationSpan,
  withCorrelation,
  runWithOperationContext,
};
