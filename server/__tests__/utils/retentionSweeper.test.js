const mockDataAccessCenter = {
  retention: {
    sweepPatrolRuns: jest.fn(),
    sweepExpiredUploads: jest.fn(),
    sweepOperationalRows: jest.fn(),
  },
  syncV2: { pruneExpired: jest.fn() },
  athenaMutationReceipt: { pruneExpired: jest.fn() },
  contentObject: { reconcile: jest.fn() },
  imageAsset: { pendingDeletion: jest.fn() },
};

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: mockDataAccessCenter,
}));

const {
  retentionPolicy,
  runRetentionSweep,
} = require("../../utils/retention/sweeper");

describe("retention sweeper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ATHENA_RETENTION_ENABLED;
    mockDataAccessCenter.retention.sweepPatrolRuns.mockResolvedValue({
      deleted: 2,
    });
    mockDataAccessCenter.retention.sweepExpiredUploads.mockResolvedValue({
      deleted: 3,
    });
    mockDataAccessCenter.retention.sweepOperationalRows.mockResolvedValue({
      eventLogs: 4,
      expiredReservations: 1,
    });
    mockDataAccessCenter.syncV2.pruneExpired.mockResolvedValue({ count: 5 });
    mockDataAccessCenter.athenaMutationReceipt.pruneExpired.mockResolvedValue({
      count: 6,
    });
    mockDataAccessCenter.contentObject.reconcile.mockResolvedValue({
      inspected: 7,
      deleted: 7,
    });
    mockDataAccessCenter.imageAsset.pendingDeletion.mockResolvedValue([]);
  });

  it("is opt-in by default", async () => {
    await expect(runRetentionSweep()).resolves.toEqual({
      skipped: true,
      reason: "disabled",
    });
    expect(mockDataAccessCenter.retention.sweepPatrolRuns).not.toHaveBeenCalled();
  });

  it("runs bounded cleanup with explicit retention windows", async () => {
    const now = new Date("2026-07-20T00:00:00.000Z");
    const result = await runRetentionSweep({ now, force: true });

    expect(result.skipped).toBe(false);
    expect(result.policy).toEqual(retentionPolicy());
    expect(mockDataAccessCenter.retention.sweepPatrolRuns).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 })
    );
    expect(mockDataAccessCenter.contentObject.reconcile).toHaveBeenCalledWith({
      stagingBefore: new Date("2026-07-19T00:00:00.000Z"),
      deleteBefore: now,
      limit: 100,
    });
    expect(result.operational).toEqual({
      eventLogs: 4,
      expiredReservations: 1,
      syncOutbox: 5,
      mutationReceipts: 6,
    });
    expect(result.imageAssets).toEqual({
      inspected: 0,
      completed: 0,
      pending: 0,
    });
  });
});
