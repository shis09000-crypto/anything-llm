const mockExecuteRawUnsafe = jest.fn();
const mockQueryRawUnsafe = jest.fn();

jest.mock("../../utils/prisma", () => ({
  $executeRawUnsafe: mockExecuteRawUnsafe,
  $queryRawUnsafe: mockQueryRawUnsafe,
}));

function setupQueryMock() {
  mockQueryRawUnsafe.mockImplementation((sql, ...params) => {
    if (sql.includes('FROM "workspace_documents"')) {
      return Promise.resolve([
        {
          docId: params[1],
          filename: `${params[1]}.md`,
          docpath: `custom-documents/${params[1]}.json`,
        },
      ]);
    }
    if (sql.includes('FROM "WorkspaceSupplement"')) {
      return Promise.resolve([
        {
          id: 1,
          workspaceId: params[0],
          scopeType: params[1] || "book",
          primaryDocumentId: params[2] || "__workspace__",
          documentId: params[3] || "doc-guide",
          documentName: "guide.md",
          supplementKind: "structure_json",
          priority: 0,
          metadata: "{}",
          createdAt: "2026-05-27 01:00:00",
          updatedAt: "2026-05-27 01:00:00",
        },
      ]);
    }
    return Promise.resolve([]);
  });
}

describe("WorkspaceSupplement", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    setupQueryMock();
  });

  it("creates a workspace/book supplement binding without using nodeKey", async () => {
    const { WorkspaceSupplement } = require("../../models/workspaceSupplement");

    const result = await WorkspaceSupplement.upsert({
      workspaceId: 6,
      scopeType: "book",
      documentId: "doc-guide",
      supplementKind: "structure_json",
    });

    expect(result.success).toBe(true);
    expect(result.supplement).toEqual(
      expect.objectContaining({
        workspaceId: 6,
        scopeType: "book",
        documentId: "doc-guide",
        supplementKind: "structure_json",
      })
    );
    expect(mockExecuteRawUnsafe.mock.calls.map(([sql]) => sql).join("\n")).toContain(
      'ON CONFLICT("workspaceId", "scopeType", "primaryDocumentId", "documentId")'
    );
  });

  it("cleans workspace supplements when a document is deleted", async () => {
    const { WorkspaceSupplement } = require("../../models/workspaceSupplement");

    await WorkspaceSupplement.deleteForDocument({
      workspaceId: 6,
      documentId: "doc-guide",
    });

    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "WorkspaceSupplement"'),
      6,
      "doc-guide"
    );
  });
});
