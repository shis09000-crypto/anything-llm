const crypto = require("crypto");
const {
  registerSemanticEventSink,
} = require("../observability/semanticEvents");
const { moduleIdForRole } = require("../operations/remoteEventForwarder");
const { requestInternalService } = require("../microModules/internalClient");
const { distributedTopology } = require("../microModules/serviceHost");

const MAX_QUEUE = 1_000;

function coordinationInternalUrl(env = process.env) {
  return String(env.ATHENA_COORDINATION_INTERNAL_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function forwardingEnabled(env = process.env) {
  const role = String(env.ATHENA_RUNTIME_ROLE || "api").trim();
  return (
    distributedTopology(env) &&
    role !== "coordination-plane" &&
    Boolean(coordinationInternalUrl(env))
  );
}

function coordinationContext(eventId, center = "recovery") {
  const runId = `lifecycle:${eventId}`;
  return {
    coordinationRunId: runId,
    stepId: `forward:${eventId}`,
    center,
    correlationId: eventId,
    causationId: null,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    priority: "P2",
    idempotencyKey: eventId,
  };
}

function lifecycleRecord(event = {}) {
  const metadata = event.metadata || {};
  const moduleId = metadata.moduleId || event.subject?.component;
  const instanceId = metadata.instanceId || event.subject?.id;
  if (!moduleId || !instanceId) return null;
  if (event.eventType === "module.lifecycle.heartbeat")
    return {
      type: "heartbeat",
      capability: "coordination.lifecycle.heartbeat",
      path: "/internal/v1/coordination/modules/heartbeat",
      id: `heartbeat:${instanceId}:${metadata.sequence || event.eventId}`,
      payload: {
        moduleId,
        instanceId,
        runtimeRole: metadata.runtimeRole || moduleId,
        version: metadata.version || "0.0.0",
        manifestFingerprint: metadata.manifestFingerprint || "unknown",
        state: event.outcome || "degraded",
        sequence: Number(metadata.sequence || 0),
        heartbeatAt: metadata.heartbeatAt || event.occurredAt,
        leaseExpiresAt:
          metadata.leaseExpiresAt ||
          new Date(Date.parse(event.occurredAt) + 90_000).toISOString(),
        lastReasonCode: metadata.reasonCode || null,
        metadata: { ready: String(metadata.ready) === "true" },
      },
    };
  if (event.eventType !== "module.lifecycle.transitioned") return null;
  return {
    type: "event",
    capability: "coordination.lifecycle.event",
    path: "/internal/v1/coordination/modules/lifecycle-events",
    id: event.eventId || crypto.randomUUID(),
    payload: {
      eventId: event.eventId || crypto.randomUUID(),
      moduleId,
      instanceId,
      sequence: Number(metadata.sequence || 0),
      from: event.stateTransition?.from || "registered",
      to: event.stateTransition?.to || event.outcome || "failed",
      reasonCode: metadata.reasonCode || "lifecycle_transition",
      occurredAt: event.occurredAt,
      metadata: {},
    },
  };
}

class LifecycleEventForwarder {
  constructor({
    env = process.env,
    request = requestInternalService,
    registerSink = registerSemanticEventSink,
  } = {}) {
    this.env = env;
    this.request = request;
    this.registerSink = registerSink;
    this.unregisterSink = null;
    this.queue = [];
    this.queuedIds = new Set();
    this.timer = null;
    this.flushing = null;
    this.stopped = false;
    this.sent = 0;
    this.dropped = 0;
    this.failures = 0;
    this.lastError = null;
  }

  enabled() {
    return forwardingEnabled(this.env);
  }

  start() {
    if (!this.enabled() || this.unregisterSink) return this.snapshot();
    this.stopped = false;
    this.unregisterSink = this.registerSink((event) => this.enqueue(event));
    return this.snapshot();
  }

  enqueue(event) {
    const record = lifecycleRecord(event);
    if (!record || this.queuedIds.has(record.id)) return this.snapshot();
    if (record.type === "heartbeat") {
      const staleIndex = this.queue.findIndex(
        (item) =>
          item.type === "heartbeat" &&
          item.payload.instanceId === record.payload.instanceId
      );
      if (staleIndex >= 0) {
        this.queuedIds.delete(this.queue[staleIndex].id);
        this.queue.splice(staleIndex, 1);
      }
    }
    if (this.queue.length >= MAX_QUEUE) {
      const dropped = this.queue.shift();
      if (dropped) this.queuedIds.delete(dropped.id);
      this.dropped += 1;
    }
    this.queue.push(record);
    this.queuedIds.add(record.id);
    this.schedule(50);
    return this.snapshot();
  }

  schedule(delayMs) {
    if (this.timer || this.stopped || !this.queue.length) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.flush();
      },
      Math.max(25, Number(delayMs) || 0)
    );
    this.timer.unref?.();
  }

  async flush() {
    if (this.flushing) return this.flushing;
    const record = this.queue.shift();
    if (!record || !this.enabled()) return { sent: 0, skipped: true };
    this.queuedIds.delete(record.id);
    const runtimeRole = String(this.env.ATHENA_RUNTIME_ROLE || "api");
    const callerModule =
      record.payload.moduleId || moduleIdForRole(runtimeRole);
    this.flushing = this.request({
      callerRole: runtimeRole,
      callerModule,
      targetModule: "coordination-plane",
      capability: record.capability,
      url: `${coordinationInternalUrl(this.env)}${record.path}`,
      method: "POST",
      body: record.payload,
      idempotencyKey: record.id,
      coordinationContext: coordinationContext(record.id),
      env: this.env,
      timeoutMs: 5_000,
    })
      .then(() => {
        this.sent += 1;
        this.failures = 0;
        this.lastError = null;
        return { sent: 1, skipped: false };
      })
      .catch((error) => {
        this.failures += 1;
        this.lastError = String(
          error?.code || error?.message || "lifecycle_forward_failed"
        ).slice(0, 160);
        if (!this.queuedIds.has(record.id)) {
          this.queue.unshift(record);
          this.queuedIds.add(record.id);
        }
        return { sent: 0, skipped: false, error: this.lastError };
      })
      .finally(() => {
        this.flushing = null;
        if (this.queue.length)
          this.schedule(
            this.failures
              ? Math.min(30_000, 500 * 2 ** Math.min(this.failures, 6))
              : 50
          );
      });
    return this.flushing;
  }

  async stop() {
    this.stopped = true;
    this.unregisterSink?.();
    this.unregisterSink = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const deadline = Date.now() + 2_000;
    while (this.queue.length && Date.now() < deadline) {
      await this.flush();
      if (this.lastError) break;
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      enabled: this.enabled(),
      status: !this.enabled()
        ? "disabled"
        : this.lastError
          ? "degraded"
          : this.unregisterSink
            ? "running"
            : "created",
      queued: this.queue.length,
      sent: this.sent,
      dropped: this.dropped,
      failures: this.failures,
      lastError: this.lastError,
    };
  }
}

const lifecycleEventForwarder = new LifecycleEventForwarder();

module.exports = {
  LifecycleEventForwarder,
  coordinationInternalUrl,
  forwardingEnabled,
  lifecycleEventForwarder,
  lifecycleRecord,
};
