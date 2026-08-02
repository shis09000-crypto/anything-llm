const mockRequestInternalService = jest.fn();

jest.mock("../../utils/microModules", () => ({
  distributedTopology: jest.fn(() => true),
  requestInternalService: mockRequestInternalService,
}));

describe("thread memory AICP client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestInternalService.mockResolvedValue({ success: true });
  });

  test("keeps status as a P2-compatible query without an idempotency key", async () => {
    const {
      remoteThreadMemoryStatus,
    } = require("../../utils/chats/threadMemoryRemoteClient");
    await remoteThreadMemoryStatus(
      { workspaceId: 28, threadId: 171 },
      {
        ATHENA_RUNTIME_ROLE: "api",
        ATHENA_CHAT_RUNTIME_URL: "https://chat-runtime:3016",
      }
    );

    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        callerModule: "athena-api",
        targetModule: "chat-runtime",
        capability: "chat.memory.status",
        idempotencyKey: null,
      })
    );
  });

  test("carries the P0 manual compaction idempotency key across AICP", async () => {
    const {
      remoteThreadMemoryCompact,
    } = require("../../utils/chats/threadMemoryRemoteClient");
    await remoteThreadMemoryCompact(
      {
        workspaceId: 28,
        threadId: 171,
        sourceActionId: "compact-action-1",
      },
      {
        ATHENA_RUNTIME_ROLE: "api",
        ATHENA_CHAT_RUNTIME_URL: "https://chat-runtime:3016",
      }
    );

    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "chat.memory.compact",
        idempotencyKey: "compact-action-1",
      })
    );
  });
});
