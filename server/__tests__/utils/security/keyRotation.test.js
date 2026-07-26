const {
  resetKeyProviderForTests,
} = require("../../../utils/security/keyCustody");
const {
  decryptEnvelope,
  encryptedTreeMutation,
  encryptEnvelope,
  envFileMutation,
  parseEnvelope,
  wrapperMutation,
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

  it("rewraps nested provider backup secrets without changing plain values", () => {
    const encrypted = encryptEnvelope(
      "provider-secret",
      source,
      "provider-settings-backup"
    );
    const mutation = encryptedTreeMutation({
      value: {
        version: 1,
        values: { API_KEY: encrypted, MODEL: "plain-model" },
      },
      source,
      target,
      defaultPurpose: "provider-settings-backup",
    });

    expect(mutation.changed).toBe(1);
    expect(mutation.value.values.MODEL).toBe("plain-model");
    expect(parseEnvelope(mutation.value.values.API_KEY).keyId).toBe(
      target.keyId
    );
    expect(decryptEnvelope(mutation.value.values.API_KEY, source).plaintext).toBe(
      "provider-secret"
    );
  });

  it("rewraps encrypted managed-env values without rewriting plain settings", () => {
    const encrypted = encryptEnvelope(
      "managed-secret",
      source,
      "managed-environment-secret"
    );
    const next = envFileMutation({
      content: `PLAIN_SETTING='preserved'\nSECRET_SETTING='${encrypted}'\n`,
      source,
      target,
    });
    const parsed = require("dotenv").parse(next);

    expect(parsed.PLAIN_SETTING).toBe("preserved");
    expect(parseEnvelope(parsed.SECRET_SETTING).keyId).toBe(target.keyId);
    expect(decryptEnvelope(parsed.SECRET_SETTING, source).plaintext).toBe(
      "managed-secret"
    );
  });

  it("rewraps nested document payload envelopes", () => {
    const encrypted = encryptEnvelope(
      JSON.stringify({ domain: "document-store", value: "document" }),
      source,
      "document-store"
    );
    const mutation = wrapperMutation({
      value: {
        version: 1,
        payload: { encryptedPayload: encrypted, metadata: "preserved" },
      },
      source,
      target,
      defaultPurpose: "document-store",
    });

    expect(mutation.payload.metadata).toBe("preserved");
    expect(parseEnvelope(mutation.payload.encryptedPayload).keyId).toBe(
      target.keyId
    );
  });
});
