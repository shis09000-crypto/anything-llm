const mockCompactThread = jest.fn();
const mockGetThreadCompactionStatus = jest.fn();
const mockRecentChatHistoryWithCompaction = jest.fn();
const mockWrapMaterial = jest.fn();
const mockUnwrapMaterial = jest.fn();

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    workspace: { get: jest.fn(async () => ({ id: 28, slug: "workspace" })) },
    workspaceThread: {
      get: jest.fn(async () => ({
        id: 171,
        workspace_id: 28,
        user_id: 4,
        historyRevision: 2266,
      })),
    },
  },
}));
jest.mock("../../utils/chats/threadCompaction", () => ({
  compactThread: mockCompactThread,
  getThreadCompactionStatus: mockGetThreadCompactionStatus,
  recentChatHistoryWithCompaction: mockRecentChatHistoryWithCompaction,
}));
jest.mock("../../utils/security/keyCustody/remoteClient", () => ({
  remoteKeyCustodyEnabled: jest.fn(() => true),
  wrapMaterial: mockWrapMaterial,
  unwrapMaterial: mockUnwrapMaterial,
}));

describe("Chat Runtime thread-memory ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCompactThread.mockResolvedValue({ success: true, compactionId: 14 });
  });

  test("deduplicates a repeated manual compaction action inside Chat Runtime", async () => {
    const { compact } = require("../../utils/chats/threadMemoryRuntime");
    const input = {
      workspaceId: 28,
      threadId: 171,
      userId: 4,
      sourceActionId: "manual-compact-1",
    };

    const [first, repeated] = await Promise.all([
      compact(input),
      compact(input),
    ]);

    expect(mockCompactThread).toHaveBeenCalledTimes(1);
    expect(first).toEqual(repeated);
    expect(first.compactionId).toBe(14);
  });

  test("fails readiness when the Key Custody contract fingerprint drifts", async () => {
    mockWrapMaterial.mockRejectedValueOnce(
      Object.assign(new Error("aicp_contract_fingerprint_mismatch"), {
        code: "AICP_CONTRACT_FINGERPRINT_MISMATCH",
      })
    );
    const {
      publicReadiness,
      threadMemoryKeyCustodySelfTest,
    } = require("../../utils/chats/threadMemoryRuntime");

    await expect(threadMemoryKeyCustodySelfTest({})).rejects.toMatchObject({
      code: "thread_memory_contract_incompatible",
      httpStatus: 503,
    });
    expect(publicReadiness()).toMatchObject({
      ready: false,
      reasonCode: "thread_memory_contract_incompatible",
    });
  });
});
