const { broadcastCenter } = require("../broadcast");
const { broadcastTransportSummary } = require("../broadcast/transportRegistry");
const { DataAccessCenter } = require("../dataAccess");
const { serviceIdentitySummary } = require("../security/serviceIdentity");
const { moduleReadinessEnvelope } = require("../modulePlatform/readiness");
const {
  startSyncV2OutboxDispatcher,
  stopSyncV2OutboxDispatcher,
  syncV2OutboxSnapshot,
} = require("../syncV2/outboxDispatcher");
const {
  probeIdentityCapabilities,
} = require("../authz/identityOperationsClient");
const { emitSemanticEvent } = require("../observability/semanticEvents");

class RealtimeGatewayRuntime {
  constructor({
    now = () => new Date(),
    identityProbe = probeIdentityCapabilities,
  } = {}) {
    this.startedAt = now().toISOString();
    this.now = now;
    this.status = "created";
    this.lastError = null;
    this.identityProbe = identityProbe;
    this.identityCapabilities = { ready: false, capabilities: {} };
    this.identityCapabilityObserved = false;
    this.capabilityTimer = null;
  }

  async refreshIdentityCapabilities() {
    const previousReady = this.identityCapabilities.ready === true;
    let next;
    try {
      next = await this.identityProbe();
    } catch {
      next = { ready: false, capabilities: {} };
    }
    this.identityCapabilities = next;
    if (!next.ready) {
      this.status = "degraded";
      this.lastError = "identity_capability_unavailable";
    } else if (["degraded", "not-ready"].includes(this.status)) {
      this.status = "running";
      this.lastError = null;
    }
    if (!this.identityCapabilityObserved || previousReady !== next.ready) {
      emitSemanticEvent({
        eventType: next.ready
          ? "runtime.database_capability.recovered"
          : "runtime.database_capability.missing",
        category: "runtime",
        severity: next.ready ? "info" : "error",
        outcome: next.ready ? "recovered" : "degraded",
        subject: {
          type: "component",
          component: "realtime-gateway",
          operation: "identity-capability-matrix",
        },
        metadata: {
          missingCapabilities: Object.entries(next.capabilities || {})
            .filter(([, value]) => value !== "ready")
            .map(([key]) => key)
            .sort(),
        },
        sensitivity: "metadata_only",
      });
    }
    this.identityCapabilityObserved = true;
    return next;
  }

  async start() {
    const identity = serviceIdentitySummary("realtime-gateway");
    if (!identity.valid) {
      this.status = "not-ready";
      this.lastError = identity.error;
      return this.snapshot();
    }
    const transport = broadcastTransportSummary();
    const tickets = DataAccessCenter.adminSystem.realtimeTicket.storeSummary();
    if (!transport.gatewaySafe) {
      this.status = "not-ready";
      this.lastError = "shared_broadcast_transport_required";
      return this.snapshot();
    }
    if (!tickets.gatewaySafe) {
      this.status = "not-ready";
      this.lastError = "shared_realtime_ticket_store_required";
      return this.snapshot();
    }
    try {
      const health = await broadcastCenter.startSharedTransport();
      if (!health.ready)
        throw new Error("shared_broadcast_transport_unhealthy");
      await startSyncV2OutboxDispatcher();
      this.status = "running";
      this.lastError = null;
      await this.refreshIdentityCapabilities();
      this.capabilityTimer ||= setInterval(
        () => void this.refreshIdentityCapabilities(),
        15_000
      );
      this.capabilityTimer.unref?.();
    } catch (error) {
      this.status = "not-ready";
      this.lastError = error?.code || error?.message || String(error);
    }
    return this.snapshot();
  }

  fail(error) {
    this.status = "failed";
    this.lastError = error?.message || String(error || "unknown");
    return this.snapshot();
  }

  async stop() {
    if (this.capabilityTimer) clearInterval(this.capabilityTimer);
    this.capabilityTimer = null;
    await stopSyncV2OutboxDispatcher();
    await broadcastCenter.drainSharedTransport();
    this.status = "stopped";
    return this.snapshot();
  }

  snapshot() {
    const component = {
      role: "realtime-gateway",
      status: this.status,
      startedAt: this.startedAt,
      now: this.now().toISOString(),
      transport: broadcastTransportSummary(),
      realtimeTickets:
        DataAccessCenter.adminSystem.realtimeTicket.storeSummary(),
      broadcast: broadcastCenter.snapshot(),
      syncOutbox: syncV2OutboxSnapshot(),
      lastError: this.lastError,
      identityCapabilities: this.identityCapabilities,
      serviceIdentity: serviceIdentitySummary("realtime-gateway", {
        required: false,
      }),
      boundary: {
        owns: [
          "sync.events.sse",
          "sync.outbox.dispatch",
          "realtime.broadcast.websocket",
        ],
        doesNotOwn: ["chat.sse", "agent.websocket", "crypto.websocket"],
      },
    };
    const ready =
      this.status === "running" && this.identityCapabilities.ready === true;
    return {
      ...moduleReadinessEnvelope("sync-v2", component, {
        source: "realtime-gateway-runtime",
        ready,
      }),
      ...component,
      ready,
    };
  }
}

module.exports = { RealtimeGatewayRuntime };
