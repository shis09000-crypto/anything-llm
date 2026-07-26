const crypto = require("crypto");
const {
  USER_DOMAIN_WRAP_ALGORITHM,
  USER_DOMAIN_WRAP_VERSION,
  XWING_CIPHERTEXT_BYTES,
  XWING_PUBLIC_KEY_BYTES,
  encapsulateXWing,
  userDomainWrapAAD,
  validateUserDomainWrapEnvelope,
} = require("../../../utils/security/userDomainWrapping");

const XWING_LABEL = Buffer.from("5c2e2f2f5e5c", "hex");

function rawPublic(key, bytes) {
  return Buffer.from(key.export({ format: "der", type: "spki" })).subarray(
    -bytes
  );
}

describe("user domain wrapping", () => {
  test("encapsulates Node 24 X-Wing material with the Apple-compatible combiner", () => {
    if (
      Number(process.versions.node.split(".")[0]) !== 24 ||
      typeof crypto.encapsulate !== "function"
    )
      return;
    const mlKem = crypto.generateKeyPairSync("ml-kem-768");
    const x25519 = crypto.generateKeyPairSync("x25519");
    const mlKemPublic = rawPublic(
      mlKem.publicKey,
      1184
    );
    const x25519Public = rawPublic(
      x25519.publicKey,
      32
    );
    const publicKey = Buffer.concat([mlKemPublic, x25519Public]);
    expect(publicKey).toHaveLength(XWING_PUBLIC_KEY_BYTES);

    const encapsulation = encapsulateXWing(publicKey);
    expect(encapsulation.encapsulatedKey).toHaveLength(
      XWING_CIPHERTEXT_BYTES
    );
    const mlKemCiphertext = encapsulation.encapsulatedKey.subarray(0, 1088);
    const ephemeralPublic = encapsulation.encapsulatedKey.subarray(1088);
    const mlKemShared = crypto.decapsulate(
      mlKem.privateKey,
      mlKemCiphertext
    );
    const ephemeralSpki = Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"),
      ephemeralPublic,
    ]);
    const x25519Shared = crypto.diffieHellman({
      privateKey: x25519.privateKey,
      publicKey: crypto.createPublicKey({
        key: ephemeralSpki,
        format: "der",
        type: "spki",
      }),
    });
    const expected = crypto
      .createHash("sha3-256")
      .update(
        Buffer.concat([
          Buffer.from(mlKemShared),
          x25519Shared,
          ephemeralPublic,
          x25519Public,
          XWING_LABEL,
        ])
      )
      .digest();
    expect(encapsulation.sharedKey.equals(expected)).toBe(true);
  });

  test("binds wrap metadata and required version fields", () => {
    const metadata = {
      authUserId: 9,
      rootKeyId: Buffer.alloc(32, 7).toString("base64url"),
      rootEpoch: 2,
      domainKeyVersion: 1,
      domain: "data",
      resourceType: "chat-conversation-key",
      resourceId: "ck_123",
    };
    const envelope = {
      version: USER_DOMAIN_WRAP_VERSION,
      algorithm: USER_DOMAIN_WRAP_ALGORITHM,
      ...metadata,
      iv: Buffer.alloc(12, 1).toString("base64url"),
      authTag: Buffer.alloc(16, 2).toString("base64url"),
      ciphertext: Buffer.alloc(32, 3).toString("base64url"),
      keyCommitment: Buffer.alloc(32, 4).toString("base64url"),
    };
    expect(
      validateUserDomainWrapEnvelope(envelope, metadata)
    ).toMatchObject(metadata);
    expect(userDomainWrapAAD(metadata).toString("utf8")).toContain(
      '"resourceId":"ck_123"'
    );
    expect(() =>
      validateUserDomainWrapEnvelope(
        { ...envelope, domainKeyVersion: 2 },
        metadata
      )
    ).toThrow("user_domain_wrap_envelope_invalid");
  });
});
