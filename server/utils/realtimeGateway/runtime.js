const { broadcastCenter } = require("../broadcast");
const { broadcastTransportSummary } = require("../broadcast/transportRegistry");
const { DataAccessCenter } = require("../dataAccess");

class RealtimeGatewayRuntime {
  constructor({ now = () => new Date() } = {}) {
    this.startedAt = now().toISOString();
    this.now = now;
    this.status = "created";
    this.lastError = null;
  }

  async start() {
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
      this.status = "running";
      this.lastError = null;
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
    await broadcastCenter.drainSharedTransport();
    this.status = "stopped";
    return this.snapshot();
  }

  snapshot() {
    return {
      role: "realtime-gateway",
      status: this.status,
      startedAt: this.startedAt,
      now: this.now().toISOString(),
      transport: broadcastTransportSummary(),
      realtimeTickets:
        DataAccessCenter.adminSystem.realtimeTicket.storeSummary(),
      broadcast: broadcastCenter.snapshot(),
      lastError: this.lastError,
      boundary: {
        owns: ["sync.events.sse", "realtime.broadcast.websocket"],
        doesNotOwn: ["chat.sse", "agent.websocket", "crypto.websocket"],
      },
    };
  }
}

module.exports = { RealtimeGatewayRuntime };
