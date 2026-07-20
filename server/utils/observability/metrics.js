const client = require("prom-client");

const registry = new client.Registry();
registry.setDefaultLabels({
  service: process.env.OTEL_SERVICE_NAME || "athena-server",
  runtime_role: process.env.ATHENA_RUNTIME_ROLE || "api",
  app_env:
    process.env.APP_ENV ||
    (process.env.NODE_ENV === "production" ? "production" : "development"),
});
client.collectDefaultMetrics({ register: registry, prefix: "athena_node_" });

const httpRequests = new client.Counter({
  name: "athena_http_requests_total",
  help: "HTTP requests completed by the Athena API.",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});
const httpDuration = new client.Histogram({
  name: "athena_http_request_duration_seconds",
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});
const httpBytes = new client.Counter({
  name: "athena_http_bytes_total",
  help: "HTTP request and response bytes.",
  labelNames: ["direction"],
  registers: [registry],
});
const syncOutboxEvents = new client.Counter({
  name: "athena_sync_outbox_events_total",
  help: "Sync V2 Outbox lifecycle transitions.",
  labelNames: ["action"],
  registers: [registry],
});
const syncOutboxPending = new client.Gauge({
  name: "athena_sync_outbox_pending",
  help: "Current number of pending Sync V2 Outbox events.",
  registers: [registry],
});
const syncOutboxOldestAge = new client.Gauge({
  name: "athena_sync_outbox_oldest_age_seconds",
  help: "Age of the oldest pending Sync V2 Outbox event.",
  registers: [registry],
});
const syncOutboxRetrying = new client.Gauge({
  name: "athena_sync_outbox_retrying",
  help: "Current number of retrying Sync V2 Outbox events.",
  registers: [registry],
});
const syncOutboxDeadLetters = new client.Gauge({
  name: "athena_sync_outbox_dead_letters",
  help: "Current number of Sync V2 Outbox dead-letter events.",
  registers: [registry],
});
const syncReceiptEvents = new client.Counter({
  name: "athena_sync_mutation_receipts_total",
  help: "Mutation receipt recovery lifecycle transitions.",
  labelNames: ["action"],
  registers: [registry],
});
const syncReceiptPending = new client.Gauge({
  name: "athena_sync_mutation_receipts_pending",
  help: "Current mutation receipt count by recoverability state.",
  labelNames: ["status"],
  registers: [registry],
});
const syncCursorLag = new client.Histogram({
  name: "athena_sync_cursor_lag_events",
  help: "Client ACK cursor lag behind the current Outbox checkpoint.",
  labelNames: ["platform"],
  buckets: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  registers: [registry],
});
const securityAuditEvents = new client.Counter({
  name: "athena_security_audit_events_total",
  help: "Security audit ledger append outcomes.",
  labelNames: ["outcome"],
  registers: [registry],
});
const securityAuditChainValid = new client.Gauge({
  name: "athena_security_audit_chain_valid",
  help: "Whether the most recent security audit chain verification passed.",
  registers: [registry],
});
const securityAuditArchiveHealthy = new client.Gauge({
  name: "athena_security_audit_archive_healthy",
  help: "Whether immutable archive and SIEM delivery last completed successfully.",
  registers: [registry],
});
const pluginPolicyDecisions = new client.Counter({
  name: "athena_plugin_policy_decisions_total",
  help: "Plugin and scheduled tool capability decisions.",
  labelNames: ["kind", "decision"],
  registers: [registry],
});
const runtimeShutdowns = new client.Counter({
  name: "athena_runtime_shutdowns_total",
  help: "Runtime shutdown outcomes.",
  labelNames: ["outcome"],
  registers: [registry],
});
const realtimeMessages = new client.Counter({
  name: "athena_realtime_messages_total",
  help: "Realtime WebSocket and SSE control messages.",
  labelNames: ["transport", "direction", "type"],
  registers: [registry],
});
const authSessionReconciles = new client.Counter({
  name: "athena_auth_session_reconcile_total",
  help: "Auth DB to Sync V2 authority reconciliation outcomes.",
  labelNames: ["outcome"],
  registers: [registry],
});
const natsEvents = new client.Counter({
  name: "athena_nats_events_total",
  help: "NATS JetStream transport outcomes.",
  labelNames: ["action", "outcome"],
  registers: [registry],
});
const natsConsumerLag = new client.Gauge({
  name: "athena_nats_consumer_lag",
  help: "Pending JetStream messages for the local durable consumer.",
  labelNames: ["consumer"],
  registers: [registry],
});
const contentObjectOperations = new client.Counter({
  name: "athena_content_object_operations_total",
  help: "Encrypted content object lifecycle outcomes.",
  labelNames: ["operation", "outcome", "provider"],
  registers: [registry],
});
const contentObjectBytes = new client.Counter({
  name: "athena_content_object_bytes_total",
  help: "Plaintext bytes moved through the encrypted content object plane.",
  labelNames: ["direction", "domain"],
  registers: [registry],
});
const aiExecutions = new client.Counter({
  name: "athena_ai_executions_total",
  help: "Governed model execution outcomes.",
  labelNames: ["task", "provider", "outcome"],
  registers: [registry],
});
const aiTokens = new client.Counter({
  name: "athena_ai_tokens_total",
  help: "Provider-reported AI token usage.",
  labelNames: ["provider", "direction"],
  registers: [registry],
});
const aiCostMicros = new client.Counter({
  name: "athena_ai_cost_micros_total",
  help: "Catalog-derived AI cost in millionths of the configured currency.",
  labelNames: ["provider"],
  registers: [registry],
});

