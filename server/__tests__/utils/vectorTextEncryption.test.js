const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("vector provider text encryption", () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;

  beforeEach(() => {
    jest.resetModules();
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_MASTER_KEY;
    else process.env.ENCRYPTION_MASTER_KEY = originalKey;
    delete process.env.VECTOR_TEXT_ENCRYPTION;
    delete process.env.VECTOR_TEXT_ENCRYPTION_DISABLED;
  });

  it("stores vector text as an encrypted string envelope", () => {
    const {
      decryptVectorText,
      encryptVectorText,
      isEncryptedVectorText,
    } = require("../../utils/security/vectorTextEncryption");

    const stored = encryptVectorText("sensitive rag chunk text");

    expect(typeof stored).toBe("string");
    expect(isEncryptedVectorText(stored)).toBe(true);
    expect(stored).not.toContain("sensitive rag chunk");
    expect(decryptVectorText(stored)).toBe("sensitive rag chunk text");
  });

  it("keeps legacy plaintext vector text readable", () => {
    const { decryptVectorText, isEncryptedVectorText } = require("../../utils/security/vectorTextEncryption");

    expect(isEncryptedVectorText("legacy text")).toBe(false);
    expect(decryptVectorText("legacy text")).toBe("legacy text");
  });

  it("can disable vector text encryption for compatibility", () => {
    process.env.VECTOR_TEXT_ENCRYPTION = "false";
    const {
      encryptVectorText,
      isEncryptedVectorText,
    } = require("../../utils/security/vectorTextEncryption");

    const stored = encryptVectorText("plain compatibility text");

    expect(isEncryptedVectorText(stored)).toBe(false);
    expect(stored).toBe("plain compatibility text");
  });
});
