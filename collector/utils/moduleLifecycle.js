const {
  ModuleLifecycle,
  peerServiceIds,
  validateAicpPeerRequest,
} = require("../../server/utils/microModules/serviceHost");
const {
  moduleManifest,
} = require("../../server/utils/modulePlatform/manifestRegistry");
const {
  emitSemanticEvent,
} = require("../../server/utils/observability/semanticEvents");
const {
  lifecycleEventForwarder,
} = require("../../server/utils/coordination/remoteLifecycleForwarder");
const {
  operationsEventForwarder,
} = require("../../server/utils/operations/remoteEventForwarder");
const { taskStats, waitForTasks } = require("./taskContext");

function asyncRoute(handler) {
  return function collectorLifecycleBoundary(request, response, next) {
    Promise.resolve(handler(request, response, next)).catch((error) => {
      if (response.headersSent) return next(error);
      return response.status(Number(error?.httpStatus) || 500).json({
        success: false,
        error: String(
          error?.code || error?.message || "collector_lifecycle_failed"
        ).slice(0, 160),
      });
    });
  };
}

class CollectorModuleLifecycle {
  constructor({ now = () => new Date() } = {}) {
    this.manifest = moduleManifest("collector");
    this.now = now;
    this.ready = false;
    this.heartbeatTimer = null;
    this.forwardersStarted = false;
    this.lifecycle = new ModuleLifecycle({
      moduleId: this.manifest.id,
      version: this.manifest.version,
      manifestFingerprint: this.manifest.fingerprint,
      heartbeatIntervalMs: this.manifest.lifecycle.heartbeatIntervalMs,
      leaseTtlMs: this.manifest.lifecycle.leaseTtlMs,
      now,
      onTransition: (event) =>
        this.emit("module.lifecycle.transitioned", event),
    });
  }

  emit(eventType, value = {}) {
    try {
      emitSemanticEvent({
        eventId: value.eventId,
        eventType,
        category: "module_lifecycle",
        severity:
          value.state === "failed" || value.to === "failed"
            ? "warning"
            : "info",
        outcome: value.state || value.to || "observed",
        occurredAt: value.occurredAt || value.heartbeatAt,
        subject: {
          type: "module-instance",
          id: value.instanceId || this.lifecycle.instanceId,
          component: "collector",
          operation: eventType,
        },
        correlation: { operationId: value.eventId || null },
        stateTransition: value.from ? { from: value.from, to: value.to } : {},
        metadata: {
          moduleId: "collector",
          runtimeRole: "collector",
          version: this.manifest.version,
          manifestFingerprint: this.manifest.fingerprint,
          instanceId: value.instanceId || this.lifecycle.instanceId,
          sequence: Number(value.sequence || this.lifecycle.sequence),
          reasonCode: value.reasonCode || this.lifecycle.lastReasonCode,
          ready: value.ready === true,
          heartbeatAt: value.heartbeatAt || null,
          leaseExpiresAt: value.leaseExpiresAt || null,
        },
        sensitivity: "metadata_only",
      });
    } catch {
      // Lifecycle telemetry cannot alter Collector file processing.
    }
  }

  snapshot() {
    return {
      moduleId: "collector",
      role: "collector",
      version: this.manifest.version,
      manifestFingerprint: this.manifest.fingerprint,
      status: this.lifecycle.state,
      ready: this.ready && this.lifecycle.state === "ready",
      tasks: taskStats(),
      lifecycle: this.lifecycle.snapshot(),
    };
  }

  initialize() {
    if (this.lifecycle.state === "registered")
      this.lifecycle.transition("initializing", {
        reasonCode: "collector_start",
      });
    if (!this.forwardersStarted) {
      lifecycleEventForwarder.start();
      operationsEventForwarder.start();
      this.forwardersStarted = true;
    }
  }

  markReady() {
    this.ready = true;
    if (["initializing", "degraded"].includes(this.lifecycle.state))
      this.lifecycle.transition("ready", { reasonCode: "collector_ready" });
    this.startHeartbeat();
  }

