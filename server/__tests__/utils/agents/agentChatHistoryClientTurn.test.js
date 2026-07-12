const mockWorkspaceGet = jest.fn();
const mockThreadGet = jest.fn();
const mockChatUpsert = jest.fn();
const mockPublishWorkspaceSyncEvent = jest.fn();

jest.mock("../../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: (name) => {
    if (name === "workspace")
      return { get: (...args) => mockWorkspaceGet(...args) };
    if (name === "workspaceThread")
      return { get: (...args) => mockThreadGet(...args) };
    if (name === "workspaceChat")
      return { upsert: (...args) => mockChatUpsert(...args) };
    throw new Error(`Unexpected facade: ${name}`);
  },
}));
jest.mock("../../../utils/chats/threadTitleGeneration", () => ({
  maybeEnqueueTitleGenerationAfterChat: jest.fn(),
}));
jest.mock("../../../utils/chats/workspaceSyncEvents", () => ({
  publishWorkspaceSyncEvent: (...args) =>
    mockPublishWorkspaceSyncEvent(...args),
}));
jest.mock("../../../utils/agents/toolResultStore", () => ({
  sanitizeAgentEvent: (event) => event,
}));
jest.mock("../../../utils/chats/displayPrompt", () => ({
  promptForHistory: ({ message }) => message,
}));

describe("Agent chat history client turn propagation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkspaceGet.mockResolvedValue({ id: 4, slug: "alpha" });
    mockThreadGet.mockResolvedValue({ id: 11, slug: "thread-a" });
    mockChatUpsert.mockResolvedValue({ chat: { id: 22 }, message: null });
  });

  it("stores and broadcasts the invocation client turn with the final chat", async () => {
    const {
      chatHistory,
    } = require("../../../utils/agents/aibitat/plugins/chat-history");
    const plugin = chatHistory.plugin.call(chatHistory);
    const aibitat = {
      handlerProps: {
        invocation: {
          uuid: "invocation-1",
          workspace_id: 4,
          user_id: 7,
          thread_id: 11,
          clientTurnId: "turn-agent-1",
        },
      },
      trackedChatId: 22,
      trackedPublicChatId: "public-22",
      provider: { getUsage: () => ({}) },
      _threadRenamed: true,
      _pendingCitations: [],
      _pendingOutputs: [],
      _pendingClarifyingQuestionSurveys: [],
      _agentEvents: [],
      clearCitations: jest.fn(),
      clearClarifyingQuestionSurveys: jest.fn(),
      clearTrackedChatId: jest.fn(),
    };

    await plugin._store(aibitat, {
      prompt: "question",
      response: "answer",
    });

    expect(mockChatUpsert).toHaveBeenCalledWith(
      22,
      expect.objectContaining({ clientTurnId: "turn-agent-1" })
    );
    expect(mockPublishWorkspaceSyncEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat_finalized",
        chatId: 22,
        publicChatId: "public-22",
        clientTurnId: "turn-agent-1",
      })
    );
  });
});
