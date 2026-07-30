const {
  registerSemanticEventSink,
  semanticEvent,
} = require("../observability/semanticEvents");
const { requestInternalService } = require("../microModules/internalClient");
const { distributedTopology } = require("../microModules/serviceHost");
const { loadManifests } = require("../modulePlatform/manifestRegistry");

const MAX_QUEUE = 2_000;
const MAX_BATCH = 50;

function operationsInternalUrl(env = process.env) {
  return String(env.ATHENA_OPERATIONS_INTERNAL_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function forwardingEnabled(env = process.env) {
  const role = String(env.ATHENA_RUNTIME_ROLE || "api").trim();
  return (
    distributedTopology(env) &&
    role !== "operations-plane" &&
    Boolean(operationsInternalUrl(env))
  );
}

function moduleIdsForRole(role, env = process.env) {
  const manifests = loadManifests();
  const known = new Set(manifests.map((manifest) => manifest.id));
  const ids = manifests
    .filter((manifest) => manifest.runtimeRole === role)
    .map((manifest) => manifest.id);
  for (const configured of String(env.ATHENA_COLOCATED_MODULE_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (known.has(configured)) ids.push(configured);
  }
  return [...new Set(ids.length ? ids : [role])];
}

function moduleIdForRole(role, env = process.env) {
  return moduleIdsForRole(role, env)[0] || role;
}

class OperationsEventForwarder {
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
    this.heartbeatTimer = null;
    this.flushing = null;
    this.stopped = false;
    this.failures = 0;
    this.sent = 0;
    this.dropped = 0;
    this.lastError = null;
  }

  enabled() {
    return forwardingEnabled(this.env);
  }

  start() {
    if (!this.enabled() || this.unregisterSink) return this.snapshot();
    this.stopped = false;
    this.unregisterSink = this.registerSink((event) => this.enqueue(event));
    this.scheduleHeartbeat();
    return this.snapshot();
  }

  heartbeatEnabled() {
    return (
      String(this.env.ATHENA_OPERATIONS_HEARTBEAT_ENABLED || "true")
        .trim()
        .toLowerCase() !== "false"
    );
  }

  heartbeat() {
    if (!this.enabled() || !this.heartbeatEnabled() || this.stopped) return;
    const role = String(this.env.ATHENA_RUNTIME_ROLE || "api").trim();
    for (const moduleId of moduleIdsForRole(role, this.env))
      this.enqueue(
        semanticEvent({
          eventType: "module.telemetry.heartbeat",
          category: "module_health",
          severity: "info",
          outcome: "observed",
          subject: {
            type: "service",
            id: moduleId,
            component: moduleId,
            operation: "semantic_event_forwarding",
          },
          impact: {
            scope: "operations_plane",
            status: "connected",
          },
          sensitivity: "metadata_only",
        })
      );
  }

  scheduleHeartbeat() {
    if (
      this.heartbeatTimer ||
      !this.enabled() ||
      !this.heartbeatEnabled() ||
      this.stopped
    )
      return;
    this.heartbeat();
    const intervalMs = Math.max(
      15_000,
      Math.min(
        Number(this.env.ATHENA_OPERATIONS_HEARTBEAT_MS) || 60_000,
        5 * 60_000
      )
    );
    this.heartbeatTimer = setInterval(() => this.heartbeat(), intervalMs);
    this.heartbeatTimer.unref?.();
  }

  enqueue(event) {
    if (!event?.eventId || this.queuedIds.has(event.eventId))
      return this.snapshot();
    if (this.queue.length >= MAX_QUEUE) {
      const dropped = this.queue.shift();
      if (dropped?.eventId) this.queuedIds.delete(dropped.eventId);
      this.dropped += 1;
    }
    this.queue.push(event);
    this.queuedIds.add(event.eventId);
    this.schedule(100);
    return this.snapshot();
  }

  schedule(delayMs) {
    if (this.timer || this.stopped || !this.queue.length) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.flush();
      },
      Math.max(50, Number(delayMs) || 0)
    );
    this.timer.unref?.();
  }

  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.enabled() || !this.queue.length)
      return { sent: 0, skipped: true };
    const batch = this.queue.splice(0, MAX_BATCH);
    for (const event of batch) this.queuedIds.delete(event.eventId);
    this.flushing = this.request({
      callerRole: String(this.env.ATHENA_RUNTIME_ROLE || "api"),
      url: `${operationsInternalUrl(this.env)}/internal/v1/operations/ingest-batch`,
      method: "POST",
      body: { events: batch },
      env: this.env,
      timeoutMs: 5_000,
    })
      .then((result) => {
        this.failures = 0;
        this.lastError = null;
        this.sent += Number(result?.accepted || batch.length);
        return { sent: batch.length, skipped: false };
      })
      .catch((error) => {
        this.failures += 1;
        this.lastError = String(
          error?.code || error?.message || "operations_forward_failed"
        ).slice(0, 160);
        for (const event of batch.reverse()) {
          if (this.queuedIds.has(event.eventId)) continue;
          this.queue.unshift(event);
          this.queuedIds.add(event.eventId);
        }
        while (this.queue.length > MAX_QUEUE) {
          const dropped = this.queue.pop();
          if (dropped?.eventId) this.queuedIds.delete(dropped.eventId);
          this.dropped += 1;
        }
        return { sent: 0, skipped: false, error: this.lastError };
      })
      .finally(() => {
        this.flushing = null;
        if (this.queue.length) {
          const delay = this.failures
            ? Math.min(30_000, 500 * 2 ** Math.min(this.failures, 6))
            : 100;
          this.schedule(delay);
        }
      });
    return this.flushing;
  }

  async stop() {
    this.stopped = true;
    this.unregisterSink?.();
    this.unregisterSink = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
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
      heartbeatEnabled: this.heartbeatEnabled(),
      lastError: this.lastError,
    };
  }
}

const operationsEventForwarder = new OperationsEventForwarder();

module.exports = {
  OperationsEventForwarder,
  forwardingEnabled,
  operationsEventForwarder,
  operationsInternalUrl,
  moduleIdForRole,
  moduleIdsForRole,
};
