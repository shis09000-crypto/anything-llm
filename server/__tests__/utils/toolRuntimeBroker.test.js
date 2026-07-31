/* global jest, describe, beforeEach, test, expect */

const mockExecutionContext = jest.fn();
const mockIssueCredential = jest.fn();
const mockInternalRequest = jest.fn();
const mockBrowserPlaneDispatch = jest.fn();

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    toolInvocation: {
      executionContext: mockExecutionContext,
    },
  },
}));
jest.mock("../../utils/plugins/capabilityBroker", () => ({
  issueInvocationCredential: mockIssueCredential,
}));
jest.mock("../../utils/microModules/internalClient", () => ({
  requestInternalService: mockInternalRequest,
}));
jest.mock("../../utils/browserPlane/planeClient", () => ({
  dispatchBrowserPlane: mockBrowserPlaneDispatch,
}));

const {
  dispatchBrowser,
  dispatchCryptoAccount,
} = require("../../utils/toolRuntime/broker");

describe("tool runtime crypto account dispatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecutionContext.mockResolvedValue({
      id: "tool-invocation-1",
      approvalRequestId: "approval-1",
      ownerUserId: 10,
      ownerAuthUserId: 20,
      toolName: "crypto_account_overview",
      scopeHash: "a".repeat(64),
      argumentHash: "b".repeat(64),
    });
    mockIssueCredential.mockReturnValue("signed-capability");
    mockInternalRequest.mockResolvedValue({
      success: true,
      result: { success: true },
    });
  });

  test("derives identity from durable invocation and never forwards user ids", async () => {
    await expect(
      dispatchCryptoAccount({
        approvalRequestId: "approval-1",
        toolName: "crypto_account_overview",
        args: {},
        ownerUserId: 999,
        env: {
          ATHENA_CRYPTO_ACCOUNT_URL: "http://crypto-account.test",
          ATHENA_RUNTIME_TOPOLOGY: "local",
        },
      })
    ).resolves.toEqual({ success: true });

    expect(mockExecutionContext).toHaveBeenCalledWith({
      approvalRequestId: "approval-1",
      toolName: "crypto_account_overview",
      args: {},
      approvalClass: "account-private-read",
    });
    expect(mockIssueCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceIdentity: "crypto-account",
        requireHybrid: true,
      })
    );
    const forwarded = mockInternalRequest.mock.calls[0][0].body;
    expect(forwarded).toEqual(
      expect.objectContaining({
        approvalRequestId: "approval-1",
        toolName: "crypto_account_overview",
        credential: "signed-capability",
      })
    );
    expect(forwarded).not.toHaveProperty("ownerUserId");
    expect(forwarded).not.toHaveProperty("ownerAuthUserId");
    expect(forwarded).not.toHaveProperty("userId");
  });

  test("rejects tools outside the private account worker allowlist", async () => {
    await expect(
      dispatchCryptoAccount({
        approvalRequestId: "approval-1",
        toolName: "shell_exec",
        args: {},
      })
    ).rejects.toMatchObject({
      code: "tool_broker_crypto_account_tool_denied",
      httpStatus: 400,
    });
    expect(mockExecutionContext).not.toHaveBeenCalled();
    expect(mockInternalRequest).not.toHaveBeenCalled();
  });
});

describe("tool runtime browser dispatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecutionContext.mockResolvedValue({
      id: "browser-invocation-1",
      approvalRequestId: "browser-approval-1",
      approvalClass: "browser-automatic",
      ownerUserId: 10,
      workspaceId: 2,
      toolName: "browser_open",
    });
    mockBrowserPlaneDispatch
      .mockResolvedValueOnce({
        id: "browser-session-1",
        executionLocation: "cloud",
        status: "active",
      })
      .mockResolvedValueOnce({
        schemaVersion: "athena.browser.result.v1",
        status: "completed",
      });
  });

  test("derives browser ownership from the durable invocation context", async () => {
    await expect(
      dispatchBrowser({
        approvalRequestId: "browser-approval-1",
        toolName: "browser_open",
        args: {
          url: "https://example.com/path?secret=value",
          __policy: { mode: "sandbox" },
        },
        ownerUserId: 999,
      })
    ).resolves.toMatchObject({
      schemaVersion: "athena.browser.result.v1",
      status: "completed",
    });

    expect(mockBrowserPlaneDispatch.mock.calls[0]).toEqual([
      "createSession",
      expect.objectContaining({ userId: 10, location: "cloud" }),
    ]);
    expect(mockBrowserPlaneDispatch.mock.calls[1]).toEqual([
      "action",
      expect.objectContaining({
        userId: 10,
        sessionId: "browser-session-1",
        actorType: "agent",
        mode: "sandbox",
      }),
    ]);
  });

  test("rejects write execution without a durable Browser approval", async () => {
    mockExecutionContext.mockResolvedValueOnce({
      id: "browser-invocation-2",
      approvalRequestId: "browser-approval-2",
      approvalClass: "browser-automatic",
      ownerUserId: 10,
      toolName: "browser_interact",
    });

    await expect(
      dispatchBrowser({
        approvalRequestId: "browser-approval-2",
        toolName: "browser_interact",
        args: {
          sessionId: "browser-session-1",
          action: "input",
          arguments: { selector: "#message", value: "hello" },
          __policy: { mode: "sandbox" },
        },
      })
    ).rejects.toMatchObject({
      code: "browser_interaction_approval_missing",
      httpStatus: 403,
    });
    expect(mockBrowserPlaneDispatch).not.toHaveBeenCalled();
  });
});