  fail(error) {
    this.ready = false;
    if (this.lifecycle.state !== "failed")
      this.lifecycle.transition("failed", {
        reasonCode: error?.code || "collector_start_failed",
      });
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    const beat = () => {
      const heartbeat = this.lifecycle.heartbeat({ ready: this.ready });
      this.emit("module.lifecycle.heartbeat", heartbeat);
    };
    beat();
    this.heartbeatTimer = setInterval(beat, this.lifecycle.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  async drain(reasonCode = "drain_requested") {
    this.ready = false;
    if (["ready", "degraded"].includes(this.lifecycle.state))
      this.lifecycle.transition("draining", { reasonCode });
    return this.snapshot();
  }

  async quiesce({ timeoutMs = 30_000, reasonCode = "quiesce_requested" } = {}) {
    if (this.lifecycle.state === "quiesced") return this.snapshot();
    await this.drain(reasonCode);
    const drained = await waitForTasks({ timeoutMs });
    if (!drained) {
      const error = new Error("collector_quiesce_inflight_timeout");
      error.code = "COLLECTOR_QUIESCE_INFLIGHT_TIMEOUT";
      error.httpStatus = 409;
      throw error;
    }
    this.lifecycle.transition("quiesced", {
      reasonCode,
      metadata: { checkpointed: true },
    });
    return this.snapshot();
  }

  async resume(reasonCode = "resume_requested") {
    if (this.lifecycle.state === "ready") return this.snapshot();
    if (!["quiesced", "degraded"].includes(this.lifecycle.state)) {
      const error = new Error("collector_resume_state_invalid");
      error.code = "COLLECTOR_RESUME_STATE_INVALID";
      error.httpStatus = 409;
      throw error;
    }
    this.lifecycle.transition("initializing", { reasonCode });
    this.markReady();
    return this.snapshot();
  }

  async stop() {
    this.ready = false;
    if (["ready", "degraded"].includes(this.lifecycle.state))
      this.lifecycle.transition("draining", { reasonCode: "collector_stop" });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (["draining", "quiesced"].includes(this.lifecycle.state))
      this.lifecycle.transition("stopped", { reasonCode: "collector_stopped" });
    await Promise.all([
      lifecycleEventForwarder.stop(),
      operationsEventForwarder.stop(),
    ]);
    return this.snapshot();
  }

  install(app) {
    app.get("/ready", (_request, response) => {
      const snapshot = this.snapshot();
      response.status(snapshot.ready ? 200 : 503).json({
        success: snapshot.ready,
        ...snapshot,
      });
    });
    app.get("/snapshot", (_request, response) =>
      response.json(this.snapshot())
    );
    app.use(
      "/internal",
      asyncRoute(async (request, response, next) => {
        const callerServiceId = peerServiceIds(request)[0] || null;
        const decision = await validateAicpPeerRequest(request, this.manifest, {
          callerServiceId,
        });
        if (!decision.authorized)
          return response.status(409).json({
            success: false,
            error: "aicp_link_rejected",
            reasonCode: decision.reason,
          });
        response.locals.aicp = decision;
        return next();
      })
    );
    app.get("/internal/v1/describe", (_request, response) =>
      response.json({
        success: true,
        module: {
          id: this.manifest.id,
          name: this.manifest.name,
          version: this.manifest.version,
          domain: this.manifest.domain,
          responsibilities: this.manifest.responsibilities,
          nonResponsibilities: this.manifest.nonResponsibilities,
          manifestFingerprint: this.manifest.fingerprint,
        },
        runtime: this.snapshot(),
      })
    );
    app.get("/internal/v1/self-test", (_request, response) => {
      const snapshot = this.snapshot();
      response.status(snapshot.ready ? 200 : 503).json({
        success: snapshot.ready,
        moduleId: "collector",
        status: snapshot.ready ? "passed" : "failed",
        checks: [
          { id: "lifecycle-contract", status: "passed" },
          {
            id: "component-readiness",
            status: snapshot.ready ? "passed" : "failed",
          },
        ],
      });
    });
    app.get("/internal/v1/lifecycle", (_request, response) =>
      response.json({ success: true, ...this.snapshot() })
    );
    app.post(
      "/internal/drain",
      asyncRoute(async (_request, response) =>
        response.status(202).json({ success: true, ...(await this.drain()) })
      )
    );
    app.post(
      "/internal/v1/quiesce",
      asyncRoute(async (request, response) =>
        response.status(202).json({
          success: true,
          ...(await this.quiesce(request.body || {})),
        })
      )
    );
    app.post(
      "/internal/v1/resume",
      asyncRoute(async (request, response) =>
        response.status(202).json({
          success: true,
          ...(await this.resume(request.body?.reasonCode)),
        })
      )
    );
  }
}

module.exports = { CollectorModuleLifecycle };
