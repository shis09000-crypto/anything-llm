const crypto = require("crypto");

const LIFECYCLE_STATES = Object.freeze([
  "registered",
  "initializing",
  "ready",
  "degraded",
  "draining",
  "quiesced",
  "stopped",
  "failed",
]);

const TRANSITIONS = Object.freeze({
  registered: new Set(["initializing", "stopped", "failed"]),
  initializing: new Set(["ready", "degraded", "failed", "stopped"]),
  ready: new Set(["degraded", "draining", "failed"]),
  degraded: new Set(["initializing", "ready", "draining", "failed"]),
  draining: new Set(["quiesced", "stopped", "failed"]),
  quiesced: new Set(["initializing", "stopped", "failed"]),
  stopped: new Set(["initializing"]),
  failed: new Set(["initializing", "stopped"]),
});

function lifecycleError(code, details = {}) {
  const error = new Error(code);
  error.code = code.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  error.details = details;
  error.httpStatus = 409;
  return error;
}

function safeReason(value, fallback = "unspecified") {
  const candidate = String(value || fallback).slice(0, 160);
  return /^[A-Za-z0-9_.:-]+$/.test(candidate) ? candidate : "reason_redacted";
}

class ModuleLifecycle {
  constructor({
    moduleId,
    version,
    manifestFingerprint,
    heartbeatIntervalMs = 30_000,
    leaseTtlMs = 90_000,
    instanceId = crypto.randomUUID(),
    now = () => new Date(),
    onTransition = () => {},
  } = {}) {
    if (!moduleId) throw lifecycleError("module_lifecycle_id_missing");
    this.moduleId = String(moduleId);
    this.version = String(version || "0.0.0");
    this.manifestFingerprint = String(manifestFingerprint || "");
    this.heartbeatIntervalMs = Math.max(1_000, Number(heartbeatIntervalMs));
    this.leaseTtlMs = Math.max(
      this.heartbeatIntervalMs * 2,
      Number(leaseTtlMs)
    );
    this.instanceId = String(instanceId);
    this.now = now;
    this.onTransition = onTransition;
    this.state = "registered";
    this.sequence = 0;
    this.lastReasonCode = "registered";
    this.lastTransitionAt = now().toISOString();
    this.heartbeatAt = null;
    this.leaseExpiresAt = null;
    this.history = [];
  }

  canTransition(to) {
    return TRANSITIONS[this.state]?.has(String(to)) === true;
  }

  transition(to, { reasonCode = "lifecycle_transition", metadata = {} } = {}) {
    const target = String(to);
    if (!LIFECYCLE_STATES.includes(target))
      throw lifecycleError("module_lifecycle_state_invalid", { target });
    if (target === this.state) return this.snapshot();
    if (!this.canTransition(target))
      throw lifecycleError("module_lifecycle_transition_denied", {
        from: this.state,
        to: target,
      });
    const previous = this.state;
    const occurredAt = this.now().toISOString();
    this.state = target;
    this.sequence += 1;
    this.lastReasonCode = safeReason(reasonCode);
    this.lastTransitionAt = occurredAt;
    const event = {
      schema: "athena.module.lifecycle-event",
      schemaVersion: "1.0",
      eventId: crypto.randomUUID(),
      moduleId: this.moduleId,
      instanceId: this.instanceId,
      sequence: this.sequence,
      from: previous,
      to: target,
      reasonCode: this.lastReasonCode,
      occurredAt,
      metadata: Object.fromEntries(
        Object.entries(metadata || {})
          .filter(([, value]) =>
            ["string", "number", "boolean"].includes(typeof value)
          )
          .slice(0, 20)
      ),
    };
    this.history.push(event);
    this.history = this.history.slice(-100);
    try {
      this.onTransition(event);
    } catch {
      // Lifecycle observation is not allowed to alter the transition result.
    }
    return this.snapshot();
  }

  heartbeat(component = {}) {
    const at = this.now();
    this.heartbeatAt = at.toISOString();
    this.leaseExpiresAt = new Date(
      at.getTime() + this.leaseTtlMs
    ).toISOString();
    return {
      moduleId: this.moduleId,
      instanceId: this.instanceId,
      state: this.state,
      heartbeatAt: this.heartbeatAt,
      leaseExpiresAt: this.leaseExpiresAt,
      ready: this.state === "ready" && component.ready !== false,
    };
  }

  snapshot() {
    return {
      schema: "athena.module.lifecycle",
      schemaVersion: "1.0",
      moduleId: this.moduleId,
      instanceId: this.instanceId,
      version: this.version,
      manifestFingerprint: this.manifestFingerprint,
      state: this.state,
      sequence: this.sequence,
      lastReasonCode: this.lastReasonCode,
      lastTransitionAt: this.lastTransitionAt,
      heartbeatAt: this.heartbeatAt,
      leaseExpiresAt: this.leaseExpiresAt,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      leaseTtlMs: this.leaseTtlMs,
    };
  }
}

module.exports = {
  LIFECYCLE_STATES,
  ModuleLifecycle,
  TRANSITIONS,
};
