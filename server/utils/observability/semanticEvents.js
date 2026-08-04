const crypto = require("crypto");
const { sanitizeLogArgs } = require("../security/redaction");
const { currentOperationContext } = require("./operationContext");
const { metrics } = require("./metrics");

const SCHEMA_NAME = "athena.ops.event";
const SCHEMA_VERSION = "1.0";
const MAX_QUEUE = 1_000;
const MAX_RECENT = 100;
const queue = [];
const recent = [];
const sinks = new Set();
const SAFE_NUMERIC_METADATA_KEYS = new Set([
  "cachedTokens",
  "cacheMissTokens",
  "inputTokens",
  "outputTokens",
]);
let flushTimer = null;
let flushing = null;

function compact(value, max = 240) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, max) : null;
}

function compactObject(value = {}, allowed = [], max = 160) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    allowed
      .map((key) => [key, compact(value[key], max)])
      .filter(([, item]) => item !== null)
  );
}

function sanitizeEvidence(evidence = []) {
  return (Array.isArray(evidence) ? evidence : [])
    .slice(0, 12)
    .map((item) =>
      compactObject(
        { ...item, type: item?.type || item?.kind },
        ["type", "ref", "metric", "comparison"],
        240
      )
    )
    .filter((item) => item.type && (item.ref || item.metric));
}

function sanitizeHypotheses(hypotheses = []) {
  return (Array.isArray(hypotheses) ? hypotheses : [])
    .slice(0, 8)
    .map((item) => ({
      ...compactObject(item, ["reason", "component"], 160),
      confidence: Math.max(0, Math.min(Number(item?.confidence) || 0, 1)),
      counterEvidence: (Array.isArray(item?.counterEvidence)
        ? item.counterEvidence
        : []
      )
        .slice(0, 6)
        .map((value) => compact(value, 160))
        .filter(Boolean),
    }))
    .filter((item) => item.reason);
}

function semanticEvent(input = {}) {
  const correlation = currentOperationContext() || {};
  const eventType = compact(input.eventType || input.event_type, 128);
  if (!eventType) {
    const error = new Error("Semantic event_type is required.");
    error.code = "semantic_event_type_required";
    throw error;
  }
  return {
    schema: SCHEMA_NAME,
    schemaVersion: SCHEMA_VERSION,
    eventId: compact(input.eventId, 128) || crypto.randomUUID(),
    eventType,
    category: compact(input.category || "system", 64),
    severity: compact(input.severity || "info", 32),
    outcome: compact(input.outcome || "observed", 48),
    occurredAt: input.occurredAt || new Date().toISOString(),
    observedAt: new Date().toISOString(),
    producer: {
      service: process.env.OTEL_SERVICE_NAME || "athena-server",
      version: require("../../package.json").version,
      runtimeRole: process.env.ATHENA_RUNTIME_ROLE || "api",
    },
    subject: compactObject(
      input.subject,
      ["type", "id", "component", "operation"],
      160
    ),
    actor: compactObject(input.actor, ["type", "id"], 160),
    correlation: compactObject(
      {
        ...correlation,
        ...(input.correlation || {}),
      },
      [
        "operationId",
        "interactionId",
        "requestId",
        "traceId",
        "spanId",
        "sourceActionId",
        "clientTurnId",
        "invocationId",
        "toolCallId",
        "clientId",
      ],
      160
    ),
    stateTransition: compactObject(
      input.stateTransition,
      ["from", "to", "reasonCode"],
      160
    ),
    impact: compactObject(
      input.impact,
      ["userEffect", "slo", "scope", "status"],
      160
    ),
    evidence: sanitizeEvidence(input.evidence),
    hypotheses: sanitizeHypotheses(input.hypotheses),
    recommendation: compactObject(
      input.recommendation,
      ["actionId", "risk", "permission"],
      160
    ),
    metadata: compactObject(
      input.metadata,
      [
        "errorCode",
        "statusCode",
        "durationMs",
        "provider",
        "model",
        "backend",
        "platform",
        "runId",
        "resultSha256",
        "stored",
        "resultSize",
        "fullResultExceededDefaultModelLimit",
        "continuationTask",
        "validationStatus",
        "validationErrorCount",
        "validationErrorCodes",
        "repairStrategy",
        "modelCallCount",
        "symbol",
        "horizon",
        "forecastStatus",
        "reasonCode",
        "modelVersion",
        "featureSchemaVersion",
        "datasetManifestSha256",
        "modelArtifactSha256",
        "dataFreshnessMs",
        "evidenceCoverage",
        "storageBytes",
        "moduleId",
        "runtimeRole",
        "version",
        "manifestFingerprint",
        "instanceId",
        "sequence",
        "ready",
        "heartbeatAt",
        "leaseExpiresAt",
        "center",
        "priority",
        "escalationLevel",
        "requestedProtocol",
        "effectiveProtocol",
        "degradedReason",
        "cachedTokens",
        "cacheMissTokens",
        "inputTokens",
        "outputTokens",
        "preprocessingMs",
        "providerTtftMs",
        "firstVisibleDeltaMs",
        "providerProjectionMs",
        "persistedEventBatches",
        "keyCustodyWrapCalls",
        "selectedCount",
        "availableCount",
        "responseStatus",
      ],
      160
    ),
    sensitivity: compact(input.sensitivity || "metadata_only", 48),
    retentionClass: compact(input.retentionClass || "operations_180d", 64),
  };
}

