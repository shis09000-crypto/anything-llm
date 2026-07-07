const {
  broadcastTransportSummary,
  ensureBroadcastTransportSupported,
  selectedBroadcastTransport,
} = require("../../utils/broadcast/transportRegistry");

describe("broadcast transport registry", () => {
  test("defaults to memory transport", () => {
    const env = {};
    expect(selectedBroadcastTransport(env)).toBe("memory");
    expect(ensureBroadcastTransportSupported(env)).toMatchObject({
      ok: true,
      selected: "memory",
      ready: true,
    });
  });

  test("reports reserved transports as unsupported", () => {
    const summary = broadcastTransportSummary({
      ATHENA_BROADCAST_TRANSPORT: "redis",
    });
    expect(summary).toMatchObject({
      selected: "redis",
      ready: false,
      active: {
        adapter: "redis",
        status: "reserved",
        multiInstance: true,
      },
    });
    expect(
      ensureBroadcastTransportSupported({
        ATHENA_BROADCAST_TRANSPORT: "redis",
      })
    ).toMatchObject({
      ok: false,
      code: "BROADCAST_TRANSPORT_NOT_IMPLEMENTED",
    });
  });

  test("reports unknown transport explicitly", () => {
    expect(
      ensureBroadcastTransportSupported({
        ATHENA_BROADCAST_TRANSPORT: "kafka",
      })
    ).toMatchObject({
      ok: false,
      selected: "kafka",
      ready: false,
      active: {
        adapter: "kafka",
        status: "unknown",
      },
    });
  });
});
