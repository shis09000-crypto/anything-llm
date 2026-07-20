const mockHistoryFingerprintManifest = jest.fn();

jest.mock("../../models/workspaceThread", () => ({
  WorkspaceThread: {
    historyFingerprintManifest: (...args) =>
      mockHistoryFingerprintManifest(...args),
  },
}));

const {
  threadFingerprintManifestForRequest,
} = require("../../utils/syncV2/threadFingerprintManifest");

describe("Sync V2 thread fingerprint manifest", () => {
  beforeEach(() => jest.clearAllMocks());

  test("uses one workspace query and one thread query for many scopes", async () => {
    const client = {
      workspaces: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1, slug: "ws-a" },
          { id: 2, slug: "ws-b" },
        ]),
      },
      workspace_threads: {
        findMany: jest.fn().mockResolvedValue([
          { id: 11, workspace_id: 1, slug: "t-a", historyRevision: 2 },
          { id: 22, workspace_id: 2, slug: "t-b", historyRevision: 4 },
        ]),
      },
    };
    mockHistoryFingerprintManifest.mockResolvedValue([
      {
        threadId: 11,
        historyFingerprint: "fp-a",
        historyRevision: 2,
        latestChatId: 101,
        latestChatAt: new Date("2026-07-19T00:00:00.000Z"),
      },
      {
        threadId: 22,
        historyFingerprint: "fp-b",
        historyRevision: 4,
        latestChatId: 202,
        latestChatAt: null,
      },
    ]);
    const requests = [
      { workspaceSlug: "ws-a", threadSlug: "t-a", fingerprint: "fp-a" },
      { workspaceSlug: "ws-b", threadSlug: "t-b", fingerprint: "old" },
      { workspaceSlug: "missing", threadSlug: "t-x", fingerprint: null },
    ];

    const result = await threadFingerprintManifestForRequest({
      client,
      userId: 7,
      requireMembership: true,
      requests,
    });

    expect(client.workspaces.findMany).toHaveBeenCalledTimes(1);
    expect(client.workspace_threads.findMany).toHaveBeenCalledTimes(1);
    expect(client.workspaces.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          slug: { in: ["ws-a", "ws-b", "missing"] },
          workspace_users: { some: { user_id: 7 } },
        }),
      })
    );
    expect(result).toEqual([
      expect.objectContaining({ status: "unchanged", historyFingerprint: "fp-a" }),
      expect.objectContaining({ status: "changed", historyFingerprint: "fp-b" }),
      { workspaceSlug: "missing", threadSlug: "t-x", status: "unavailable" },
    ]);
  });

  test("surfaces database faults instead of returning unavailable rows", async () => {
    const client = {
      workspaces: {
        findMany: jest.fn().mockRejectedValue(new Error("database offline")),
      },
      workspace_threads: { findMany: jest.fn() },
    };

    await expect(
      threadFingerprintManifestForRequest({
        client,
        userId: 7,
        requests: [{ workspaceSlug: "ws-a", threadSlug: "t-a" }],
      })
    ).rejects.toMatchObject({
      code: "database_operation_failed",
      httpStatus: 503,
      operation: "SyncV2.threadFingerprintManifest",
    });
  });
});