function otlpLogsEndpoint() {
  if (process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
    return process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  const base = String(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "").replace(
    /\/$/,
    ""
  );
  return base ? `${base}/v1/logs` : null;
}

function otlpPayload(events) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: {
                stringValue: process.env.OTEL_SERVICE_NAME || "athena-server",
              },
            },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "athena-semantic-events", version: SCHEMA_VERSION },
            logRecords: events.map((event) => ({
              timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
              severityText: event.severity.toUpperCase(),
              body: { stringValue: JSON.stringify(event) },
              traceId: event.correlation.traceId || undefined,
              spanId: event.correlation.spanId || undefined,
              attributes: [
                {
                  key: "event.name",
                  value: { stringValue: event.eventType },
                },
                {
                  key: "athena.event.category",
                  value: { stringValue: event.category },
                },
                {
                  key: "athena.event.schema_version",
                  value: { stringValue: SCHEMA_VERSION },
                },
              ],
            })),
          },
        ],
      },
    ],
  };
}

async function flushSemanticEvents() {
  if (flushing) return flushing;
  const endpoint = otlpLogsEndpoint();
  if (!endpoint || queue.length === 0) return { sent: 0, skipped: true };
  const batch = queue.splice(0, Math.min(queue.length, 100));
  flushing = fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(otlpPayload(batch)),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`otlp_logs_http_${response.status}`);
      return { sent: batch.length, skipped: false };
    })
    .catch((error) => {
      queue.unshift(...batch.slice(0, Math.max(0, MAX_QUEUE - queue.length)));
      console.warn("[SemanticEvent] OTLP export failed", {
        code: compact(error?.message || "otlp_logs_export_failed", 128),
        queued: queue.length,
      });
      return { sent: 0, skipped: false, error };
    })
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

function scheduleFlush() {
  if (flushTimer || !otlpLogsEndpoint()) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushSemanticEvents();
    if (queue.length) scheduleFlush();
  }, 1_000);
  flushTimer.unref?.();
}

function emitSemanticEvent(input = {}) {
  const event = semanticEvent(input);
  const safeEvent = sanitizeLogArgs([event])[0];
  for (const key of SAFE_NUMERIC_METADATA_KEYS) {
    const value = event.metadata?.[key];
    if (/^\d+$/.test(String(value || ""))) safeEvent.metadata[key] = value;
  }
  recent.push(safeEvent);
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
  metrics.semanticEvents.inc({
    category: event.category,
    severity: event.severity,
  });
  console.info("[semantic-event:v1]", JSON.stringify(safeEvent));
  if (queue.length < MAX_QUEUE) queue.push(safeEvent);
  for (const sink of sinks) {
    Promise.resolve()
      .then(() => sink(safeEvent))
      .catch((error) =>
        console.warn("[SemanticEvent] sink failed", {
          code: compact(error?.code || error?.message || "sink_failed", 128),
        })
      );
  }
  scheduleFlush();
  return safeEvent;
}

function registerSemanticEventSink(sink) {
  if (typeof sink !== "function")
    throw new TypeError("Semantic event sink must be a function.");
  sinks.add(sink);
  return () => sinks.delete(sink);
}

function semanticEventSnapshot() {
  return recent.map((event) => ({ ...event }));
}

function resetSemanticEventsForTests() {
  queue.splice(0, queue.length);
  recent.splice(0, recent.length);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  flushing = null;
  sinks.clear();
}

module.exports = {
  SCHEMA_NAME,
  SCHEMA_VERSION,
  emitSemanticEvent,
  flushSemanticEvents,
  registerSemanticEventSink,
  resetSemanticEventsForTests,
  semanticEvent,
  semanticEventSnapshot,
};
