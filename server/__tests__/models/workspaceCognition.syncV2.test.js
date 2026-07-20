const mockFindUnique = jest.fn();
const mockCreate = jest.fn();
const mockTransaction = jest.fn();
const mockRecordNodeChange = jest.fn();

const mockTx = {
  workspace_cognitive_assertions: {
    create: (...args) => mockCreate(...args),
  },
};

jest.mock("../../utils/prisma", () => ({
  workspace_cognitive_assertions: {
    findUnique: (...args) => mockFindUnique(...args),
  },
  $transaction: (...args) => mockTransaction(...args),
}));

jest.mock("../../models/syncV2", () => ({
  SyncV2: {
    enabled: jest.fn().mockReturnValue(true),
    schemaReady: jest.fn().mockResolvedValue(true),
    recordNodeChange: (...args) => mockRecordNodeChange(...args),
  },
}));

jest.mock("../../models/workspaceCognitionBatch", () => ({}));

const { WorkspaceCognition } = require("../../models/workspaceCognition");

describe("WorkspaceCognition Sync V2 transaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUnique.mockResolvedValue(null);
    mockCreate.mockImplementation(async ({ data }) => ({
      id: 22,
      ...data,
      createdAt: new Date("2026-07-17T12:00:00.000Z"),
      updatedAt: new Date("2026-07-17T12:00:00.000Z"),
    }));
    mockRecordNodeChange.mockResolvedValue({ event: { seq: 32 } });
    mockTransaction.mockImplementation(async (callback) => callback(mockTx));
  });

  test("creates an assertion and cursor event in one transaction", async () => {
    const result = await WorkspaceCognition.createAssertion({
      workspaceId: 4,
      assertionType: "decision",
      statement: "Ship the sync protocol",
    });

    expect(result.created).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordNodeChange).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        nodeKey: "workspaces/4/cognition",
        eventType: "cognition.assertion_created",
      })
    );
    expect(JSON.stringify(mockRecordNodeChange.mock.calls[0])).not.toContain(
      "Ship the sync protocol"
    );
  });

  test("propagates an outbox failure so assertion creation rolls back", async () => {
    mockRecordNodeChange.mockRejectedValueOnce(new Error("outbox_failed"));

    await expect(
      WorkspaceCognition.createAssertion({
        workspaceId: 4,
        assertionType: "decision",
        statement: "Ship the sync protocol",
      })
    ).rejects.toThrow("outbox_failed");
  });
});
