const mockDeleteTurnPermanently = jest.fn();
const mockThreadGet = jest.fn();
const mockHistoryFingerprintManifest = jest.fn();
const mockPublishWorkspaceSyncEvent = jest.fn();
const mockFlushDurableCommits = jest.fn();

jest.mock("../../../utils/dataAccess", () => ({
  DataAccessCenter: {
    workspaceChat: {
      deleteTurnPermanently: (...args) => mockDeleteTurnPermanently(...args),
    },
    workspaceThread: {
      get: (...args) => mockThreadGet(...args),
      historyFingerprintManifest: (...args) =>
        mockHistoryFingerprintManifest(...args),
    },
  },
}));
jest.mock("../../../utils/chats/workspaceSyncEvents", () => ({
  publishWorkspaceSyncEvent: (...args) =>
    mockPublishWorkspaceSyncEvent(...args),
}));
jest.mock("../../../utils/broadcast", () => ({
  _internals: {
    flushDurableCommits: (...args) => mockFlushDurableCommits(...args),
  },
}));

const {
  deleteChatTurnAndPublish,
} = require("../../../utils/chats/chatTurnMutations");

describe("chat turn mutation sync events", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteTurnPermanently.mockResolvedValue({
      success: true,
      replayed: false,
      deletedCount: 1,
    });
    mockThreadGet.mockResolvedValue({ id: 8, slug: "thread-a" });
    mockHistoryFingerprintManifest.mockResolvedValue([
      {
        historyRevision: 14,
        historyFingerprint: "fingerprint-14",
      },
    ]);
    mockPublishWorkspaceSyncEvent.mockImplementation((event) => event);
    mockFlushDurableCommits.mockResolvedValue(undefined);
  });

  it("publishes metadata-only deletion after the physical mutation commits", async () => {
    await deleteChatTurnAndPublish({
      workspace: { id: 7, slug: "workspace-a" },
      thread: { id: 8, slug: "thread-a" },
      user: { id: 9 },
      clientContext: { clientId: "ios-a" },
      chatId: 21,
      sourceActionId: "delete-21",
    });

    expect(mockDeleteTurnPermanently).toHaveBeenCalledTimes(1);
    expect(mockPublishWorkspaceSyncEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat_deleted",
        mutationKind: "manual-delete",
        chatId: 21,
        targetChatId: 21,
        sourceActionId: "delete-21",
        historyRevision: 14,
        historyFingerprint: "fingerprint-14",
      }),
      { coalesce: false }
    );
    const [event] = mockPublishWorkspaceSyncEvent.mock.calls[0];
    expect(event).not.toHaveProperty("prompt");
    expect(event).not.toHaveProperty("response");
    expect(event).not.toHaveProperty("message");
    expect(mockFlushDurableCommits).toHaveBeenCalledTimes(1);
  });

  it("does not publish a duplicate event when a completed receipt is replayed", async () => {
    mockDeleteTurnPermanently.mockResolvedValue({
      success: true,
      replayed: true,
      deletedCount: 1,
    });

    await deleteChatTurnAndPublish({
      workspace: { id: 7, slug: "workspace-a" },
      thread: { id: 8, slug: "thread-a" },
      user: { id: 9 },
      chatId: 21,
      sourceActionId: "delete-21",
    });

    expect(mockPublishWorkspaceSyncEvent).not.toHaveBeenCalled();
    expect(mockFlushDurableCommits).not.toHaveBeenCalled();
  });
});
