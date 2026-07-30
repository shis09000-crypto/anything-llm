/* global jest, describe, beforeEach, test, expect */

const mockSignCapabilityEnvelope = jest.fn();
const mockVerifyCapabilityEnvelope = jest.fn();

jest.mock("../../utils/security/pluginCapabilityHybrid", () => ({
  signCapabilityEnvelope: mockSignCapabilityEnvelope,
  verifyCapabilityEnvelope: mockVerifyCapabilityEnvelope,
}));

const {
  authorizeInvocation,
  issueInvocationCredential,
  resetCapabilityBrokerForTests,
} = require("../../utils/plugins/capabilityBroker");

describe("hybrid plugin capability broker", () => {
  const request = {
    serviceIdentity: "crypto-account",
    tool: "crypto_account_overview",
    args: {},
    manifest: {
      approvalClass: "account-private-read",
      resultPolicy: "account-private/summary-only",
    },
    subject: "tool-invocation:invocation-1",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetCapabilityBrokerForTests();
    mockSignCapabilityEnvelope.mockReturnValue({
      format: "athena-hybrid-signature:v1",
      policy: {
        threshold: 2,
        classicalRequired: true,
        pqRequired: true,
      },
      signatures: [
        { suiteId: "plugin-capability-ed25519-v2" },
        { suiteId: "plugin-capability-mldsa65-v2" },
      ],
    });
    mockVerifyCapabilityEnvelope.mockReturnValue({
      valid: true,
      validSignatures: 2,
      findings: [],
    });
  });

  test("issues and consumes a hybrid private-account capability once", async () => {
    const credential = issueInvocationCredential({
      ...request,
      requireHybrid: true,
    });

    expect(credential.startsWith("pc2.")).toBe(true);
    expect(mockSignCapabilityEnvelope).toHaveBeenCalledTimes(1);
    await expect(
      authorizeInvocation({
        ...request,
        credential,
        requireHybrid: true,
      })
    ).resolves.toMatchObject({
      version: "athena-plugin-capability:v2",
      audience: "crypto-account",
      subject: "tool-invocation:invocation-1",
    });
    await expect(
      authorizeInvocation({
        ...request,
        credential,
        requireHybrid: true,
      })
    ).rejects.toMatchObject({
      code: "PLUGIN_CAPABILITY_CREDENTIAL_DENIED",
      reason: "replayed",
    });
  });

  test("rejects a legacy HMAC credential when hybrid protection is required", async () => {
    const credential = issueInvocationCredential({
      ...request,
      keyDescriptor: {
        keyId: "legacy-test-key",
        material: Buffer.alloc(32, 9),
      },
    });

    await expect(
      authorizeInvocation({
        ...request,
        credential,
        keyDescriptor: {
          keyId: "legacy-test-key",
          material: Buffer.alloc(32, 9),
        },
        requireHybrid: true,
      })
    ).rejects.toMatchObject({
      code: "PLUGIN_CAPABILITY_CREDENTIAL_DENIED",
      reason: "hybrid_required",
    });
    expect(mockVerifyCapabilityEnvelope).not.toHaveBeenCalled();
  });

  test("rejects a hybrid envelope missing either signature family", async () => {
    const credential = issueInvocationCredential({
      ...request,
      requireHybrid: true,
    });
    mockVerifyCapabilityEnvelope.mockReturnValueOnce({
      valid: false,
      validSignatures: 1,
      findings: ["hybrid_pq_component_missing"],
    });

    await expect(
      authorizeInvocation({
        ...request,
        credential,
        requireHybrid: true,
      })
    ).rejects.toMatchObject({
      code: "PLUGIN_CAPABILITY_CREDENTIAL_DENIED",
      reason: expect.stringContaining("hybrid_pq_component_missing"),
    });
  });
});
