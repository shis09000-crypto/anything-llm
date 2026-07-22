const {
  registerSemanticEventSink,
  semanticEventSnapshot,
} = require("../observability/semanticEvents");
const {
  natsSecurityFindings,
} = require("../broadcast/transports/natsJetStreamTransport");
const { operationsConfig, operationsSecurityFindings } = require("./config");
const { ClickHouseEventStore } = require("./clickHouseEventStore");
const { OperationsJetStreamTransport } = require("./jetStreamTransport");
const { validateRegistered } = require("./schemaRegistry");
const { metrics } = require("../observability/metrics");

const MAX_RETRY_QUEUE = 1_000;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function eventFromClickHouseRow(row = {}) {
  return {
    schema: row.schema_name,
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    eventType: row.event_type,
    category: row.category,
    severity: row.severity,
    outcome: row.outcome,
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    producer: {
      service: row.producer_service,
      version: row.producer_version,
      runtimeRole: row.runtime_role,
    },
    subject: {
      type: row.subject_type || undefined,
      id: row.subject_id || undefined,
      component: row.subject_component || undefined,
    },
    actor: {
      type: row.actor_type || undefined,
      id: row.actor_id || undefined,
    },
    correlation: {
      operationId: row.operation_id || undefined,
      interactionId: row.interaction_id || undefined,
      requestId: row.request_id || undefined,
      traceId: row.trace_id || undefined,
      spanId: row.span_id || undefined,
      sourceActionId: row.source_action_id || undefined,
      clientTurnId: row.client_turn_id || undefined,
      invocationId: row.invocation_id || undefined,
      toolCallId: row.tool_call_id || undefined,
    },
    impact: parseJson(row.impact_json, {}),
    evidence: parseJson(row.evidence_json, []),
    hypotheses: parseJson(row.hypotheses_json, []),
    recommendation: parseJson(row.recommendation_json, {}),
    stateTransition: parseJson(row.state_transition_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    sensitivity: row.sensitivity,
    retentionClass: row.retention_class,
  };
}

function matches(event, filters = {}) {
  if (filters.eventId && event.eventId !== filters.eventId) return false;
  if (filters.eventType && event.eventType !== filters.eventType) return false;
  if (filters.subjectId && event.subject?.id !== filters.subjectId)
    return false;
  if (
    filters.operationId &&
    event.correlation?.operationId !== filters.operationId
  )
    return false;
  if (filters.after && Date.parse(event.occurredAt) < Date.parse(filters.after))
    return false;
  if (
    filters.before &&
    Date.parse(event.occurredAt) > Date.parse(filters.before)
  )
    return false;
  return true;
}

class OperationsPlane {
  constructor({
    env = process.env,
    store = null,
    transport = null,
    registerSink = registerSemanticEventSink,
  } = {}) {
    this.env = env;
    this.config = operationsConfig(env);
    this.store = store || new ClickHouseEventStore(env);
    this.transport = transport || new OperationsJetStreamTransport(env);
    this.registerSink = registerSink;
    this.unregisterSink = null;
    this.retryQueue = [];
    this.retryTimer = null;
    this.status = this.config.enabled ? "created" : "disabled";
    this.lastError = null;
    this.rejected = 0;
    this.queued = 0;
  }

  securityFindings() {
    if (!this.config.enabled) return [];
    return [
      ...operationsSecurityFindings(this.env),
      ...natsSecurityFindings({
        ...this.env,
        ATHENA_BROADCAST_TRANSPORT: "nats",
      }),
    ];
  }

  async start() {
    if (!this.config.enabled) return this.health();
    if (["running", "degraded"].includes(this.status)) return this.health();
    this.status = "starting";
    const findings = this.securityFindings();
    if (findings.length) {
      this.status = "degraded";
      this.lastError = `operations_security_policy_failed:${findings.join(" ")}`;
      console.error("[OperationsPlane] startup policy failed", { findings });
      return this.health();
    }
    let storeReady = false;
    let transportReady = false;
    try {
      await this.store.ensureSchema();
      storeReady = true;
    } catch (error) {
      this.lastError = error?.code || error?.message || String(error);
      console.error("[OperationsPlane] ClickHouse startup degraded", {
        code: this.lastError,
      });
    }
    try {
      await this.transport.start((event) => this.consume(event));
      transportReady = true;
    } catch (error) {
      this.lastError = error?.code || error?.message || String(error);
      console.error("[OperationsPlane] JetStream startup degraded", {
        code: this.lastError,
      });
    }
    if (storeReady || transportReady) {
      this.unregisterSink = this.registerSink((event) => this.ingest(event));
      this.status = storeReady && transportReady ? "running" : "degraded";
      if (this.status === "running") this.lastError = null;
      this.scheduleRetry();
    } else {
      this.status = "degraded";
    }
    return this.health();
  }

  async ingest(event) {
    const validation = validateRegistered(event);
    if (!validation.valid) {
      this.rejected += 1;
      metrics.operationsEvents.inc({
        stage: "schema_validation",
        outcome: "rejected",
      });
      const error = new Error(`semantic_event_rejected:${validation.errors}`);
      error.code = "SEMANTIC_EVENT_SCHEMA_REJECTED";
      throw error;
    }
    try {
      if (this.transport.health().ready)
        return await this.transport.publish(event);
      if (this.store.health().ready) return await this.store.insert(event);
      throw Object.assign(new Error("operations_plane_unavailable"), {
        code: "OPERATIONS_PLANE_UNAVAILABLE",
      });
    } catch (error) {
      this.enqueue(event);
      this.lastError = error?.code || error?.message || String(error);
      return { accepted: false, queued: true };
    }
  }

  async consume(event) {
    const validation = validateRegistered(event);
    if (!validation.valid) {
      this.rejected += 1;
      metrics.operationsEvents.inc({
        stage: "schema_validation",
        outcome: "rejected",
      });
      const error = new Error(`semantic_event_rejected:${validation.errors}`);
      error.code = "SEMANTIC_EVENT_SCHEMA_REJECTED";
      throw error;
    }
    return this.store.insert(event);
  }

  enqueue(event) {
    if (this.retryQueue.some((queued) => queued.eventId === event.eventId))
      return;
    if (this.retryQueue.length >= MAX_RETRY_QUEUE) this.retryQueue.shift();
    this.retryQueue.push(event);
    this.queued += 1;
    metrics.operationsRetryQueue.set(this.retryQueue.length);
    this.scheduleRetry();
  }

  scheduleRetry() {
    if (this.retryTimer || !this.retryQueue.length) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushRetryQueue();
    }, 2_000);
    this.retryTimer.unref?.();
  }

  async flushRetryQueue() {
    const batch = this.retryQueue.splice(0, 100);
    metrics.operationsRetryQueue.set(this.retryQueue.length);
    for (let index = 0; index < batch.length; index += 1) {
      const event = batch[index];
      try {
        if (this.transport.health().ready) await this.transport.publish(event);
        else await this.store.insert(event);
      } catch (error) {
        this.retryQueue.unshift(...batch.slice(index));
        metrics.operationsRetryQueue.set(this.retryQueue.length);
        this.lastError = error?.code || error?.message || String(error);
        break;
      }
    }
    this.scheduleRetry();
  }

  async timeline(filters = {}) {
    const limit = Math.max(1, Math.min(Number(filters.limit) || 100, 500));
    if (this.store.health().configured) {
      try {
        return (await this.store.timeline({ ...filters, limit })).map(
          eventFromClickHouseRow
        );
      } catch (error) {
        this.lastError = error?.code || error?.message || String(error);
      }
    }
    return semanticEventSnapshot()
      .filter((event) => matches(event, filters))
      .sort(
        (left, right) =>
          Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
      )
      .slice(0, limit);
  }

  async stop() {
    this.unregisterSink?.();
    this.unregisterSink = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.flushRetryQueue().catch(() => null);
    await this.transport.drain();
    this.status = this.config.enabled ? "stopped" : "disabled";
    metrics.operationsRetryQueue.set(0);
  }

  health() {
    return {
      enabled: this.config.enabled,
      status: this.status,
      ready: this.status === "running",
      lastError: this.lastError,
      retryQueue: this.retryQueue.length,
      queuedTotal: this.queued,
      rejected: this.rejected,
      jetstream: this.transport.health(),
      clickhouse: this.store.health(),
    };
  }
}

const operationsPlane = new OperationsPlane();

module.exports = {
  OperationsPlane,
  eventFromClickHouseRow,
  matches,
  operationsPlane,
};
