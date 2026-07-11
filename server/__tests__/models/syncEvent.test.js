const mockCreate = jest.fn();
const mockFindFirst = jest.fn();
const mockFindMany = jest.fn();
const mockFindUnique = jest.fn();
const mockDeleteMany = jest.fn();

jest.mock("../../utils/prisma", () => ({
  athena_sync_events: {
    create: (...args) => mockCreate(...args),
    findFirst: (...args) => mockFindFirst(...args),
    findMany: (...args) => mockFindMany(...args),
    findUnique: (...args) => mockFindUnique(...args),
    deleteMany: (...args) => mockDeleteMany(...args),
  },
}));

const { SyncEvent } = require("../../models/syncEvent");

function row(id, eventId, userId = 7) {
  return {
    id,
    eventId,
    userId,
    targetClientId: null,
    namespace: "thread",
    eventType: "updated",
    visibility: "workspace",
    priority: "normal",
    version: String(id),
    revision: String(id),
    scopeJson: JSON.stringify({ userId, workspaceId: 2, threadId: 9 }),
    resourceJson: JSON.stringify({ kind: "thread", id: 9 }),
    payloadJson: JSON.stringify({ workspaceSlug: "ws", threadSlug: "th" }),
    originJson: "{}",
    sourceClientId: "client-a",
    requiresAck: true,
    createdAt: new Date(`2026-07-11T00:00:0${id}.000Z`),
    expiresAt: new Date("2026-07-18T00:00:00.000Z"),
  };
}

describe("durable sync event cursor", () => {
  beforeEach(() => jest.clearAllMocks());

  it("requires a full sync when no cursor exists", async () => {
    mockFindFirst.mockResolvedValueOnce(row(3, "evt-3"));
    const result = await SyncEvent.replay({ userId: 7, clientId: "ios" });
    expect(result).toMatchObject({
      events: [],
      requiresFullSync: true,
      checkpointEventId: "evt-3",
    });
  });

  it("returns ordered pages after a visible cursor", async () => {
    mockFindFirst
      .mockResolvedValueOnce(row(4, "evt-4"))
      .mockResolvedValueOnce(row(1, "evt-1"));
    mockFindMany.mockResolvedValueOnce([
      row(2, "evt-2"),
      row(3, "evt-3"),
      row(4, "evt-4"),
    ]);
    const result = await SyncEvent.replay({
      userId: 7,
      clientId: "ios",
      afterEventId: "evt-1",
      limit: 2,
    });
    expect(result.events.map((event) => event.eventId)).toEqual([
      "evt-2",
      "evt-3",
    ]);
    expect(result.nextEventId).toBe("evt-3");
    expect(result.hasMore).toBe(true);
    expect(result.requiresFullSync).toBe(false);
    expect(mockFindMany.mock.calls[0][0].where.userId).toBe(7);
  });

  it("does not accept an unavailable or cross-account cursor", async () => {
    mockFindFirst.mockResolvedValueOnce(row(8, "evt-8")).mockResolvedValueOnce(null);
    const result = await SyncEvent.replay({
      userId: 7,
      clientId: "ios",
      afterEventId: "other-user-event",
    });
    expect(result.requiresFullSync).toBe(true);
    expect(result.checkpointEventId).toBe("evt-8");
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
