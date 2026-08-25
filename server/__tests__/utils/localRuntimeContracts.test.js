const crypto = require("crypto");
const {
  deviceSignaturePayload,
  pairingSignaturePayload,
  publicDevice,
  sha256,
  stableJson,
} = require("../../utils/localRuntime/contracts");
const {
  issueCapabilityAssertion,
  verifyCapabilityAssertion,
} = require("../../utils/localRuntime/capabilityAssertion");

describe("Local Runtime contracts", () => {
  test("stable JSON and hashes do not depend on key insertion order", () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}'
    );
    expect(sha256({ a: 1, b: 2 })).toBe(sha256({ b: 2, a: 1 }));
  });

  test("device signature payload verifies with the paired P-256 key", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const message = {
      deviceId: "device-1",
      timestamp: Date.now(),
      nonce: "nonce",
      connectionId: "connection",
    };
    const signature = crypto.sign(
      "sha256",
      Buffer.from(deviceSignaturePayload(message)),
      privateKey
    );
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(deviceSignaturePayload(message)),
        publicKey,
        signature
      )
    ).toBe(true);
  });

  test("pairing proof binds the ticket and offered public key", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const message = {
      pairingToken: "lrp_once",
      publicKeyPem,
      timestamp: Date.now(),
      nonce: "nonce",
      connectionId: "connection",
    };
    const signature = crypto.sign(
      "sha256",
      Buffer.from(pairingSignaturePayload(message)),
      privateKey
    );
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(pairingSignaturePayload(message)),
        publicKey,
        signature
      )
    ).toBe(true);
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(
          pairingSignaturePayload({ ...message, pairingToken: "other" })
        ),
        publicKey,
        signature
      )
    ).toBe(false);
  });

  test("capability assertions are Ed25519 signed and bound", () => {
    const env = {
      NODE_ENV: "test",
      ATHENA_LOCAL_RUNTIME_SIGNING_KEY_ID: "test",
    };
    const assertion = issueCapabilityAssertion(
      { jobId: "job", argumentHash: "abc" },
      { env }
    );
    const {
      signingKeys,
    } = require("../../utils/localRuntime/capabilityAssertion");
    expect(
      verifyCapabilityAssertion(assertion, signingKeys(env).publicKey)
    ).toBe(true);
    assertion.payload.argumentHash = "changed";
    expect(
      verifyCapabilityAssertion(assertion, signingKeys(env).publicKey)
    ).toBe(false);
  });

  test("public device status respects live connection override", () => {
    const row = {
      id: "d",
      name: "Mac",
      platform: "macos",
      version: "1",
      status: "offline",
      capabilitiesJson: "{}",
      permissionsJson: "{}",
      pairedAt: new Date(),
      lastSeenAt: null,
      revokedAt: null,
    };
    expect(publicDevice(row, { online: true }).status).toBe("online");
  });
});
