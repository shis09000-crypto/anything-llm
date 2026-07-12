const mockChatNew = jest.fn();
const mockPublishWorkspaceSyncEvent = jest.fn();

jest.mock("../../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: (name) => {
    if (name === "workspaceChat")
      return { new: (...args) => mockChatNew(...args) };
    if (name === "userMemory") {
      return { memoryOwnerIdFromSessionUser: jest.fn() };
    }
    return {};
  },
}));
jest.mock("../../../utils/DocumentManager", () => ({
  DocumentManager: jest.fn(),
}));
jest.mock("../../../utils/helpers", () => ({
  getLLMProvider: () => ({}),
  getVectorDbClass: () => ({
    hasNamespace: jest.fn(async () => false),
    namespaceCount: jest.fn(async () => 0),
  }),
}));
jest.mock("../../../utils/helpers/chat/responses", () => ({
  writeResponseChunk: (response, payload) => response.chunks.push(payload),
}));
jest.mock("../../../utils/chats/agents", () => ({
  grepAgents: jest.fn(async () => false),
}));
jest.mock("../../../utils/chats/index", () => ({
  grepCommand: jest.fn(async (message) => message),
  VALID_COMMANDS: {},
  chatPrompt: jest.fn(),
  sourceIdentifier: jest.fn(),
  cacheStableHistoryStrategyFor: () => ({}),
}));
jest.mock("../../../utils/chats/threadCompaction", () => ({
  contextTextsWithCompaction: jest.fn(),
  maybeAutoCompact: jest.fn(),
  recentChatHistoryWithCompaction: jest.fn(),
}));
jest.mock("../../../utils/chats/workspaceSyncEvents", () => ({
  publishWorkspaceSyncEvent: (...args) =>
    mockPublishWorkspaceSyncEvent(...args),
}));
jest.mock("../../../utils/knowledgeGraph/graphContextResolver", () => ({
  resolveGraphContext: jest.fn(),
}));
jest.mock("../../../utils/vision/viewTool", () => ({
  shouldUseVisionTool: () => false,
  prepareImageAnalysisContext: jest.fn(async () => ({ used: false })),
}));
jest.mock("../../../utils/chats/currentDateTimeContext", () => ({
  appendCurrentDateTimeToPrompt: (value) => value,
}));
jest.mock("../../../utils/chats/personalizationContext", () => ({
  appendUserPersonalizationToSystemPrompt: jest.fn(),
}));
jest.mock("../../../utils/chats/longTermMemoryContext", () => ({
  appendUserLongTermMemoryToSystemPromptWithState: jest.fn(),
}));
jest.mock("../../../utils/chats/saveMemoryTool", () => ({
  SAVE_MEMORY_TOOL_NAME: "save-memory",
  SAVE_MEMORY_TOOL_SYSTEM_INSTRUCTION: "",
  approvalPayloadForMemory: jest.fn(),
  executeSaveMemoryTool: jest.fn(),
  normalizeSaveMemoryArgs: jest.fn(),
  saveMemoryToolCallFrom: jest.fn(),
  saveMemoryToolsForMessage: () => [],
  toolCallEventFrom: jest.fn(),
}));
jest.mock("../../../utils/chats/toolApproval", () => ({
  requestChatToolApproval: jest.fn(),
}));
jest.mock("../../../utils/chats/displayPrompt", () => ({
  promptForHistory: ({ message, displayPrompt }) => displayPrompt || message,
}));

describe("query-mode refusal finalization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatNew.mockResolvedValue({
      chat: { id: 42, public_id: "public-42" },
      message: null,
    });
  });

  it("emits a stable final event after saving the refusal", async () => {
    const { streamChatWithWorkspace } = require("../../../utils/chats/stream");
    const response = { chunks: [] };

    await streamChatWithWorkspace(
      response,
      { id: 4, slug: "alpha", queryRefusalResponse: "没有可查询的资料。" },
      "question",
      "query",
      { id: 7 },
      { id: 11, slug: "thread-a" },
      [],
      {
        clientTurnId: "turn-query-1",
        syncEvent: { workspaceId: 4, workspaceSlug: "alpha", userId: 7 },
      }
    );

    expect(response.chunks).toEqual([
      expect.objectContaining({
        type: "textResponse",
        textResponse: "没有可查询的资料。",
        close: false,
      }),
      expect.objectContaining({
        type: "finalizeResponseStream",
        chatId: 42,
        publicChatId: "public-42",
        clientTurnId: "turn-query-1",
        close: true,
      }),
    ]);
    expect(mockPublishWorkspaceSyncEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat_finalized",
        chatId: 42,
        publicChatId: "public-42",
        clientTurnId: "turn-query-1",
      })
    );
  });
});
