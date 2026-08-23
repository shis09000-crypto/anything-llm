/* global describe, beforeAll, afterAll, test, expect */

const crypto = require("crypto");

const {
  EnvironmentKeyProvider,
} = require("../../utils/security/keyCustody/providers");
const { resetKeyProviderForTests } = require("../../utils/security/keyCustody");
const {
  auditKeyDescriptor,
  mcpAccessTokenDescriptor,
  signAuditCheckpoint,
  signMcpAccessToken,
  unwrapMaterial,
  wrapMaterial,
} = require("../../utils/security/keyCustody/serviceRuntime");
const { checkpointSigningPayload, ledgerCanonical } =
  require("../../utils/security/auditLedger")._internals;

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

  test("unwraps a valid envelope whose base64 expansion exceeds 64 KiB", () => {
    const caller = "spiffe://athena/production/responses-runtime";
    const context = {
      purpose: "responses-state",
      domain: "responses-runtime",
      resource: "large-checkpoint:0",
    };
    const plaintext = Buffer.alloc(36 * 1024, 7).toString("base64");
    const wrapped = wrapMaterial(
      { plaintext, context },
      { caller, env: { NODE_ENV: "production" } }
    );

    expect(Buffer.byteLength(wrapped.wrapped, "utf8")).toBeGreaterThan(
      64 * 1024
    );
    expect(
      unwrapMaterial(
        { wrapped: wrapped.wrapped, context },
        { caller, env: { NODE_ENV: "production" } }
      )
    ).toEqual({
      version: "athena-key-custody-rpc:v1",
      plaintext,
    });
  });

  test("allows Agent Runtime to use the governed chat conversation key", () => {
    const caller = "spiffe://athena/production/agent-runtime";
    const context = {
      purpose: "chat-conversation-key",
      domain: "chat-history",
      resource: "workspace-1:thread-1",
    };
    const wrapped = wrapMaterial(
      { plaintext: "agent-conversation-key", context },
      { caller, env: { NODE_ENV: "production" } }
    );

    expect(
      unwrapMaterial(
        { wrapped: wrapped.wrapped, context },
        { caller, env: { NODE_ENV: "production" } }
      ).plaintext
    ).toBe("agent-conversation-key");
  });

  test("isolates Agent durable events in the Agent key domain", () => {
    const caller = "spiffe://athena/production/agent-runtime";
    const context = {
      purpose: "agent-run-event",
      domain: "agent",
      resource: "agent-run:invocation-1",
    };
    const wrapped = wrapMaterial(
      { plaintext: "durable-event", context },
      { caller, env: { NODE_ENV: "production" } }
    );

    expect(
      unwrapMaterial(
        { wrapped: wrapped.wrapped, context },
        { caller, env: { NODE_ENV: "production" } }
      ).plaintext
    ).toBe("durable-event");
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

  test("signs bounded MCP access tokens for Identity without exposing the private key", () => {
    const caller = "spiffe://athena/production/identity";
    const context = {
      purpose: "mcp-access-token",
      domain: "external-mcp-oauth",
      resource: "athena-external-mcp",
      operation: "token-signature",
    };
    const descriptor = mcpAccessTokenDescriptor(
      { context },
      { caller, env: { NODE_ENV: "production" } }
    );
    const now = Math.floor(Date.now() / 1000);
    const encode = (value) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const signingInput = `${encode({
      alg: "EdDSA",
      typ: "at+jwt",
      kid: descriptor.key.keyId,
    })}.${encode({
      typ: "athena-mcp-access",
      iss: "https://athena.example.com",
      aud: "athena-external-mcp",
      sub: "service:1",
      client_id: "client-1",
      grant_id: "grant-1",
      grant_version: 1,
      scope: "workspace:list",
      iat: now,
      exp: now + 600,
    })}`;
    const signed = signMcpAccessToken(
      { keyId: descriptor.key.keyId, signingInput, context },
      { caller, env: { NODE_ENV: "production" } }
    );
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(descriptor.key.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      crypto.verify(
        null,
        Buffer.from(signingInput, "utf8"),
        publicKey,
        Buffer.from(signed.signature, "base64url")
      )
    ).toBe(true);
    expect(signed).not.toHaveProperty("privateKey");
    expect(descriptor.key).not.toHaveProperty("privateKey");
  });

  test.each([
    ["api", "secret-store"],
    ["api", "chat-conversation-key"],
    ["chat-runtime", "secret-store"],
    ["chat-runtime", "chat-conversation-key"],
    ["identity", "user-state:chat-draft"],
  ])("authorizes %s for owned application purpose %s", (role, purpose) => {
    const caller = `spiffe://athena/production/${role}`;
    const context = { purpose, domain: "data" };
    const wrapped = wrapMaterial(
      { plaintext: "owned material", context },
      { caller, env: { NODE_ENV: "production" } }
    );
    expect(
      unwrapMaterial(
        { wrapped: wrapped.wrapped, context },
        { caller, env: { NODE_ENV: "production" } }
      ).plaintext
    ).toBe("owned material");
  });

  test.each(["api", "identity"])(
    "signs only canonical security-audit checkpoint payloads for %s",
    (callerRole) => {
      const caller = `spiffe://athena/production/${callerRole}`;
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
        {
          caller,
          env: {
            NODE_ENV: "production",
            ATHENA_AUDIT_HYBRID_SIGNATURES: "off",
          },
        }
      );
      const signed = signAuditCheckpoint(
        { payloadBase64: payload.toString("base64"), context },
        {
          caller,
          env: {
            NODE_ENV: "production",
            ATHENA_AUDIT_HYBRID_SIGNATURES: "off",
          },
        }
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
      expect(signed.signatures).toEqual([
        expect.objectContaining({
          suiteId: "audit-ed25519-v1",
          postQuantum: false,
        }),
      ]);
      expect(signed).not.toHaveProperty("material");
      expect(signed.signature).not.toHaveProperty("privateKey");

      expect(() =>
        signAuditCheckpoint(
          { payloadBase64: Buffer.from("{}").toString("base64"), context },
          {
            caller,
            env: {
              NODE_ENV: "production",
              ATHENA_AUDIT_HYBRID_SIGNATURES: "off",
            },
          }
        )
      ).toThrow("key_custody_audit_payload_invalid");
    }
  );
});
