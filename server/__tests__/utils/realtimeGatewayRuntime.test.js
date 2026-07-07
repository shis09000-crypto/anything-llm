const { RealtimeGatewayRuntime } = require("../../utils/realtimeGateway/runtime");

describe("RealtimeGatewayRuntime", () => {
  test("reports realtime boundary and transport status", () => {
    const runtime = new RealtimeGatewayRuntime({
      now: () => new Date("2026-07-07T00:00:00.000Z"),
    });

    expect(runtime.start()).toMatchObject({
      role: "realtime-gateway",
      status: "running",
      transport: {
        selected: "memory",
        ready: true,
      },
      boundary: {
        owns: ["sync.events.sse", "realtime.broadcast.websocket"],
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
