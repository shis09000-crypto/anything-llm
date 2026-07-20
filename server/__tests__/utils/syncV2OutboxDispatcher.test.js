/* eslint-env jest */

const mockAudienceUserIds = jest.fn();
const mockMarkOutboxDispatched = jest.fn();
const mockFailOutboxClaim = jest.fn();
const mockReleaseOutboxClaims = jest.fn();
const mockPublishDurably = jest.fn();

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    syncV2: {
      audienceUserIds: mockAudienceUserIds,
      markOutboxDispatched: mockMarkOutboxDispatched,
      failOutboxClaim: mockFailOutboxClaim,
      releaseOutboxClaims: mockReleaseOutboxClaims,
    },
  },
}));

jest.mock("../../utils/broadcast", () => ({
  publishBroadcastEventDurably: mockPublishDurably,
}));

jest.mock("../../utils/syncV2/config", () => ({
  syncV2Enabled: () => true,
}));

const {
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
});
