const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Advanced Gateway secret helpers", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_MASTER_KEY;
  });

  it("stores new secrets with enc:v1 and decrypts them for use", () => {
    const { decryptSecret, encryptSecret } = require("../../endpoints/advancedGateway");
    const { isSecretEncrypted } = require("../../utils/security");

    const encrypted = encryptSecret("gateway-secret");

    expect(isSecretEncrypted(encrypted)).toBe(true);
    expect(decryptSecret(encrypted)).toBe("gateway-secret");
  });

  it("keeps old plaintext gateway secrets compatible", () => {
    const { decryptSecret } = require("../../endpoints/advancedGateway");

    expect(decryptSecret("legacy-secret")).toBe("legacy-secret");
  });
});
