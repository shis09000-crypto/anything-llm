const {
  resetKeyProviderForTests,
} = require("../../../utils/security/keyCustody");
const {
  decryptEnvelope,
  encryptEnvelope,
  parseEnvelope,
} = require("../../../utils/security/keyRotation");
const {
  assertEncryptionWriteAllowed,
  resetSecurityStateForTests,
  setRotationWriteBarrier,
} = require("../../../utils/security/keyRuntimeState");

function descriptor(keyId, byte, status) {
  return {
    keyId,
    purpose: "server-data-at-rest",
    fingerprint: keyId.slice(-12),
    providerType: "test",
    status,
    material: Buffer.alloc(32, byte),
  };
}

describe("key rotation primitives", () => {
  const source = descriptor("sdk_source000001", 1, "active");
  const target = descriptor("sdk_target000002", 2, "pending");

  beforeEach(() => {
    resetSecurityStateForTests();
    resetKeyProviderForTests({
      resolveActiveKey: () => source,
      resolveKey: (keyId) =>
        [source, target].find((item) => item.keyId === keyId) || null,
      health: () => ({ ok: true, providerType: "test" }),
    });
  });

  afterEach(() => {
    resetSecurityStateForTests();
    resetKeyProviderForTests();
  });

  it("rewrites an envelope with target key identity and domain AAD", () => {
    const encrypted = encryptEnvelope(
      "rotation-payload",
      target,
      "account-memory"
    );

    expect(parseEnvelope(encrypted)).toMatchObject({
      version: "v2",
      keyId: target.keyId,
      purpose: "account-memory",
    });
    expect(decryptEnvelope(encrypted, source)).toMatchObject({
      plaintext: "rotation-payload",
      purpose: "account-memory",
      keyId: target.keyId,
    });
  });

  it("blocks encryption writes while the rotation barrier is active", () => {
    expect(assertEncryptionWriteAllowed()).toBe(true);
    setRotationWriteBarrier(true, "keyrot_test");
    expect(() => assertEncryptionWriteAllowed()).toThrow(
      "key_rotation_write_barrier"
    );
    setRotationWriteBarrier(false);
    expect(assertEncryptionWriteAllowed()).toBe(true);
  });
});
