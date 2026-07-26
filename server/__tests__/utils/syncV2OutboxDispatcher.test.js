/* eslint-env jest */

const mockAudienceUserIds = jest.fn();
const mockMarkOutboxDispatched = jest.fn();
const mockFailOutboxClaim = jest.fn();
const mockReleaseOutboxClaims = jest.fn();
const mockPublishDurably = jest.fn();
const mockSchemaReady = jest.fn();
const mockClaimOutbox = jest.fn();
const mockRenewOutboxClaims = jest.fn();
const mockPruneExpired = jest.fn();
const mockOutboxHealth = jest.fn();
const mockOutboxDispatchEnabled = jest.fn();
const mockControlPlaneMode = jest.fn();
const mockOutboxIntervalMs = jest.fn();

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    syncV2: {
      audienceUserIds: mockAudienceUserIds,
      markOutboxDispatched: mockMarkOutboxDispatched,
      failOutboxClaim: mockFailOutboxClaim,
      releaseOutboxClaims: mockReleaseOutboxClaims,
      schemaReady: mockSchemaReady,
      claimOutbox: mockClaimOutbox,
      renewOutboxClaims: mockRenewOutboxClaims,
      pruneExpired: mockPruneExpired,
      outboxHealth: mockOutboxHealth,
    },
  },
}));

jest.mock("../../utils/broadcast", () => ({
  publishBroadcastEventDurably: mockPublishDurably,
}));

jest.mock("../../utils/syncV2/config", () => ({
  syncV2ControlPlaneMode: (...args) => mockControlPlaneMode(...args),
  syncV2OutboxDispatchEnabled: (...args) =>
    mockOutboxDispatchEnabled(...args),
  syncV2OutboxIntervalMs: (...args) => mockOutboxIntervalMs(...args),
}));

const {
  flushSyncV2Outbox,
  startSyncV2OutboxDispatcher,
  stopSyncV2OutboxDispatcher,
  syncV2OutboxSnapshot,
  _internals: { dispatchRow, partitionLanes, processLane },
} = require("../../utils/syncV2/outboxDispatcher");

function row(overrides = {}) {
  return {
    seq: 1,
    eventId: "evt-1",
    nodeKey: "users/1/profile",
    stateVersion: 2,
    eventType: "profile.updated",
    changedPathsJson: '["name"]',
    payloadHintJson: "{}",
    ownerType: "user",
    ownerId: 1,
    visibility: "user",
    createdAt: new Date("2026-07-19T00:00:00.000Z"),
    attemptCount: 0,
    ...overrides,
  };
}

