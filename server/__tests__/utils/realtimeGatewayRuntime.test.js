const {
  RealtimeGatewayRuntime,
} = require("../../utils/realtimeGateway/runtime");

describe("RealtimeGatewayRuntime", () => {
  test("refuses standalone readiness with process-local memory transport", async () => {
    const runtime = new RealtimeGatewayRuntime({
      now: () => new Date("2026-07-07T00:00:00.000Z"),
    });

    expect(await runtime.start()).toMatchObject({
      role: "realtime-gateway",
      status: "not-ready",
      transport: {
        selected: "memory",
        ready: true,
        gatewaySafe: false,
      },
      lastError: "shared_broadcast_transport_required",
      boundary: {
        owns: [
          "sync.events.sse",
          "sync.outbox.dispatch",
          "realtime.broadcast.websocket",
        ],
        doesNotOwn: ["chat.sse", "agent.websocket", "crypto.websocket"],
      },
    });
  });

  test("records startup failures without throwing from snapshot", () => {
    const runtime = new RealtimeGatewayRuntime({
      now: () => new Date("2026-07-07T00:00:00.000Z"),
    });
    const snapshot = runtime.fail(new Error("boom"));

    expect(snapshot).toMatchObject({
      role: "realtime-gateway",
      status: "failed",
      lastError: "boom",
    });
  });
});
