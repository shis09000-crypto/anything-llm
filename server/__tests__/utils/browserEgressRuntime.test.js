describe("BrowserEgressRuntime", () => {
  it("publishes readiness metrics without requiring an enabled gateway", () => {
    const { BrowserEgressRuntime } = require("../../utils/browserEgress/runtime");
    const runtime = new BrowserEgressRuntime({
      ATHENA_BROWSER_EGRESS_ENABLED: "false",
    });

    expect(runtime.status()).toEqual(
      expect.objectContaining({
        ready: true,
        enabled: false,
        configured: false,
        gatewayReady: false,
      })
    );
  });
});
