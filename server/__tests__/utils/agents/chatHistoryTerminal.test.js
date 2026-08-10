const mocks = {
  workspaceChat: {
    upsert: jest.fn(),
  },
  workspace: {
    get: jest.fn().mockResolvedValue({ id: 4, slug: "workspace" }),
  },
  workspaceThread: {
    get: jest.fn(),
  },
};

jest.mock("../../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: (name) => mocks[name],
}));
jest.mock("../../../utils/chats/threadTitleGeneration", () => ({
  maybeEnqueueTitleGenerationAfterChat: jest.fn(),
}));
jest.mock("../../../utils/chats/workspaceSyncEvents", () => ({
  publishWorkspaceSyncEvent: jest.fn(),
}));

const {
  chatHistory,
} = require("../../../utils/agents/aibitat/plugins/chat-history");

describe("agent chat-history terminal lifecycle", () => {
  beforeEach(() => jest.clearAllMocks());

  test("ends the visible invocation while final persistence continues", async () => {
    const plugin = chatHistory.plugin();
    const aibitat = {
      handlerProps: {
        invocation: {
          uuid: "invocation-1",
          workspace_id: 4,
          user_id: 7,
          thread_id: null,
          clientTurnId: "turn-1",
        },
      },
      provider: { getUsage: () => ({ model: "deepseek-v4-flash" }) },
      trackedChatId: 42,
      trackedPublicChatId: "public-42",
      clearCitations: jest.fn(),
      clearClarifyingQuestionSurveys: jest.fn(),
      clearTrackedChatId: jest.fn(),
      terminate: jest.fn(),
      _pendingCitations: [],
      _pendingOutputs: [],
      _agentEvents: [],
    };

    let releasePersistence;
    mocks.workspaceChat.upsert.mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePersistence = resolve;
        })
    );

    const storing = plugin._store(aibitat, {
      prompt: "hello",
      response: "hi",
    });
    await Promise.resolve();
    expect(aibitat._terminalTurnPending).toBe(false);
    expect(aibitat.terminate).toHaveBeenCalledTimes(1);

    releasePersistence();
    await storing;
    expect(aibitat._terminalTurnPending).toBe(false);
    expect(aibitat.terminate).toHaveBeenCalledTimes(1);
  });
});
