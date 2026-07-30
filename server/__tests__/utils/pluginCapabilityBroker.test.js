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

  test("authorizes a short-lived credential once", async () => {
    const credential = issueInvocationCredential(request);
    expect(await authorizeInvocation({ ...request, credential })).toMatchObject(
      { audience: "plugin:test", tool: "read_document" }
    );
    await expect(
      authorizeInvocation({ ...request, credential })
    ).rejects.toMatchObject({
      code: "PLUGIN_CAPABILITY_CREDENTIAL_DENIED",
      reason: "replayed",
    });
  });

  test("binds the credential to arguments and capability manifest", async () => {
    const credential = issueInvocationCredential(request);
    await expect(
      authorizeInvocation({
        ...request,
        credential,
        args: { documentId: 43 },
      })
    ).rejects.toMatchObject({ code: "PLUGIN_CAPABILITY_CREDENTIAL_DENIED" });
  });

  test("rejects expired credentials", async () => {
    const now = Date.now();
    const credential = issueInvocationCredential({
      ...request,
      now,
      ttlMs: 1_000,
    });
    await expect(
      authorizeInvocation({ ...request, credential, now: now + 1_001 })
    ).rejects.toMatchObject({
      code: "PLUGIN_CAPABILITY_CREDENTIAL_DENIED",
      reason: "expired",
    });
  });
});
