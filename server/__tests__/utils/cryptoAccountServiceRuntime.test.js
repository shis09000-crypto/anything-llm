/* global jest, describe, beforeEach, test, expect */

const mockExecutionContext = jest.fn();
const mockUserGet = jest.fn();
const mockAuthorize = jest.fn();
const mockEligibility = jest.fn();
const mockResolve = jest.fn();
const mockRegistryGet = jest.fn();

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    toolInvocation: {
      executionContext: mockExecutionContext,
    },
    user: {
      get: mockUserGet,
    },
  },
}));
jest.mock("../../utils/plugins/capabilityBroker", () => ({
  authorizeInvocation: mockAuthorize,
}));
jest.mock("../../utils/cryptoAccount", () => ({
  accountCryptoHubRegistry: { get: mockRegistryGet },
  cryptoAccountEligibility: mockEligibility,
  resolveApprovedConnection: mockResolve,
}));

const {
  invokeAccountTool,
} = require("../../utils/cryptoAccount/serviceRuntime");

describe("crypto account isolated service runtime", () => {
  const context = {
    id: "tool-invocation-1",
    approvalRequestId: "approval-1",
    ownerUserId: 10,
    ownerAuthUserId: 20,
    toolName: "crypto_account_overview",
    scopeHash: "a".repeat(64),
    argumentHash: "b".repeat(64),
  };
  const manifest = {
    version: 1,
    approvalClass: "account-private-read",
    resultPolicy: "account-private/summary-only",
    scopeHash: "a".repeat(64),
    argumentHash: "b".repeat(64),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecutionContext.mockResolvedValue(context);
    mockAuthorize.mockResolvedValue({
      subject: "tool-invocation:tool-invocation-1",
    });
    mockUserGet.mockResolvedValue({ id: 10, authUserId: 20 });
    mockEligibility.mockResolvedValue({
      available: true,
      credentialVersion: 3,
      rootKeyId: "root-1",
      domainKeyVersion: 2,
    });
    mockResolve.mockResolvedValue({ connection: {}, credentials: {} });
    mockRegistryGet.mockReturnValue({
      toolOverview: jest.fn().mockResolvedValue({
        success: true,
        totalEquityUsd: "100.00",
      }),
    });
  });

  test("resolves the owner only from the durable invocation", async () => {
    const result = await invokeAccountTool({
      approvalRequestId: "approval-1",
      toolName: "crypto_account_overview",
      args: {},
      manifest,
      credential: "signed-capability",
      userId: 999,
    });

    expect(result).toEqual({
      success: true,
      totalEquityUsd: "100.00",
    });
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceIdentity: "crypto-account",
        requireHybrid: true,
      })
    );
    expect(mockUserGet).toHaveBeenCalledWith({ id: 10 });
    expect(mockResolve).toHaveBeenCalledWith({
      user: { id: 10, authUserId: 20 },
      expectedCredentialVersion: 3,
      expectedRootKeyId: "root-1",
      expectedDomainKeyVersion: 2,
    });
  });

  test("does not resolve credentials when capability verification fails", async () => {
    mockAuthorize.mockRejectedValueOnce(
      Object.assign(new Error("credential denied"), {
        code: "PLUGIN_CAPABILITY_CREDENTIAL_DENIED",
      })
    );

    await expect(
      invokeAccountTool({
        approvalRequestId: "approval-1",
        toolName: "crypto_account_overview",
        args: {},
        manifest,
        credential: "invalid",
      })
    ).rejects.toMatchObject({
      code: "PLUGIN_CAPABILITY_CREDENTIAL_DENIED",
    });
    expect(mockUserGet).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockRegistryGet).not.toHaveBeenCalled();
  });
});