describe("Sync V2 Outbox dispatcher", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAudienceUserIds.mockResolvedValue([1]);
    mockPublishDurably.mockResolvedValue({ eventId: "evt-1:1" });
    mockMarkOutboxDispatched.mockResolvedValue({ count: 1 });
    mockFailOutboxClaim.mockResolvedValue({
      updated: true,
      deadLettered: false,
    });
    mockReleaseOutboxClaims.mockResolvedValue({ count: 1 });
    mockSchemaReady.mockResolvedValue(true);
    mockClaimOutbox.mockResolvedValue([]);
    mockRenewOutboxClaims.mockResolvedValue({ count: 0 });
    mockPruneExpired.mockResolvedValue({ count: 0 });
    mockOutboxHealth.mockResolvedValue({
      pending: 0,
      retrying: 0,
      deadLetters: 0,
      oldestPendingAgeMs: 0,
    });
    mockOutboxDispatchEnabled.mockReturnValue(true);
    mockControlPlaneMode.mockReturnValue("shadow");
    mockOutboxIntervalMs.mockReturnValue(5_000);
  });

  afterEach(async () => {
    await stopSyncV2OutboxDispatcher({ drain: false });
  });

  test("acknowledges the Outbox row only after durable broadcast commit", async () => {
    const order = [];
    mockPublishDurably.mockImplementation(async () => order.push("persisted"));
    mockMarkOutboxDispatched.mockImplementation(async () =>
      order.push("acked")
    );

    await dispatchRow(row(), "worker-1");

    expect(order).toEqual(["persisted", "acked"]);
    expect(mockMarkOutboxDispatched).toHaveBeenCalledWith({
      seq: 1,
      leaseOwner: "worker-1",
    });
  });

  test("does not acknowledge when durable broadcast persistence fails", async () => {
    mockPublishDurably.mockRejectedValueOnce(
      Object.assign(new Error("disk unavailable"), { code: "SQLITE_BUSY" })
    );

    await expect(dispatchRow(row(), "worker-1")).rejects.toThrow(
      "disk unavailable"
    );
    expect(mockMarkOutboxDispatched).not.toHaveBeenCalled();
  });

  test("preserves same-node order while allowing independent lanes", () => {
    expect(
      partitionLanes([
        row({ seq: 3, nodeKey: "node-a" }),
        row({ seq: 2, nodeKey: "node-b" }),
        row({ seq: 1, nodeKey: "node-a" }),
      ]).map((lane) => lane.map((entry) => entry.seq))
    ).toEqual([[1, 3], [2]]);
  });

  test("retries a failed head and releases only later rows in its lane", async () => {
    mockPublishDurably.mockRejectedValueOnce(new Error("temporary"));

    await expect(
      processLane(
        [row({ seq: 10 }), row({ seq: 11 }), row({ seq: 12 })],
        "worker-1"
      )
    ).resolves.toBe(0);

    expect(mockFailOutboxClaim).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 10, leaseOwner: "worker-1" })
    );
    expect(mockReleaseOutboxClaims).toHaveBeenCalledWith({
      seqs: [11, 12],
      leaseOwner: "worker-1",
    });
  });

  test("runs the internal shadow dispatcher independently of client rollout", async () => {
    await expect(
      startSyncV2OutboxDispatcher({ intervalMs: 60_000 })
    ).resolves.toBe(true);
    expect(mockSchemaReady).toHaveBeenCalled();
    expect(mockClaimOutbox).toHaveBeenCalled();
  });

  test("keeps startup available through repeated P2028 and recovers later", async () => {
    const transactionExpired = Object.assign(
      new Error("Transaction already closed"),
      { code: "P2028" }
    );
    mockClaimOutbox
      .mockRejectedValueOnce(transactionExpired)
      .mockRejectedValueOnce(transactionExpired)
      .mockRejectedValueOnce(transactionExpired)
      .mockResolvedValue([]);

    await expect(
      startSyncV2OutboxDispatcher({ intervalMs: 60_000 })
    ).resolves.toBe(true);
    await expect(flushSyncV2Outbox()).rejects.toMatchObject({ code: "P2028" });
    await expect(flushSyncV2Outbox()).rejects.toMatchObject({ code: "P2028" });

    expect(syncV2OutboxSnapshot()).toMatchObject({
      running: true,
      consecutiveFailures: 3,
      lastError: "P2028",
    });
    await expect(flushSyncV2Outbox()).resolves.toMatchObject({
      claimed: 0,
      dispatched: 0,
    });
    expect(syncV2OutboxSnapshot()).toMatchObject({
      running: true,
      consecutiveFailures: 0,
      lastError: null,
    });
  });

  test("does not claim or acknowledge when the migrated schema is unavailable", async () => {
    mockSchemaReady.mockResolvedValue(false);
    await expect(flushSyncV2Outbox()).resolves.toEqual({
      skipped: true,
      reason: "schema_unavailable",
    });
    expect(mockClaimOutbox).not.toHaveBeenCalled();
    expect(mockMarkOutboxDispatched).not.toHaveBeenCalled();
  });

  test("honors the emergency Outbox dispatch kill switch", async () => {
    mockOutboxDispatchEnabled.mockReturnValue(false);
    await expect(flushSyncV2Outbox()).resolves.toEqual({
      skipped: true,
      reason: "disabled",
    });
    expect(mockSchemaReady).not.toHaveBeenCalled();
  });
});
