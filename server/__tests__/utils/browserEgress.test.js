const crypto = require("crypto");
const {
  BrowserEgressRuntime,
  safePublicKey,
} = require("../../utils/browserEgress/runtime");

describe("Browser Egress control contracts", () => {
  test("accepts only RSA 3072-or-stronger device envelope keys", () => {
    const strong = crypto.generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const weak = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    expect(safePublicKey(strong.publicKey).asymmetricKeyType).toBe("rsa");
    expect(() => safePublicKey(weak.publicKey)).toThrow(
      "browser_egress_node_key_too_weak"
    );
  });

  test("disabled or unconfigured egress fails closed", async () => {
    const disabled = new BrowserEgressRuntime({
      ATHENA_BROWSER_EGRESS_ENABLED: "false",
    });
    expect(disabled.status()).toMatchObject({
      ready: true,
      enabled: false,
      gatewayReady: false,
    });
    await expect(disabled.issue({})).rejects.toMatchObject({
      code: "browser_egress_disabled",
      httpStatus: 503,
    });
  });

  test("exports disabled state separately from gateway health", async () => {
    const { registry } = require("../../utils/observability/metrics");
    const disabled = new BrowserEgressRuntime({
      ATHENA_BROWSER_EGRESS_ENABLED: "false",
    });
    disabled.status();
    const metrics = await registry.metrics();
    expect(metrics).toMatch(/athena_browser_egress_enabled\{[^}]+\} 0/);
    expect(metrics).toMatch(/athena_browser_egress_gateway_ready\{[^}]+\} 0/);
  });
});
