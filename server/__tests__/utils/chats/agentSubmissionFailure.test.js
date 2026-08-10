const mockInvocationNew = jest.fn();

jest.mock("../../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: (name) => {
    if (name === "workspace")
      return { supportsNativeToolCalling: jest.fn(async () => true) };
    if (name === "workspaceAgentInvocation")
      return {
        parseAgents: jest.fn(() => []),
        new: (...args) => mockInvocationNew(...args),
      };
    return {};
  },
}));
jest.mock("../../../utils/agents/invocationClient", () => ({
  createRemoteAgentInvocation: jest.fn(),
  remoteAgentInvocationEnabled: jest.fn(() => false),
}));
jest.mock("../../../utils/helpers/chat/responses", () => ({
  writeResponseChunk: (response, payload) => response.chunks.push(payload),
}));
jest.mock("../../../utils/observability/operationContext", () => ({
  enrichOperationContext: jest.fn(),
}));

const { grepAgents } = require("../../../utils/chats/agents");

describe("Agent submission failure semantics", () => {
  beforeEach(() => jest.clearAllMocks());

  test("closes with a retryable Agent error instead of falling back to chat", async () => {
    mockInvocationNew.mockResolvedValue({
      invocation: null,
      message: "agent_invocation_store_unavailable",
    });
    const response = { chunks: [] };
    await expect(
      grepAgents({
        uuid: "turn-1",
        response,
        message: "检索工作区资料",
        workspace: { id: 4, chatMode: "automatic" },
        user: { id: 7 },
        thread: { id: 11 },
        clientTurnId: "client-turn-1",
      })
    ).resolves.toBe(true);
    expect(response.chunks).toEqual([
      expect.objectContaining({
        type: "abort",
        close: true,
        error: "agent_invocation_store_unavailable",
      }),
    ]);
    expect(
      response.chunks.some((chunk) =>
        String(chunk.textResponse || "").includes("default chat")
      )
    ).toBe(false);
  });
});
