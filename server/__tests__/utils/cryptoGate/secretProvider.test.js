describe("cryptoGate secretProvider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.dontMock("../../../utils/security");
  });

  test("config status degrades instead of throwing when encrypted secrets cannot decrypt", () => {
    jest.doMock("../../../utils/security", () => ({
      readSecret: jest.fn(() => {
        throw new Error("Failed to decrypt secret.");
      }),
    }));

    process.env.GATE_CRYPTO_ENABLED = "true";
    process.env.GATE_API_READONLY = "true";
    process.env.GATE_API_KEY_ENCRYPTED = "enc-key";
    process.env.GATE_API_SECRET_ENCRYPTED = "enc-secret";

    const { getGateConfigStatus } = require("../../../utils/cryptoGate/secretProvider");
    const status = getGateConfigStatus();

    expect(status.enabled).toBe(true);
    expect(status.readOnly).toBe(true);
    expect(status.hasApiKey).toBe(false);
    expect(status.hasApiSecret).toBe(false);
    expect(status.configError).toMatch(/Failed to decrypt/);
  });

  test("credentials still throw when configured encrypted secrets cannot decrypt", () => {
    jest.doMock("../../../utils/security", () => ({
      readSecret: jest.fn(() => {
        throw new Error("Failed to decrypt secret.");
      }),
    }));

    process.env.GATE_CRYPTO_ENABLED = "true";
    process.env.GATE_API_READONLY = "true";
    process.env.GATE_API_KEY_ENCRYPTED = "enc-key";
    process.env.GATE_API_SECRET_ENCRYPTED = "enc-secret";

    const { getGateCredentials } = require("../../../utils/cryptoGate/secretProvider");
    expect(() => getGateCredentials()).toThrow(/Failed to decrypt/);
  });
});
