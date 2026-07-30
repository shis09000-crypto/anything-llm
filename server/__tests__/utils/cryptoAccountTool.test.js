const mockUserGet = jest.fn();
const mockCryptoAccountEligibility = jest.fn();
const mockResolveApprovedConnection = jest.fn();
const mockRegistryGet = jest.fn();
const mockToolInvocationStart = jest.fn();
const mockToolInvocationComplete = jest.fn();
const mockToolInvocationFail = jest.fn();

jest.mock("../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: (name) =>
    name === "toolInvocation"
      ? {
          startExecution: mockToolInvocationStart,
          completeExecution: mockToolInvocationComplete,
          failExecution: mockToolInvocationFail,
        }
      : { get: mockUserGet },
}));
jest.mock("../../utils/cryptoAccount", () => ({
  cryptoAccountEligibility: mockCryptoAccountEligibility,
  resolveApprovedConnection: mockResolveApprovedConnection,
  accountCryptoHubRegistry: { get: mockRegistryGet },
}));
jest.mock("../../utils/observability/semanticEvents", () => ({
  emitSemanticEvent: jest.fn(),
}));

const {
  cryptoAccountOverview,
} = require("../../utils/agents/aibitat/plugins/crypto-account");

function setupTool(approval) {
  let definition = null;
  const aibitat = {
    handlerProps: {
      invocation: { user_id: 7, uuid: "invocation-test" },
      log: jest.fn(),
    },
    function: jest.fn((value) => {
      definition = value;
    }),
    requestToolApproval: jest.fn().mockResolvedValue(approval),
  };
  cryptoAccountOverview.plugin().setup(aibitat);
  return { aibitat, definition };
}

describe("crypto account approval boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserGet.mockResolvedValue({ id: 7, authUserId: 70 });
    mockCryptoAccountEligibility.mockResolvedValue({
      available: true,
      credentialVersion: 3,
      rootKeyId: "r".repeat(43),
      domainKeyVersion: 2,
    });
    mockToolInvocationStart.mockResolvedValue({ id: "tool-invocation" });
    mockToolInvocationComplete.mockResolvedValue(true);
    mockToolInvocationFail.mockResolvedValue(true);
  });

  test("does not resolve credentials or create a hub after denial", async () => {
    const { aibitat, definition } = setupTool({ approved: false });
    const result = JSON.parse(await definition.handler.call(definition, {}));
    expect(result.error).toBe("crypto_account_approval_denied");
    expect(aibitat.requestToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        forceApproval: true,
        allowAlwaysAllow: false,
        approvalClass: "account-private-read",
      })
    );
    expect(mockResolveApprovedConnection).not.toHaveBeenCalled();
    expect(mockRegistryGet).not.toHaveBeenCalled();
  });

  test("does not resolve credentials or create a hub after approval timeout", async () => {
    const { aibitat, definition } = setupTool({ approved: true });
    const timeout = new Error("tool_approval_timeout");
    timeout.code = "tool_approval_timeout";
    aibitat.requestToolApproval.mockRejectedValueOnce(timeout);

    const result = JSON.parse(await definition.handler.call(definition, {}));

    expect(result.error).toBe("tool_approval_timeout");
    expect(mockResolveApprovedConnection).not.toHaveBeenCalled();
    expect(mockRegistryGet).not.toHaveBeenCalled();
  });

  test("revalidates the binding after approval before reading", async () => {
    const toolOverview = jest.fn().mockResolvedValue({
      success: true,
      totalEquityUsd: "123.45",
    });
    mockResolveApprovedConnection.mockResolvedValue({
      connection: { id: "connection", authUserId: 70 },
      credentials: { apiKey: "key", apiSecret: "secret" },
    });
    mockRegistryGet.mockReturnValue({ toolOverview });
    const { definition } = setupTool({
      approved: true,
      requestId: "approval-test",
    });
    const result = JSON.parse(await definition.handler.call(definition, {}));
    expect(mockToolInvocationStart).toHaveBeenCalledWith({
      approvalRequestId: "approval-test",
      agentInvocationId: "invocation-test",
      toolName: "crypto_account_overview",
      scope: {
        approvalClass: "account-private-read",
        scope: "账户概览",
        exchange: "gate",
        environment: "production",
      },
      args: {},
    });
    expect(mockResolveApprovedConnection).toHaveBeenCalledWith({
      user: { id: 7, authUserId: 70 },
      expectedCredentialVersion: 3,
      expectedRootKeyId: "r".repeat(43),
      expectedDomainKeyVersion: 2,
    });
    expect(toolOverview).toHaveBeenCalledTimes(1);
    expect(mockToolInvocationComplete).toHaveBeenCalledWith({
      approvalRequestId: "approval-test",
      result: {
        success: true,
        totalEquityUsd: "123.45",
      },
    });
    expect(result.success).toBe(true);
  });

  test("fails closed when approval is not bound to a durable invocation", async () => {
    const { definition } = setupTool({ approved: true });
    const result = JSON.parse(await definition.handler.call(definition, {}));

    expect(result.error).toBe("crypto_account_approval_binding_missing");
    expect(mockResolveApprovedConnection).not.toHaveBeenCalled();
    expect(mockToolInvocationStart).not.toHaveBeenCalled();
  });
});
