const mockSupportsNativeToolCalling = jest.fn();
const mockParseAgents = jest.fn();
const mockCreateRemoteAgentInvocation = jest.fn();

jest.mock("../../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: (name) => {
    if (name === "workspace")
      return { supportsNativeToolCalling: mockSupportsNativeToolCalling };
    if (name === "workspaceAgentInvocation")
      return { parseAgents: mockParseAgents, new: jest.fn() };
    return {};
  },
}));

jest.mock("../../../utils/agents/invocationClient", () => ({
  createRemoteAgentInvocation: mockCreateRemoteAgentInvocation,
  remoteAgentInvocationEnabled: jest.fn(() => true),
}));

jest.mock("../../../utils/helpers/chat/responses", () => ({
  writeResponseChunk: jest.fn(),
}));

jest.mock("../../../utils/observability/operationContext", () => ({
  enrichOperationContext: jest.fn(),
}));

const { grepAgents } = require("../../../utils/chats/agents");

describe("grepAgents automatic routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParseAgents.mockReturnValue([]);
    mockSupportsNativeToolCalling.mockResolvedValue(true);
  });

  it("keeps a greeting on normal chat without probing tool support", async () => {
    await expect(
      grepAgents({
        uuid: "turn-1",
        response: {},
        message: "哈咯",
        workspace: { chatMode: "automatic" },
      })
    ).resolves.toBe(false);

    expect(mockSupportsNativeToolCalling).not.toHaveBeenCalled();
    expect(mockCreateRemoteAgentInvocation).not.toHaveBeenCalled();
  });

  it("preserves automatic agent routing for an actionable request", async () => {
    mockCreateRemoteAgentInvocation.mockResolvedValue({
      invocation: { uuid: "agent-1" },
    });

    await expect(
      grepAgents({
        uuid: "turn-2",
        response: {},
        message: "帮我搜索一下今天的新闻",
        workspace: { chatMode: "automatic" },
      })
    ).resolves.toBe(true);

    expect(mockSupportsNativeToolCalling).toHaveBeenCalledTimes(1);
    expect(mockCreateRemoteAgentInvocation).toHaveBeenCalledTimes(1);
  });
});
