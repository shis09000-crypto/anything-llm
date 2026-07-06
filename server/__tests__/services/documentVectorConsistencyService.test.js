const path = require("path");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage");

const mockDataAccess = {
  document: {
    forWorkspace: jest.fn(),
  },
  documentVector: {
    where: jest.fn(),
  },
  documentIndexStatus: {
    forWorkspace: jest.fn(),
  },
};

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: mockDataAccess,
}));

jest.mock("../../utils/safety", () => ({
  safeReadJsonFile: jest.fn(() => ({ ok: true })),
}));

const {
  DocumentVectorConsistencyService,
} = require("../../services/documentVectorConsistencyService");

describe("DocumentVectorConsistencyService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("diagnostics reads documents, vectors, and index statuses through DataAccessCenter", async () => {
    mockDataAccess.document.forWorkspace.mockResolvedValueOnce([
      {
        docId: "doc-1",
        docpath: "missing/doc.json",
        filename: "doc.json",
      },
    ]);
    mockDataAccess.documentVector.where.mockResolvedValueOnce([]);
    mockDataAccess.documentIndexStatus.forWorkspace.mockResolvedValueOnce([
      {
        docId: "doc-1",
        filePath: "missing/doc.json",
        indexStatus: "pending",
        updatedAt: "2026-07-06T00:00:00.000Z",
      },
    ]);

    const result =
      await DocumentVectorConsistencyService.workspaceRobustnessDiagnostics({
        id: 3,
        slug: "research",
      });

    expect(mockDataAccess.document.forWorkspace).toHaveBeenCalledWith(3);
    expect(mockDataAccess.documentVector.where).toHaveBeenCalledWith({
      docId: { in: ["doc-1"] },
    });
    expect(mockDataAccess.documentIndexStatus.forWorkspace).toHaveBeenCalledWith(
      3
    );
    expect(result.summary).toMatchObject({
      workspaceDocuments: 1,
      vectorRows: 0,
      indexStatuses: 1,
      dbWithoutVector: 1,
      stuckIndexStatuses: 1,
    });
    expect(result.issues.dbWithoutVector).toEqual([
      {
        docId: "doc-1",
        docpath: "missing/doc.json",
        filename: "doc.json",
      },
    ]);
  });

  test("repair plan maps issues to non-destructive owner actions", () => {
    const plan = DocumentVectorConsistencyService.buildRepairPlan({
      workspace: { id: 3, slug: "research" },
      issues: {
        dbWithoutFile: ["missing/doc.json"],
        statusWithoutDb: ["orphan/doc.json"],
        dbWithoutVector: [{ docId: "doc-1", docpath: "missing/doc.json" }],
        corruptFiles: [{ docpath: "bad/doc.json", error: "parse_error" }],
        stuckIndexStatuses: [
          { docId: "doc-2", filePath: "stuck/doc.json", indexStatus: "pending" },
        ],
      },
    });

    expect(plan.vector).toMatchObject({
      provider: expect.any(String),
      namespace: expect.any(String),
    });
    expect(plan.counts.actions).toBe(5);
    expect(plan.actions.every((action) => action.destructive === false)).toBe(
      true
    );
    expect(plan.actions.map((action) => action.type)).toEqual([
      "mark_document_missing",
      "mark_index_status_deleted",
      "enqueue_reembed",
      "quarantine_or_restore_document_json",
      "reset_stuck_index_status",
    ]);
  });
});
