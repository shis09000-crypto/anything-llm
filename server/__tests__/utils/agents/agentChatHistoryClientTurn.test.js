const mockWorkspaceGet = jest.fn();
const mockThreadGet = jest.fn();
const mockChatUpsert = jest.fn();
const mockChatNew = jest.fn();
const mockPublishWorkspaceSyncEvent = jest.fn();
const mockRemotePersistenceEnabled = jest.fn();
const mockReserveAgentChatTurn = jest.fn();
const mockFinalizeAgentChatTurn = jest.fn();

jest.mock("../../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: (name) => {
    if (name === "workspace")
      return { get: (...args) => mockWorkspaceGet(...args) };
    if (name === "workspaceThread")
      return { get: (...args) => mockThreadGet(...args) };
    if (name === "workspaceChat")
      return {
        new: (...args) => mockChatNew(...args),
        upsert: (...args) => mockChatUpsert(...args),
      };
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
  compactAgentEvents: (events) => events,
}));
jest.mock("../../../utils/chats/displayPrompt", () => ({
  promptForHistory: ({ message }) => message,
}));
jest.mock("../../../utils/agents/agentChatPersistenceClient", () => ({
  remoteAgentChatPersistenceEnabled: (...args) =>
    mockRemotePersistenceEnabled(...args),
  reserveAgentChatTurn: (...args) => mockReserveAgentChatTurn(...args),
  finalizeAgentChatTurn: (...args) => mockFinalizeAgentChatTurn(...args),
}));

describe("Agent chat history client turn propagation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRemotePersistenceEnabled.mockReturnValue(false);
    mockWorkspaceGet.mockResolvedValue({ id: 4, slug: "alpha" });
    mockThreadGet.mockResolvedValue({ id: 11, slug: "thread-a" });
    mockChatUpsert.mockResolvedValue({ chat: { id: 22 }, message: null });
    mockChatNew.mockResolvedValue({
      chat: { id: 23, public_id: "chat_reserved-23" },
      message: null,
    });
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

  it("creates the complete chat only at final persistence with the reserved public id", async () => {
    const {
      chatHistory,
    } = require("../../../utils/agents/aibitat/plugins/chat-history");
    const plugin = chatHistory.plugin.call(chatHistory);
    const aibitat = {
      handlerProps: {
        invocation: {
          uuid: "invocation-2",
          workspace_id: 4,
          user_id: 7,
          thread_id: 11,
          clientTurnId: "turn-agent-2",
        },
        reservedPublicChatId: "chat_reserved-23",
      },
      trackedChatId: null,
      trackedPublicChatId: null,
      provider: { getUsage: () => ({ model: "deepseek-v4-flash" }) },
      _threadRenamed: true,
      _pendingCitations: [],
      _pendingOutputs: [],
      _pendingClarifyingQuestionSurveys: [],
      _agentEvents: [],
      registerChatId: jest.fn(function (id, publicId) {
        this.trackedChatId = id;
        this.trackedPublicChatId = publicId;
      }),
    };

    await plugin._store(aibitat, {
      prompt: "question",
      response: "complete answer",
    });

    expect(mockChatUpsert).not.toHaveBeenCalled();
    expect(mockChatNew).toHaveBeenCalledTimes(1);
    expect(mockChatNew).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "question",
        publicChatId: "chat_reserved-23",
        clientTurnId: "turn-agent-2",
        include: true,
        response: expect.objectContaining({ text: "complete answer" }),
      })
    );
    expect(aibitat.registerChatId).toHaveBeenCalledWith(23, "chat_reserved-23");
  });

  it("does not create a chat record when the turn is aborted before completion", async () => {
    const {
      chatHistory,
    } = require("../../../utils/agents/aibitat/plugins/chat-history");
    const plugin = chatHistory.plugin.call(chatHistory);
    let abortHandler = null;
    const aibitat = {
      handlerProps: {
        invocation: {
          uuid: "invocation-aborted",
          workspace_id: 4,
          user_id: 7,
          thread_id: 11,
          clientTurnId: "turn-aborted",
        },
        reservedPublicChatId: "chat_reserved-aborted",
      },
      trackedChatId: null,
      chats: [
        { from: "USER", to: "WORKSPACE", content: "question" },
        { from: "WORKSPACE", to: "USER", content: "partial answer" },
      ],
      onAbort: (handler) => {
        abortHandler = handler;
      },
    };

    plugin.setup(aibitat);
    expect(mockChatNew).not.toHaveBeenCalled();
    abortHandler();

    await expect(aibitat.persistCompletedTurn()).resolves.toBeNull();
    expect(mockChatNew).not.toHaveBeenCalled();
    expect(mockChatUpsert).not.toHaveBeenCalled();
  });

  it("reserves in memory and delegates final persistence to Chat Runtime", async () => {
    mockRemotePersistenceEnabled.mockReturnValue(true);
    mockReserveAgentChatTurn.mockResolvedValue({
      success: true,
      chat: {
        id: "ath_agent_turn_reservation-1",
        reservationId: "ath_agent_turn_reservation-1",
      },
    });
    mockFinalizeAgentChatTurn.mockResolvedValue({
      success: true,
      chat: { id: 31, publicId: "chat_public-31" },
    });
    const {
      chatHistory,
    } = require("../../../utils/agents/aibitat/plugins/chat-history");
    const plugin = chatHistory.plugin.call(chatHistory);
    const aibitat = {
      handlerProps: {
        invocation: {
          uuid: "invocation-remote",
          workspace_id: 4,
          user_id: 7,
          thread_id: 11,
          clientTurnId: "turn-agent-remote",
        },
        reservedPublicChatId: "chat_public-31",
      },
      trackedChatId: null,
      trackedPublicChatId: null,
      provider: { getUsage: () => ({ model: "deepseek-v4-flash" }) },
      _threadRenamed: false,
      _pendingCitations: [],
      _pendingOutputs: [],
      _pendingClarifyingQuestionSurveys: [],
      _agentEvents: [],
      registerChatId: jest.fn(function (id, publicId) {
        this.trackedChatId = id;
        this.trackedPublicChatId = publicId;
      }),
    };

    await plugin._store(aibitat, {
      prompt: "question",
      response: "complete answer",
    });

    expect(mockChatNew).not.toHaveBeenCalled();
    expect(mockChatUpsert).not.toHaveBeenCalled();
    expect(mockReserveAgentChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 4,
        clientTurnId: "turn-agent-remote",
        prompt: "question",
      })
    );
    expect(mockFinalizeAgentChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "ath_agent_turn_reservation-1",
        publicChatId: "chat_public-31",
        response: expect.objectContaining({ text: "complete answer" }),
      })
    );
    expect(aibitat.registerChatId).toHaveBeenCalledWith(31, "chat_public-31");
    expect(mockPublishWorkspaceSyncEvent).not.toHaveBeenCalled();
  });
});
