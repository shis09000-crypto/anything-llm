const mockPrisma = {
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
};
const mockSyncV2 = {
  enabled: jest.fn(() => true),
  schemaReady: jest.fn(async () => true),
  assertMutationVersion: jest.fn(async () => true),
  recordNodeChange: jest.fn(),
};

jest.mock("../../utils/prisma", () => mockPrisma);
jest.mock("../../models/syncV2", () => ({ SyncV2: mockSyncV2 }));
jest.mock("../../utils/security/userStateValueProtection", () => ({
  decodeUserStateValue: ({ storedValue }) => storedValue,
  encodeUserStateValue: ({ value }) => JSON.stringify(value),
}));

const {
  UserStatePreference,
  _internals: { applyMutationOperation },
} = require("../../models/userStatePreference");

describe("user state merge policies", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncV2.enabled.mockReturnValue(true);
    mockSyncV2.schemaReady.mockResolvedValue(true);
  });

  test("monotonic cursor never moves backward", () => {
    expect(
      applyMutationOperation(
        { cursor: 20, messageId: 7 },
        "merge",
        { cursor: 12, messageId: 5 },
        "monotonic-cursor"
      )
    ).toEqual({ cursor: 20, messageId: 7 });
  });

  test("monotonic cursor advances with the winning payload", () => {
    expect(
      applyMutationOperation(
        { cursor: 20, messageId: 7 },
        "merge",
        { cursor: 21, messageId: 8 },
        "monotonic-cursor"
      )
    ).toEqual({ cursor: 21, messageId: 8 });
  });

  test("read projection includes userId for protected value binding", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      {
        userId: 7,
        namespace: "chat.draft",
        scope: "global",
        value: { text: "draft" },
        version: "3",
      },
    ]);

    await expect(UserStatePreference.where({ userId: 7 })).resolves.toEqual([
      expect.objectContaining({
        namespace: "chat.draft",
        value: { text: "draft" },
      }),
    ]);
    expect(mockPrisma.$queryRawUnsafe.mock.calls[0][0]).toContain('"userId"');
  });

  test("stale read cursor is a no-op without version conflict, write, or Outbox", async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          userId: 7,
          namespace: "thread.read-state",
          scope: "thread:ws-a:thread-a",
          value: { cursor: 20, messageId: 20 },
          version: "1",
        },
      ]),
      $executeRawUnsafe: jest.fn(),
      sync_nodes: {
        findUnique: jest.fn().mockResolvedValue({
          stateVersion: 4,
          contentHash: "hash:read-20",
        }),
      },
    };
    mockPrisma.$transaction.mockImplementation((callback) => callback(tx));

    const result = await UserStatePreference.upsertMany({
      userId: 7,
      states: [
        {
          namespace: "thread.read-state",
          scope: "thread:ws-a:thread-a",
          mutationOperation: "merge",
          mutationPayload: { cursor: 12, messageId: 12 },
          baseVersion: 1,
        },
      ],
    });

    expect(result[0]).toEqual(
      expect.objectContaining({
        value: { cursor: 20, messageId: 20 },
        stateVersion: 4,
      })
    );
    expect(mockSyncV2.assertMutationVersion).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(mockSyncV2.recordNodeChange).not.toHaveBeenCalled();
  });

  test("server monotonic cursor remains authoritative when the encrypted value projection is stale", async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          userId: 7,
          namespace: "thread.read-state",
          scope: "thread:ws-a:thread-a",
          value: { cursor: 20, messageId: 20 },
          version: "1",
          monotonicCursor: 40,
        },
      ]),
      $executeRawUnsafe: jest.fn(),
      sync_nodes: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    mockPrisma.$transaction.mockImplementation((callback) => callback(tx));

    const result = await UserStatePreference.upsertMany({
      userId: 7,
      states: [
        {
          namespace: "thread.read-state",
          scope: "thread:ws-a:thread-a",
          mutationOperation: "merge",
          mutationPayload: { cursor: 30, messageId: 30 },
        },
      ],
    });

    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(mockSyncV2.recordNodeChange).not.toHaveBeenCalled();
    expect(result[0].value.cursor).toBe(40);
  });

  test("database guard rejects a losing concurrent cursor without stale Outbox", async () => {
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([
          {
            userId: 7,
            namespace: "thread.read-state",
            scope: "thread:ws-a:thread-a",
            value: { cursor: 20 },
            version: "1",
          },
        ])
        .mockResolvedValueOnce([
          {
            userId: 7,
            namespace: "thread.read-state",
            scope: "thread:ws-a:thread-a",
            value: { cursor: 30, messageId: 30 },
            version: "1",
          },
        ]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      sync_nodes: {
        findUnique: jest.fn().mockResolvedValue({
          stateVersion: 6,
          contentHash: "hash:read-30",
        }),
      },
    };
    mockPrisma.$transaction.mockImplementation((callback) => callback(tx));

    const result = await UserStatePreference.upsertMany({
      userId: 7,
      states: [
        {
          namespace: "thread.read-state",
          scope: "thread:ws-a:thread-a",
          value: { cursor: 25, messageId: 25 },
        },
      ],
    });

    expect(tx.$executeRawUnsafe.mock.calls[0][0]).toContain(
      'COALESCE("user_state_preferences"."monotonicCursor", 0)'
    );
    expect(tx.$executeRawUnsafe.mock.calls[0][0]).not.toContain("json_extract");
    expect(tx.$executeRawUnsafe.mock.calls[0]).toContain(25);
    expect(result[0]).toEqual(
      expect.objectContaining({ value: { cursor: 30, messageId: 30 } })
    );
    expect(mockSyncV2.recordNodeChange).not.toHaveBeenCalled();
  });
});
