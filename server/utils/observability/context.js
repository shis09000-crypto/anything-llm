const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const api = require("@opentelemetry/api");

const storage = new AsyncLocalStorage();
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
  return storage.getStore() || null;
}

function withCorrelation(correlation, fn) {
  return storage.run({ ...(currentCorrelation() || {}), ...correlation }, fn);
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
  const correlation = { requestId, traceId, spanId };
  request.correlationRequestId = requestId;
  request.athenaTraceContext = correlation;
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
  const active = api.trace.setSpan(extracted, span);
  storage.run(correlation, () => api.context.with(active, next));
}

module.exports = {
  currentCorrelation,
  observabilityContextMiddleware,
  withCorrelation,
};
