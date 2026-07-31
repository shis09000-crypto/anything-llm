/* global describe, beforeAll, afterAll, test, expect */

const {
  EnvironmentKeyProvider,
} = require("../../utils/security/keyCustody/providers");
const {
  resetKeyProviderForTests,
} = require("../../utils/security/keyCustody");
const {
  auditKeyDescriptor,
  signAuditCheckpoint,
  unwrapMaterial,
  wrapMaterial,
} = require("../../utils/security/keyCustody/serviceRuntime");
const {
  checkpointSigningPayload,
  ledgerCanonical,
} = require("../../utils/security/auditLedger")._internals;

describe("Key Custody isolated service runtime", () => {
  beforeAll(() => {
    resetKeyProviderForTests(
      new EnvironmentKeyProvider({
        env: {
          ENCRYPTION_MASTER_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      })
    );
  });

  afterAll(() => resetKeyProviderForTests());

  test("wraps and unwraps crypto account material without returning a key", () => {
    const caller = "spiffe://athena/production/crypto-account";
    const context = {
      purpose: "crypto-account-dek",
      domain: "crypto-account",
      resource: "crypto-connection-1",
    };
    const wrapped = wrapMaterial(
      { plaintext: Buffer.alloc(32, 7).toString("base64url"), context },
      { caller, env: { NODE_ENV: "production" } }
    );
    expect(wrapped).toMatchObject({
      version: "athena-key-custody-rpc:v1",
      wrapped: expect.stringMatching(/^enc:v2:/),
    });
    expect(wrapped).not.toHaveProperty("key");
    expect(wrapped).not.toHaveProperty("keyId");

    expect(
      unwrapMaterial(
        { wrapped: wrapped.wrapped, context },
        { caller, env: { NODE_ENV: "production" } }
      )
    ).toEqual({
      version: "athena-key-custody-rpc:v1",
      plaintext: Buffer.alloc(32, 7).toString("base64url"),
    });
  });

  test("rejects a purpose outside the caller allowlist", () => {
    expect(() =>
      wrapMaterial(
        {
          plaintext: "secret",
          context: { purpose: "chat-key-wraps", domain: "data" },
        },
        {
          caller: "spiffe://athena/production/crypto-account",
          env: { NODE_ENV: "production" },
        }
      )
    ).toThrow("key_custody_purpose_denied");
  });

  test("signs only canonical security-audit checkpoint payloads for the API", () => {
    const caller = "spiffe://athena/production/api";
    const context = {
      purpose: "security-audit-checkpoint",
      domain: "security-audit",
      resource: "security-v1:1",
    };
    const payload = Buffer.from(
      ledgerCanonical(
        checkpointSigningPayload({
          chainId: "security-v1",
          throughSequence: 1,
          throughHash: "a".repeat(64),
          policy: {
            threshold: 2,
            classicalRequired: true,
            pqRequired: true,
          },
        })
      )
    );
    const descriptor = auditKeyDescriptor(
      { context },
      { caller, env: { NODE_ENV: "production" } }
    );
    const signed = signAuditCheckpoint(
      { payloadBase64: payload.toString("base64"), context },
      { caller, env: { NODE_ENV: "production" } }
    );
    expect(descriptor.key).toMatchObject({
      keyId: signed.signature.keyId,
      publicKey: signed.signature.publicKey,
    });
    expect(signed.signature).toMatchObject({
      suiteId: "audit-ed25519-v1",
      postQuantum: false,
      signature: expect.any(String),
    });
    expect(signed).not.toHaveProperty("material");
    expect(signed.signature).not.toHaveProperty("privateKey");

    expect(() =>
      signAuditCheckpoint(
        { payloadBase64: Buffer.from("{}").toString("base64"), context },
        { caller, env: { NODE_ENV: "production" } }
      )
    ).toThrow("key_custody_audit_payload_invalid");
  });
});