function routeLabel(request) {
  const route = request.route?.path;
  if (route) return `${request.baseUrl || ""}${route}`.slice(0, 180);
  // Do not turn arbitrary user-controlled slugs or unknown paths into metric
  // labels. Exact route templates are available once Express matched a route;
  // everything else shares a bounded fallback label.
  return "unmatched";
}

function observeHttp({
  request,
  statusCode,
  durationMs,
  requestBytes,
  responseBytes,
}) {
  const labels = {
    method: String(request.method || "UNKNOWN").toUpperCase(),
    route: routeLabel(request),
    status_code: String(statusCode || 0),
  };
  httpRequests.inc(labels);
  httpDuration.observe(labels, Math.max(Number(durationMs) || 0, 0) / 1000);
  httpBytes.inc(
    { direction: "request" },
    Math.max(Number(requestBytes) || 0, 0)
  );
  httpBytes.inc(
    { direction: "response" },
    Math.max(Number(responseBytes) || 0, 0)
  );
}

function isLoopback(address = "") {
  const normalized = String(address || "").replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

function metricsRequestAuthorized(request) {
  const configured = String(process.env.ATHENA_METRICS_TOKEN || "").trim();
  if (!configured) {
    if (process.env.NODE_ENV !== "production") return true;
    return (
      process.env.ATHENA_METRICS_ALLOW_LOOPBACK === "true" &&
      isLoopback(request.socket?.remoteAddress)
    );
  }
  const header = String(request.headers.authorization || "");
  const candidate = header.startsWith("Bearer ")
    ? header.slice(7)
    : String(request.headers["x-athena-metrics-token"] || "");
  const left = Buffer.from(candidate);
  const right = Buffer.from(configured);
  return (
    left.length === right.length &&
    left.length > 0 &&
    require("crypto").timingSafeEqual(left, right)
  );
}

async function metricsEndpoint(request, response) {
  if (!metricsRequestAuthorized(request)) {
    return response
      .status(403)
      .json({ success: false, error: "metrics_forbidden" });
  }
  response.setHeader("Content-Type", registry.contentType);
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).send(await registry.metrics());
}

module.exports = {
  metricsEndpoint,
  metricsRequestAuthorized,
  observeHttp,
  registry,
  metrics: {
    aiCostMicros,
    aiExecutions,
    aiTokens,
    authSessionReconciles,
    contentObjectBytes,
    contentObjectOperations,
    natsConsumerLag,
    natsEvents,
    pluginPolicyDecisions,
    realtimeMessages,
    runtimeShutdowns,
    securityAuditEvents,
    securityAuditChainValid,
    securityAuditArchiveHealthy,
    syncCursorLag,
    syncOutboxEvents,
    syncOutboxOldestAge,
    syncOutboxPending,
    syncOutboxRetrying,
    syncOutboxDeadLetters,
    syncReceiptEvents,
    syncReceiptPending,
  },
};
