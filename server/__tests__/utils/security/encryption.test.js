const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function loadSecurity() {
  jest.resetModules();
  return require("../../../utils/security");
}

describe("security secret encryption", () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_MASTER_KEY;
    else process.env.ENCRYPTION_MASTER_KEY = originalKey;
  });

  it("encrypts and decrypts a secret round trip", () => {
    const { decryptSecret, encryptSecret, isEncryptedSecret, SECRET_PREFIX } =
      loadSecurity();

    const encrypted = encryptSecret("plain-secret");

    expect(encrypted).toMatch(new RegExp(`^${SECRET_PREFIX}`));
    expect(isEncryptedSecret(encrypted)).toBe(true);
    expect(decryptSecret(encrypted)).toBe("plain-secret");
  });

  it("keeps null undefined and empty string unchanged while saving", () => {
    const { encryptSecret, saveSecret } = loadSecurity();

    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret(undefined)).toBeUndefined();
    expect(encryptSecret("")).toBe("");
    expect(saveSecret("")).toBe("");
  });

  it("detects encrypted secrets by prefix only", () => {
    const { isEncryptedSecret } = loadSecurity();

    expect(isEncryptedSecret("enc:v1:a:b:c")).toBe(true);
    expect(isEncryptedSecret("enc:v2:a:b:c")).toBe(false);
    expect(isEncryptedSecret("plain")).toBe(false);
  });

  it("decryptSecretIfNeeded returns old plaintext unchanged", () => {
    const { decryptSecretIfNeeded } = loadSecurity();

    expect(decryptSecretIfNeeded("old-plain-secret")).toBe("old-plain-secret");
  });

  it("saveSecret avoids double encryption", () => {
    const { saveSecret } = loadSecurity();

    const encrypted = saveSecret("plain-secret");
    expect(saveSecret(encrypted)).toBe(encrypted);
  });

  it("readSecret decrypts encrypted values and returns plaintext values", () => {
    const { readSecret, saveSecret } = loadSecurity();

    const encrypted = saveSecret("plain-secret");

    expect(readSecret(encrypted)).toBe("plain-secret");
    expect(readSecret("old-plain-secret")).toBe("old-plain-secret");
  });

  it("throws a config error when master key is missing", () => {
    const { encryptSecret, EncryptionConfigError } = loadSecurity();
    delete process.env.ENCRYPTION_MASTER_KEY;

    expect(() => encryptSecret("plain-secret")).toThrow(EncryptionConfigError);
  });

  it("throws a config error when master key has invalid format", () => {
    const { encryptSecret, EncryptionConfigError } = loadSecurity();
    process.env.ENCRYPTION_MASTER_KEY = "not-hex";

    expect(() => encryptSecret("plain-secret")).toThrow(EncryptionConfigError);
  });

  it("throws a format error for invalid encrypted format", () => {
    const { decryptSecret, EncryptionFormatError } = loadSecurity();

    expect(() => decryptSecret("enc:v1:only-two-parts")).toThrow(
      EncryptionFormatError
    );
  });

  it("throws an operation error when ciphertext is tampered", () => {
    const { decryptSecret, encryptSecret, EncryptionOperationError } =
      loadSecurity();
    const encrypted = encryptSecret("plain-secret");
    const tampered = encrypted.slice(0, -2) + "aa";

    expect(() => decryptSecret(tampered)).toThrow(EncryptionOperationError);
  });
});
