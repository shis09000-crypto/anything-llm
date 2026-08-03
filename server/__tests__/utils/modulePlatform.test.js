/* eslint-env jest */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createEventEnvelope,
  issuePrincipalAssertion,
  loadManifests,
  validateEventEnvelope,
  verifyPrincipalAssertion,
} = require("../../utils/modulePlatform");
const {
  PURPOSES,
  SUITE_IDS,
} = require("../../utils/security/cryptoSuiteRegistry");
const { loadKeyDescriptor } = require("../../utils/security/hybridSignature");

describe("micro-module platform contracts", () => {
  test("loads a complete, uniquely identified module catalog", () => {
    const manifests = loadManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(20);
    expect(new Set(manifests.map((entry) => entry.id)).size).toBe(
      manifests.length
    );
    expect(
      manifests.find((entry) => entry.id === "crypto-account-access")
    ).toMatchObject({
      runtimeRole: "crypto-account",
      security: expect.objectContaining({
        failureMode: "isolated-degraded",
      }),
    });
  });

  test("ignores hidden filesystem metadata next to signed manifests", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "athena-manifests-")
    );
    try {
      const source = path.resolve(__dirname, "../../module-manifests");
      fs.cpSync(source, directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "._browser-egress.json"), "junk");
      expect(loadManifests({ directory })).toHaveLength(25);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("caches the immutable manifest catalog for production callers", () => {
    const first = loadManifests({ cache: true, refresh: true });
    const second = loadManifests({ cache: true });

    expect(second).toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
  });

  test("creates a hashed metadata-only event envelope", () => {
    const envelope = createEventEnvelope({
      eventType: "chat.run.completed",
      producer: "chat-runtime",
      correlationId: "operation-1",
      subject: { type: "chat-run", id: "run-1" },
      payload: { status: "completed", durationMs: 42 },
    });
    expect(validateEventEnvelope(envelope)).toEqual({
      valid: true,
      findings: [],
    });
    expect(envelope.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects private account and credential fields from event payloads", () => {
    expect(() =>
      createEventEnvelope({
        eventType: "crypto.account.read.completed",
        producer: "crypto-account-access",
        correlationId: "operation-2",
        subject: { type: "tool-invocation", id: "invocation-1" },
        payload: { status: "completed", accountBalance: "private" },
      })
    ).toThrow("event_envelope_invalid");
  });

  test("audience-binds short-lived principal assertions", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const signer = loadKeyDescriptor({
      suiteId: SUITE_IDS.AUDIT_ED25519_V1,
      purpose: PURPOSES.SECURITY_AUDIT_CHECKPOINT,
      keyId: "identity-classical-test",
      privateKey,
      publicKey,
      keyOrigin: "test",
      hardwareProtection: "test",
    });
    const assertion = issuePrincipalAssertion({
      issuer: "authentication",
      audience: "chat-runtime",
      authUserId: "auth-user-1",
      userId: 10,
      sessionId: "session-1",
      clientId: "client-1",
      trustLevel: "high",
      scopes: ["chat:write"],
      requestHash: "a".repeat(64),
      correlationId: "operation-3",
      signers: [signer],
      policy: {
        threshold: 1,
        classicalRequired: true,
        pqRequired: false,
      },
    });
    const trustedKeys = assertion.signature.signatures.map((signature) => ({
      keyId: signature.keyId,
      suiteId: signature.suiteId,
      publicKey: signature.publicKey,
    }));
    expect(
      verifyPrincipalAssertion(assertion, {
        audience: "chat-runtime",
        trustedKeys,
        requireHybrid: false,
      })
    ).toMatchObject({ valid: true });
    expect(
      verifyPrincipalAssertion(assertion, {
        audience: "tool-runtime",
        trustedKeys,
        requireHybrid: false,
      })
    ).toMatchObject({
      valid: false,
      findings: expect.arrayContaining(["audience_invalid"]),
    });
  });
});
