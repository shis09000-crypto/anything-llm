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
const { loadManifests } = require("../modulePlatform/manifestRegistry");
const { aicpShadowObserver } = require("../modulePlatform/aicp/shadowObserver");
const { parseExpectedModuleStates } = require("./moduleHealthMonitor");

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
  if (filters.traceId && event.correlation?.traceId !== filters.traceId)
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
    aicpObserver = aicpShadowObserver,
  } = {}) {
    this.env = env;
    this.config = operationsConfig(env);
    this.store = store || new ClickHouseEventStore(env);
    this.transport = transport || new OperationsJetStreamTransport(env);
    this.registerSink = registerSink;
    this.aicpObserver = aicpObserver;
    this.unregisterSink = null;
    this.retryQueue = [];
    this.retryTimer = null;
    this.transportRecoveryTimer = null;
    this.transportRecoveryPromise = null;
    this.transportRecoveryAttempt = 0;
    this.stopping = false;
    this.status = this.config.enabled ? "created" : "disabled";
    this.lastError = null;
    this.rejected = 0;
    this.queued = 0;
    this.producers = new Map();
    this.moduleHeartbeats = new Map();
    this.expectedModuleIds = Object.freeze(
      loadManifests()
        .map((manifest) => manifest.id)
        .sort()
    );
    this.plannedModuleStates = Object.freeze(
      parseExpectedModuleStates(this.env)
    );
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
    this.stopping = false;
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
      await this.startTransport();
      transportReady = true;
    } catch (error) {
      this.lastError = error?.code || error?.message || String(error);
      console.error("[OperationsPlane] JetStream startup degraded", {
        code: this.lastError,
      });
      this.scheduleTransportRecovery();
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

  async startTransport() {
    if (this.transportRecoveryPromise) return this.transportRecoveryPromise;
    this.transportRecoveryPromise = (async () => {
      await this.transport.start((events) => this.consumeBatch(events));
      this.transportRecoveryAttempt = 0;
      if (this.store.health().ready) {
        this.status = "running";
        this.lastError = null;
      }
      this.scheduleRetry();
      return this.transport.health();
    })().finally(() => {
      this.transportRecoveryPromise = null;
    });
    return this.transportRecoveryPromise;
  }

  scheduleTransportRecovery() {
    if (
      this.stopping ||
      this.transportRecoveryTimer ||
      this.transportRecoveryPromise ||
      this.transport.health().ready
    )
      return;
    const attempt = this.transportRecoveryAttempt;
    const delayMs = Math.min(120_000, 5_000 * 2 ** Math.min(attempt, 5));
    this.transportRecoveryAttempt += 1;
    this.transportRecoveryTimer = setTimeout(() => {
      this.transportRecoveryTimer = null;
      void this.recoverTransport();
    }, delayMs);
    this.transportRecoveryTimer.unref?.();
  }

  async recoverTransport() {
    if (this.stopping || this.transport.health().ready) return;
    try {
      await this.startTransport();
    } catch (error) {
      this.lastError = error?.code || error?.message || String(error);
      this.status = "degraded";
      await this.transport.drain().catch(() => null);
      this.scheduleTransportRecovery();
    }
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
    this.observeProducer(event);
    try {
      const transportHealth = this.transport.health();
      if (transportHealth.connected || transportHealth.ready)
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

  async ingestBatch(events = []) {
    const batch = Array.isArray(events) ? events.slice(0, 100) : [];
    if (!batch.length) {
      const error = new Error("semantic_event_batch_required");
      error.code = "SEMANTIC_EVENT_BATCH_REQUIRED";
      throw error;
    }
    for (const event of batch) {
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
    }
    const results = await Promise.all(batch.map((event) => this.ingest(event)));
    return {
      accepted: results.filter((result) => result?.accepted !== false).length,
      queued: results.filter((result) => result?.queued).length,
      total: batch.length,
    };
  }

  async consume(event) {
    return this.consumeBatch([event]);
  }

  async consumeBatch(events) {
    const batch = Array.isArray(events) ? events : [events];
    if (!batch.length) return true;
    for (const event of batch) {
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
      this.observeProducer(event);
    }
    if (typeof this.store.insertBatch === "function")
      return this.store.insertBatch(batch);
    for (const event of batch) await this.store.insert(event);
    return true;
  }

  observeProducer(event = {}) {
    try {
      this.aicpObserver?.observeSemanticEvent(event);
    } catch (error) {
      console.warn("[OperationsPlane] AICP shadow observation skipped", {
        code: String(error?.code || "aicp_shadow_observation_failed").slice(
          0,
          128
        ),
      });
    }
    const runtimeRole = String(event.producer?.runtimeRole || "unknown").slice(
      0,
      96
    );
    const service = String(event.producer?.service || "unknown").slice(0, 160);
    this.producers.set(runtimeRole, {
      runtimeRole,
      service,
      lastEventAt: event.occurredAt || null,
      lastReceivedAt: new Date().toISOString(),
    });
    if (event.eventType === "module.telemetry.heartbeat" && event.subject?.id) {
      this.moduleHeartbeats.set(String(event.subject.id), {
        moduleId: String(event.subject.id),
        runtimeRole,
        service,
        lastEventAt: event.occurredAt || null,
        lastReceivedAt: new Date().toISOString(),
      });
    }
    if (this.producers.size > 100) {
      const oldest = [...this.producers.entries()].sort(
        ([, left], [, right]) =>
          Date.parse(left.lastReceivedAt) - Date.parse(right.lastReceivedAt)
      )[0];
      if (oldest) this.producers.delete(oldest[0]);
    }
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

  clearRecoveredError() {
    const transportHealth = this.transport.health();
    const storeHealth = this.store.health();
    const transportReady = Boolean(
      transportHealth.connected || transportHealth.ready
    );
    if (!transportReady || !storeHealth.ready || this.retryQueue.length) return;
    this.lastError = null;
    if (this.config.enabled && !this.stopping) this.status = "running";
  }

  async flushRetryQueue() {
    const batch = this.retryQueue.splice(0, 100);
    metrics.operationsRetryQueue.set(this.retryQueue.length);
    for (let index = 0; index < batch.length; index += 1) {
      const event = batch[index];
      try {
        const transportHealth = this.transport.health();
        if (transportHealth.connected || transportHealth.ready)
          await this.transport.publish(event);
        else await this.store.insert(event);
      } catch (error) {
        this.retryQueue.unshift(...batch.slice(index));
        metrics.operationsRetryQueue.set(this.retryQueue.length);
        this.lastError = error?.code || error?.message || String(error);
        break;
      }
    }
    this.clearRecoveredError();
    this.scheduleRetry();
  }

  async timelineWithMetadata(filters = {}) {
    const limit = Math.max(1, Math.min(Number(filters.limit) || 100, 500));
    let consumerState = {};
    try {
      consumerState = (await this.transport.consumerState?.()) || {};
    } catch (error) {
      this.lastError = error?.code || error?.message || String(error);
    }
    const publicConsumerState = () => ({
      ...consumerState,
      redeliveries:
        consumerState.redeliveries ?? consumerState.redelivered ?? null,
    });
    if (this.store.health().configured) {
      try {
        const [rows, persistedThrough] = await Promise.all([
          this.store.timeline({ ...filters, limit }),
          typeof this.store.latestPersistedAt === "function"
            ? this.store.latestPersistedAt()
            : Promise.resolve(this.store.health().persistedThrough || null),
        ]);
        this.clearRecoveredError();
        return {
          events: rows.map(eventFromClickHouseRow),
          source: "clickhouse",
          sources: ["clickhouse"],
          degraded: false,
          completeness: "complete",
          persistedThrough,
          ...publicConsumerState(),
        };
      } catch (error) {
        this.lastError = error?.code || error?.message || String(error);
      }
    }

    let natsFallback = null;
    try {
      if (typeof this.transport.recentEvents === "function") {
        natsFallback = await this.transport.recentEvents({
          limit,
          scanLimit: Math.min(Math.max(limit * 10, 500), 2_000),
          predicate: (event) => matches(event, filters),
        });
        consumerState = {
          ...consumerState,
          streamFirstSeq: natsFallback.streamFirstSeq,
          streamLastSeq: natsFallback.streamLastSeq,
        };
      }
    } catch (error) {
      this.lastError = error?.code || error?.message || String(error);
    }

    const recent = semanticEventSnapshot()
      .filter((event) => matches(event, filters))
      .sort(
        (left, right) =>
          Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
      );
    const deduplicated = new Map();
    for (const event of [...(natsFallback?.events || []), ...recent]) {
      if (!deduplicated.has(event.eventId))
        deduplicated.set(event.eventId, event);
    }
    const events = [...deduplicated.values()]
      .sort(
        (left, right) =>
          Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
      )
      .slice(0, limit);
    const usedNats = Boolean(natsFallback);
    return {
      events,
      source: usedNats ? "nats" : "recent-buffer",
      sources: usedNats ? ["nats", "recent-buffer"] : ["recent-buffer"],
      degraded: true,
      completeness: usedNats ? natsFallback.completeness : "partial",
      persistedThrough: this.store.health().persistedThrough || null,
      ...publicConsumerState(),
    };
  }

  async timeline(filters = {}) {
    return (await this.timelineWithMetadata(filters)).events;
  }

  async stop() {
    this.stopping = true;
    this.unregisterSink?.();
    this.unregisterSink = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.transportRecoveryTimer) clearTimeout(this.transportRecoveryTimer);
    this.transportRecoveryTimer = null;
    await this.transportRecoveryPromise?.catch(() => null);
    await this.flushRetryQueue().catch(() => null);
    await this.transport.drain();
    this.status = this.config.enabled ? "stopped" : "disabled";
    metrics.operationsRetryQueue.set(0);
  }

  aicpTopology() {
    return this.aicpObserver?.topology() || null;
  }

  aicpTrace(traceId) {
    return (
      this.aicpObserver?.trace(traceId) || {
        traceId: String(traceId || "").slice(0, 64),
        found: false,
        entries: [],
      }
    );
  }

  health() {
    const jetstream = this.transport.health();
    const clickhouse = this.store.health();
    const dynamicallyReady =
      this.config.enabled &&
      this.status === "running" &&
      jetstream.ready &&
      clickhouse.ready;
    const dynamicStatus = !this.config.enabled
      ? "disabled"
      : ["created", "starting", "stopped"].includes(this.status)
        ? this.status
        : dynamicallyReady
          ? "running"
          : "degraded";
    const producerStaleAfterMs = Math.max(
      30_000,
      Number(this.env.ATHENA_OPERATIONS_PRODUCER_STALE_MS || 180_000)
    );
    const producers = [...this.producers.values()]
      .map((producer) => ({
        ...producer,
        stale:
          Date.now() - Date.parse(producer.lastReceivedAt || 0) >
          producerStaleAfterMs,
      }))
      .sort((left, right) => left.runtimeRole.localeCompare(right.runtimeRole));
    const expectedModuleIds = this.expectedModuleIds;
    const moduleHeartbeats = [...this.moduleHeartbeats.values()]
      .map((heartbeat) => ({
        ...heartbeat,
        stale:
          Date.now() - Date.parse(heartbeat.lastReceivedAt || 0) >
          producerStaleAfterMs,
      }))
      .sort((left, right) => left.moduleId.localeCompare(right.moduleId));
    const freshModuleIds = new Set(
      moduleHeartbeats
        .filter((heartbeat) => !heartbeat.stale)
        .map((heartbeat) => heartbeat.moduleId)
    );
    return {
      enabled: this.config.enabled,
      status: dynamicStatus,
      ready: dynamicallyReady,
      lastError: jetstream.lastError || clickhouse.lastError || this.lastError,
      retryQueue: this.retryQueue.length,
      queuedTotal: this.queued,
      rejected: this.rejected,
      producerCoverage: {
        observed: producers.length,
        stale: producers.filter((producer) => producer.stale).length,
        staleAfterMs: producerStaleAfterMs,
        producers,
      },
      moduleHeartbeatCoverage: {
        expected: expectedModuleIds.length,
        observed: moduleHeartbeats.length,
        fresh: freshModuleIds.size,
        stale: moduleHeartbeats.filter((heartbeat) => heartbeat.stale).length,
        missing: expectedModuleIds.filter((id) => !freshModuleIds.has(id)),
        staleAfterMs: producerStaleAfterMs,
        planned: Object.entries(this.plannedModuleStates)
          .filter(([, state]) => state !== "running")
          .map(([moduleId, state]) => ({ moduleId, state })),
        heartbeats: moduleHeartbeats,
      },
      aicpShadow: this.aicpObserver?.health() || {
        enabled: false,
        mode: "shadow-read-only",
        status: "unavailable",
      },
      jetstream,
      clickhouse,
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
