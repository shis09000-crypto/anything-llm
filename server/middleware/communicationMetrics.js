const { randomUUID } = require("crypto");
const { observeHttp, metrics } = require("../utils/observability/metrics");
const {
  beginGoldenJourney,
  requirementsForJourney,
} = require("../utils/observability/goldenJourneys");
const { emitSemanticEvent } = require("../utils/observability/semanticEvents");

const SLOW_REQUEST_MS =
  Number(process.env.COMMUNICATION_SLOW_REQUEST_MS) || 800;
const MAX_LOGGED_EVENTS = 500;
const recentEvents = [];

function nowMs() {
  const [seconds, nanos] = process.hrtime();
  return seconds * 1000 + nanos / 1e6;
}

function pushEvent(event) {
  recentEvents.push(event);
  if (recentEvents.length > MAX_LOGGED_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_LOGGED_EVENTS);
  }
}

function recordCommunicationDiagnostic({
  subsystem,
  severity = "error",
  operation = null,
  domain = null,
  errorCode = null,
  resourceFingerprint = null,
  payloadFingerprint = null,
  keyFingerprint = null,
  blocked = false,
} = {}) {
  const event = {
    eventId: randomUUID(),
    kind: "system-diagnostic",
    subsystem: String(subsystem || "unknown").slice(0, 64),
    severity: String(severity || "error").slice(0, 32),
    operation: operation ? String(operation).slice(0, 128) : null,
    domain: domain ? String(domain).slice(0, 128) : null,
    errorCode: errorCode ? String(errorCode).slice(0, 128) : null,
    resourceFingerprint: resourceFingerprint
      ? String(resourceFingerprint).slice(0, 64)
      : null,
    payloadFingerprint: payloadFingerprint
      ? String(payloadFingerprint).slice(0, 64)
      : null,
    keyFingerprint: keyFingerprint ? String(keyFingerprint).slice(0, 64) : null,
    blocked: Boolean(blocked),
    createdAt: new Date().toISOString(),
  };
  pushEvent(event);
  return event;
}

function safeRequestBytes(request) {
  if (Number.isFinite(Number(request.bodyByteLength)))
    return Number(request.bodyByteLength);
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength)) return contentLength;
  if (Buffer.isBuffer(request.rawBody)) return request.rawBody.length;
  if (typeof request.rawBody === "string")
    return Buffer.byteLength(request.rawBody);
  return 0;
}

function byteLengthForChunk(chunk, encoding) {
  if (!chunk) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  const safeEncoding = typeof encoding === "string" ? encoding : undefined;
  return Buffer.byteLength(String(chunk), safeEncoding);
}

function routeScope(request, response) {
  return {
    userId:
      response.locals?.user?.id ||
      request.user?.id ||
      request.session?.user?.id ||
      null,
    workspaceSlug: request.params?.slug || null,
    threadSlug: request.params?.threadSlug || null,
  };
}

function communicationMetricsMiddleware(request, response, next) {
  const startedAt = nowMs();
  const requestId =
    request.correlationRequestId ||
    request.headers["x-communication-request-id"] ||
    request.headers["x-request-id"] ||
    randomUUID();
  let responseBytes = 0;
  const originalWrite = response.write;
  const originalEnd = response.end;
  const originalWriteHead = response.writeHead;

  request.communicationRequestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  const journey = request.athenaTraceContext?.journey || null;
  if (journey) beginGoldenJourney(response, journey, Date.now());

  response.writeHead = function writeHeadWithMetrics(...args) {
    if (!response.headersSent) {
      const durationMs = Math.round(nowMs() - startedAt);
      response.setHeader("Server-Timing", `app;dur=${durationMs}`);
    }
    return originalWriteHead.apply(this, args);
  };

  response.write = function writeWithMetrics(chunk, encoding, callback) {
    responseBytes += byteLengthForChunk(chunk, encoding);
    return originalWrite.call(this, chunk, encoding, callback);
  };

  response.end = function endWithMetrics(chunk, encoding, callback) {
    responseBytes += byteLengthForChunk(chunk, encoding);
    return originalEnd.call(this, chunk, encoding, callback);
  };

  response.on("finish", () => {
    const durationMs = Math.round(nowMs() - startedAt);
    const event = {
      requestId,
      method: request.method,
      path: request.originalUrl || request.url,
      route: request.route?.path || null,
      status: response.statusCode,
      durationMs,
      requestBytes: safeRequestBytes(request),
      responseBytes,
      createdAt: new Date().toISOString(),
      ...routeScope(request, response),
      operationId: request.athenaTraceContext?.operationId || null,
      interactionId: request.athenaTraceContext?.interactionId || null,
      traceId: request.athenaTraceContext?.traceId || null,
      spanId: request.athenaTraceContext?.spanId || null,
      sourceActionId: request.athenaTraceContext?.sourceActionId || null,
      clientTurnId: request.athenaTraceContext?.clientTurnId || null,
      invocationId: request.athenaTraceContext?.invocationId || null,
      journey,
    };
    pushEvent(event);
    observeHttp({
      request,
      statusCode: response.statusCode,
      durationMs,
      requestBytes: event.requestBytes,
      responseBytes,
    });
    if (journey) {
      const outcome = response.statusCode < 400 ? "success" : "failure";
      metrics.goldenJourneyOperations.inc({ journey, outcome });
      metrics.goldenJourneyDuration.observe(
        { journey, outcome },
        durationMs / 1000
      );
      const required = [
        "operationId",
        "traceId",
        ...requirementsForJourney(journey),
      ];
      const missing = required.filter(
        (field) => !request.athenaTraceContext?.[field]
      );
      metrics.operationCorrelation.inc({
        component: "http",
        journey,
        coverage: missing.length === 0 ? "complete" : "incomplete",
      });
      if (response.statusCode >= 400) {
        emitSemanticEvent({
          eventType: `${journey}.failed`,
          category: "golden_journey",
          severity: response.statusCode >= 500 ? "error" : "warning",
          outcome,
          subject: { component: "http", operation: event.route || "unmatched" },
          impact: { userEffect: "journey_not_completed" },
          evidence: [{ kind: "trace", ref: event.traceId }],
          metadata: { statusCode: response.statusCode, durationMs },
        });
      }
    }
    if (durationMs >= SLOW_REQUEST_MS) {
      console.warn("[communication:slow-request]", event);
      emitSemanticEvent({
        eventType: "http.request.slow",
        category: "performance",
        severity: "warning",
        outcome: "degraded",
        subject: { component: "http", operation: event.route || "unmatched" },
        impact: {
          userEffect: journey
            ? `${journey}_latency_increased`
            : "request_latency_increased",
        },
        evidence: [{ kind: "trace", ref: event.traceId }],
        metadata: { durationMs, statusCode: response.statusCode },
      });
    }
  });

  next();
}

function communicationMetricsSnapshot({ limit = 100 } = {}) {
  return recentEvents.slice(-limit);
}

function communicationDiagnosticsSnapshot({
  subsystem = null,
  limit = 100,
} = {}) {
  const normalizedSubsystem = subsystem ? String(subsystem) : null;
  return recentEvents
    .filter(
      (event) =>
        event.kind === "system-diagnostic" &&
        (!normalizedSubsystem || event.subsystem === normalizedSubsystem)
    )
    .slice(-limit);
}

module.exports = {
  communicationMetricsMiddleware,
  communicationMetricsSnapshot,
  communicationDiagnosticsSnapshot,
  recordCommunicationDiagnostic,
};
