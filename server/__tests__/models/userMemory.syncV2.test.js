const mockTransaction = jest.fn();
const mockCandidateCreate = jest.fn();
const mockCandidateCount = jest.fn();
const mockCandidateLatest = jest.fn();
const mockUserFindFirst = jest.fn();
const mockRecordNodeChange = jest.fn();

const mockTx = {
  users: { findFirst: (...args) => mockUserFindFirst(...args) },
  memory_candidates: {
    create: (...args) => mockCandidateCreate(...args),
    count: (...args) => mockCandidateCount(...args),
    findFirst: (...args) => mockCandidateLatest(...args),
  },
};

jest.mock("../../utils/prisma", () => ({
  $transaction: (...args) => mockTransaction(...args),
}));

jest.mock("../../models/syncV2", () => ({
  SyncV2: {
    enabled: jest.fn().mockReturnValue(true),
    schemaReady: jest.fn().mockResolvedValue(true),
    recordNodeChange: (...args) => mockRecordNodeChange(...args),
  },
}));

jest.mock("../../utils/security/encryption", () => ({
  encryptSecret: jest.fn(),
  decryptSecret: jest.fn(),
}));

const { UserMemory } = require("../../models/userMemory");

describe("UserMemory Sync V2 transaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.mockImplementation(async (callback) => callback(mockTx));
    mockCandidateCreate.mockResolvedValue({
      id: 31,
      userId: 7001,
      category: "facts",
      title: "Project language",
      detail: "Uses TypeScript",
      createdAt: new Date("2026-07-17T12:00:00.000Z"),
    });
    mockCandidateCount.mockResolvedValue(1);
    mockCandidateLatest.mockResolvedValue({
      id: 31,
      createdAt: new Date("2026-07-17T12:00:00.000Z"),
    });
    mockUserFindFirst.mockResolvedValue({ id: 7 });
    mockRecordNodeChange.mockResolvedValue({
      node: { nodeKey: "users/7/memory/candidates", stateVersion: 2 },
      event: { seq: 21 },
    });
  });

  test("writes a candidate and event cursor through one transaction", async () => {
    await UserMemory.createCandidate(7001, {
      category: "facts",
      title: "Project language",
      detail: "Uses TypeScript",
      source: "conversation",
      confidence: "high",
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockCandidateCreate).toHaveBeenCalledTimes(1);
    expect(mockRecordNodeChange).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        nodeKey: "users/7/memory/candidates",
        eventType: "memory.candidate_created",
      })
    );
  });

  test("propagates an outbox failure so the enclosing transaction can roll back", async () => {
    mockRecordNodeChange.mockRejectedValueOnce(new Error("outbox_failed"));

    await expect(
      UserMemory.createCandidate(7001, {
        category: "facts",
        title: "Project language",
        detail: "Uses TypeScript",
      })
    ).rejects.toThrow("outbox_failed");
  });
});
