const { broadcastCenter } = require("../broadcast");
const { broadcastTransportSummary } = require("../broadcast/transportRegistry");

class RealtimeGatewayRuntime {
  constructor({ now = () => new Date() } = {}) {
    this.startedAt = now().toISOString();
    this.now = now;
    this.status = "created";
    this.lastError = null;
  }

  start() {
    this.status = "running";
    return this.snapshot();
  }

  fail(error) {
    this.status = "failed";
    this.lastError = error?.message || String(error || "unknown");
    return this.snapshot();
  }

  snapshot() {
    return {
      role: "realtime-gateway",
      status: this.status,
      startedAt: this.startedAt,
      now: this.now().toISOString(),
      transport: broadcastTransportSummary(),
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
