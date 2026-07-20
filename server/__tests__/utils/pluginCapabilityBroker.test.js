/* eslint-env jest */

const {
  authorizeInvocation,
  issueInvocationCredential,
  resetCapabilityBrokerForTests,
} = require("../../utils/plugins/capabilityBroker");

describe("plugin capability broker", () => {
  const keyDescriptor = {
    keyId: "test-key",
    material: Buffer.alloc(32, 7),
  };
  const request = {
    serviceIdentity: "plugin:test",
    tool: "read_document",
    args: { documentId: 42 },
    manifest: { tools: ["read_document"] },
    keyDescriptor,
  };

  beforeEach(() => resetCapabilityBrokerForTests());

  test("authorizes a short-lived credential once", () => {
    const credential = issueInvocationCredential(request);
    expect(
      authorizeInvocation({ ...request, credential })
    ).toMatchObject({ audience: "plugin:test", tool: "read_document" });
    expect(() => authorizeInvocation({ ...request, credential })).toThrow(
      expect.objectContaining({
        code: "PLUGIN_CAPABILITY_CREDENTIAL_DENIED",
        reason: "replayed",
      })
    );
  });

  test("binds the credential to arguments and capability manifest", () => {
    const credential = issueInvocationCredential(request);
    expect(() =>
      authorizeInvocation({
        ...request,
        credential,
        args: { documentId: 43 },
      })
    ).toThrow(
      expect.objectContaining({ code: "PLUGIN_CAPABILITY_CREDENTIAL_DENIED" })
    );
  });

  test("rejects expired credentials", () => {
    const now = Date.now();
    const credential = issueInvocationCredential({
      ...request,
      now,
      ttlMs: 1_000,
    });
    expect(() =>
      authorizeInvocation({ ...request, credential, now: now + 1_001 })
    ).toThrow(
      expect.objectContaining({
        code: "PLUGIN_CAPABILITY_CREDENTIAL_DENIED",
        reason: "expired",
      })
    );
  });
});
