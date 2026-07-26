const crypto = require("crypto");
const {
  EncryptionWorker,
} = require("../../../collector/utils/EncryptionWorker");

describe("Collector EncryptionWorker", () => {
  const originalEnvironment = { ...process.env };
  const rootKey = crypto.randomBytes(32);
  let worker;

  beforeEach(() => {
    delete process.env.ATHENA_COLLECTOR_LEGACY_PAYLOAD_DECRYPT;
    worker = new EncryptionWorker(rootKey.toString("base64"));
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  test("writes authenticated v2 envelopes and decrypts them", () => {
    const plaintext = JSON.stringify({ token: "secret", page: 3 });
    const encrypted = worker.encrypt(plaintext);

    expect(encrypted).toMatch(/^v2:/);
    expect(worker.decrypt(encrypted)).toBe(plaintext);
  });

  test("rejects a modified authenticated envelope", () => {
    const encrypted = worker.encrypt("sensitive-payload");
    const parts = encrypted.split(":");
    const ciphertext = Buffer.from(parts[2], "base64url");
    ciphertext[0] ^= 1;
    parts[2] = ciphertext.toString("base64url");

    expect(worker.decrypt(parts.join(":"))).toBeNull();
  });

  test("rejects legacy CBC payloads by default", () => {
    const plaintext = JSON.stringify({ legacy: true });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", rootKey, iv);
    const ciphertext =
      cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
    const legacyEnvelope = `${ciphertext}:${iv.toString("hex")}`;

    expect(worker.decrypt(legacyEnvelope)).toBeNull();
    expect(worker.encrypt(plaintext)).toMatch(/^v2:/);
  });

  test("permits legacy CBC only during an explicit migration window", () => {
    process.env.ATHENA_COLLECTOR_LEGACY_PAYLOAD_DECRYPT = "true";
    const plaintext = JSON.stringify({ migrationOnly: true });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", rootKey, iv);
    const ciphertext =
      cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");

    expect(worker.decrypt(`${ciphertext}:${iv.toString("hex")}`)).toBe(
      plaintext
    );
  });

  test("rejects malformed key material", () => {
    expect(() => new EncryptionWorker("not-a-key")).toThrow(
      "collector_payload_key_invalid"
    );
  });
});
