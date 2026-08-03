/* global jest, describe, beforeEach, test, expect */

const mockSyncV2 = {
  enabled: jest.fn(),
  schemaReady: jest.fn(),
  assertNodeMutationVersion: jest.fn(),
  reconcileNode: jest.fn(),
};

jest.mock("../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: () => mockSyncV2,
}));

const {
  reconcileUserStateProjection,
} = require("../../utils/syncV2/userStateProjection");

describe("user state Sync V2 owner projection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncV2.enabled.mockResolvedValue(true);
    mockSyncV2.schemaReady.mockResolvedValue(true);
    mockSyncV2.reconcileNode.mockResolvedValue({
      node: { stateVersion: 3, hash: "hash-3" },
    });
  });

  test("projects an Identity-owned preference through the Sync owner", async () => {
    await expect(
      reconcileUserStateProjection({
        userId: 7,
        states: [
          {
            namespace: "chat.draft",
            scope: "thread:one",
            value: { text: "draft" },
            version: "1",
            baseVersion: 2,
          },
        ],
        syncContext: { originClientId: "client-1", mutationId: "mutation-1" },
      })
    ).resolves.toEqual({
      status: "reconciled",
      states: [
        {
          namespace: "chat.draft",
          scope: "thread:one",
          stateVersion: 3,
          hash: "hash-3",
        },
      ],
    });
    expect(mockSyncV2.assertNodeMutationVersion).toHaveBeenCalledWith(
      expect.objectContaining({ baseVersion: 2 })
    );
    expect(mockSyncV2.reconcileNode).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "preference.updated",
        originClientId: "client-1",
        mutationId: "mutation-1",
      })
    );
  });

  test("projects deletions without fabricating a preference value", async () => {
    await reconcileUserStateProjection({
      userId: 7,
      operation: "delete",
      namespace: "preferences.appearance",
      scope: "global",
    });
    expect(mockSyncV2.reconcileNode).toHaveBeenCalledWith(
      expect.objectContaining({
        content: { deleted: true },
        eventType: "preference.deleted",
        deletedAt: expect.any(Date),
      })
    );
  });
});
