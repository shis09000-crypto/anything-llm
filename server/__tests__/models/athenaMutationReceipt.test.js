/* eslint-env jest */

const mockFindUnique = jest.fn();
const mockFindMany = jest.fn();
const mockUpdateMany = jest.fn();
const mockCreate = jest.fn();
const mockCount = jest.fn();
const mockDeleteMany = jest.fn();

jest.mock("../../utils/prisma", () => ({
  athena_mutation_receipts: {
    findUnique: mockFindUnique,
    findMany: mockFindMany,
    updateMany: mockUpdateMany,
    create: mockCreate,
    count: mockCount,
    deleteMany: mockDeleteMany,
  },
}));

const { AthenaMutationReceipt } = require("../../models/athenaMutationReceipt");

describe("AthenaMutationReceipt leases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("reclaims an expired pending receipt with a new lease", async () => {
    const stale = {
      id: 9,
      userId: 1,
      sourceActionId: "action-1",
      status: "pending",
      leaseOwner: "old-worker",
      leaseExpiresAt: new Date(0),
      updatedAt: new Date(0),
    };
    const claimed = { ...stale, leaseOwner: "new-worker", attemptCount: 2 };
    mockFindUnique.mockResolvedValueOnce(stale).mockResolvedValueOnce(claimed);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      AthenaMutationReceipt.reserve({
        userId: 1,
        sourceActionId: "action-1",
        action: "workspace.rename",
        leaseOwner: "new-worker",
      })
    ).resolves.toMatchObject({
      created: true,
      claimed: true,
      recovered: true,
      leaseOwner: "new-worker",
    });
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9, status: expect.any(Object) }),
      })
    );
  });

  test("rejects completion after lease ownership is lost", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      AthenaMutationReceipt.complete({
        userId: 1,
        sourceActionId: "action-1",
        leaseOwner: "worker-1",
      })
    ).rejects.toMatchObject({ code: "mutation_receipt_lease_lost" });
  });

  test("does not overwrite a receipt reclaimed after the sweep snapshot", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 10,
        action: "workspace.delete",
        status: "pending",
        leaseOwner: "worker-old",
        leaseExpiresAt: new Date(0),
        updatedAt: new Date(0),
      },
    ]);
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      AthenaMutationReceipt.sweepStale({ now: new Date(60_000) })
    ).resolves.toEqual({ scanned: 1, recovered: 0, released: 0, failed: 0 });
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 10,
          leaseOwner: "worker-old",
          updatedAt: new Date(0),
        }),
      })
    );
  });

  test("recovers a Sync V2 receipt from its committed mutation event", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 11,
        action: "sync-v2.mutation",
        nodeKey: "users/1/profile",
        mutationId: "mutation-1",
        status: "pending",
        leaseOwner: "worker-old",
        leaseExpiresAt: new Date(0),
        updatedAt: new Date(0),
      },
    ]);
    mockUpdateMany.mockResolvedValue({ count: 1 });
    const replayResolver = jest.fn().mockResolvedValue({
      descriptor: { nodeKey: "users/1/profile", stateVersion: 3 },
    });

    await expect(
      AthenaMutationReceipt.sweepStale({
        now: new Date(60_000),
        replayResolver,
      })
    ).resolves.toEqual({ scanned: 1, recovered: 1, released: 0, failed: 0 });
    expect(replayResolver).toHaveBeenCalledWith({
      nodeKey: "users/1/profile",
      mutationId: "mutation-1",
    });
  });

  test("prunes expired recoverable receipts without touching active leases", async () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    mockDeleteMany.mockResolvedValue({ count: 2 });

    await expect(AthenaMutationReceipt.pruneExpired({ now })).resolves.toEqual({
      count: 2,
    });
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: now },
        status: { in: ["completed", "failed", "recoverable"] },
      },
    });
  });
});
