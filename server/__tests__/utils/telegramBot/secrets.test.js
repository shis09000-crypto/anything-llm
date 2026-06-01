const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Telegram bot token storage", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_MASTER_KEY;
  });

  it("stores bot tokens with enc:v1 and decrypts them for use", () => {
    const { decryptToken, encryptToken } = require("../../../utils/telegramBot/utils");
    const { isSecretEncrypted } = require("../../../utils/security");

    const encrypted = encryptToken("telegram-token");

    expect(isSecretEncrypted(encrypted)).toBe(true);
    expect(decryptToken(encrypted)).toBe("telegram-token");
  });

  it("keeps old plaintext bot tokens compatible", () => {
    const { decryptToken } = require("../../../utils/telegramBot/utils");

    expect(decryptToken("legacy-token")).toBe("legacy-token");
  });
});
