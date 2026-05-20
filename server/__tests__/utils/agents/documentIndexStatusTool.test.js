jest.mock("../../../models/workspace", () => ({
  Workspace: {
    get: jest.fn(),
  },
}));

jest.mock("../../../models/documents", () => ({
  Document: {
    forWorkspace: jest.fn(),
  },
}));

jest.mock("../../../models/documentIndexStatus", () => ({
  DocumentIndexStatus: {
    statuses: {
      pending: "pending",
      indexing: "indexing",
      indexed: "indexed",
      outdated: "outdated",
      failed: "failed",
      deleted: "deleted",
    },
    forWorkspace: jest.fn(),
    embeddingCountForDoc: jest.fn(),
  },
}));

const { Workspace } = require("../../../models/workspace");
const { Document } = require("../../../models/documents");
const {
  DocumentIndexStatus,
} = require("../../../models/documentIndexStatus");
const {
  documentIndexStatusTool,
} = require("../../../utils/agents/aibitat/plugins/document-index-status-tool");

function setupTool() {
  let tool = null;
  const aibitat = {
    handlerProps: {
      log: jest.fn(),
    },
    introspect: jest.fn(),
    function: (definition) => {
      tool = definition;
    },
  };
  documentIndexStatusTool.plugin().setup(aibitat);
  return { tool, aibitat };
}

describe("document_index_status_tool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Workspace.get.mockResolvedValue({ id: 1, slug: "demo" });
    Document.forWorkspace.mockResolvedValue([]);
    DocumentIndexStatus.forWorkspace.mockResolvedValue([]);
    DocumentIndexStatus.embeddingCountForDoc.mockResolvedValue(0);
  });

  it("returns workspace_not_found for an unknown workspace slug", async () => {
    Workspace.get.mockResolvedValue(null);
    const { tool } = setupTool();

    const result = JSON.parse(
      await tool.handler.call(tool, {
        action: "get_summary",
        workspaceSlug: "missing",
      })
    );

    expect(result.error).toBe("workspace_not_found");
  });

  it("lists workspace documents without status rows as unindexed", async () => {
    Document.forWorkspace.mockResolvedValue([
      { docId: "doc-1", docpath: "custom-documents/a.json" },
    ]);
    const { tool } = setupTool();

    const result = JSON.parse(
      await tool.handler.call(tool, {
        action: "list_unindexed",
        workspaceSlug: "demo",
      })
    );

    expect(result.count).toBe(1);
    expect(result.documents[0]).toEqual({
      filePath: "custom-documents/a.json",
      docId: "doc-1",
      indexStatus: "pending",
      indexedAt: null,
      errorMessage: "missing_status_row",
      chunkCount: 0,
      embeddingCount: 0,
    });
  });

  it("lists indexed documents", async () => {
    Document.forWorkspace.mockResolvedValue([
      { docId: "doc-1", docpath: "custom-documents/a.json" },
      { docId: "doc-2", docpath: "custom-documents/b.json" },
    ]);
    DocumentIndexStatus.forWorkspace.mockResolvedValue([
      {
        docId: "doc-1",
        filePath: "custom-documents/a.json",
        indexStatus: "indexed",
        indexedAt: new Date("2026-05-19T10:00:00.000Z"),
        errorMessage: null,
        chunkCount: 2,
        embeddingCount: 2,
      },
      {
        docId: "doc-2",
        filePath: "custom-documents/b.json",
        indexStatus: "failed",
        indexedAt: null,
        errorMessage: "boom",
        chunkCount: 0,
        embeddingCount: 0,
      },
    ]);
    const { tool } = setupTool();

    const result = JSON.parse(
      await tool.handler.call(tool, {
        action: "list_indexed",
        workspaceSlug: "demo",
      })
    );

    expect(result.count).toBe(1);
    expect(result.documents[0].filePath).toBe("custom-documents/a.json");
    expect(result.documents[0].indexStatus).toBe("indexed");
  });

  it("treats legacy completed documents with vectors as indexed when no status row exists", async () => {
    Document.forWorkspace.mockResolvedValue([
      {
        docId: "legacy-doc",
        docpath: "custom-documents/legacy.json",
        embeddingStatus: "completed",
      },
    ]);
    DocumentIndexStatus.embeddingCountForDoc.mockResolvedValue(3);
    const { tool } = setupTool();

    const indexed = JSON.parse(
      await tool.handler.call(tool, {
        action: "list_indexed",
        workspaceSlug: "demo",
      })
    );
    const unindexed = JSON.parse(
      await tool.handler.call(tool, {
        action: "list_unindexed",
        workspaceSlug: "demo",
      })
    );

    expect(indexed.count).toBe(1);
    expect(indexed.documents[0]).toMatchObject({
      filePath: "custom-documents/legacy.json",
      docId: "legacy-doc",
      indexStatus: "indexed",
      chunkCount: 3,
      embeddingCount: 3,
    });
    expect(unindexed.count).toBe(0);
  });

  it("gets status by docId", async () => {
    Document.forWorkspace.mockResolvedValue([
      { docId: "doc-1", docpath: "custom-documents/a.json" },
    ]);
    DocumentIndexStatus.forWorkspace.mockResolvedValue([
      {
        docId: "doc-1",
        filePath: "custom-documents/a.json",
        indexStatus: "outdated",
        indexedAt: new Date("2026-05-19T10:00:00.000Z"),
        errorMessage: "hash changed",
        chunkCount: 2,
        embeddingCount: 2,
      },
    ]);
    const { tool } = setupTool();

    const result = JSON.parse(
      await tool.handler.call(tool, {
        action: "get_status",
        workspaceSlug: "demo",
        docId: "doc-1",
      })
    );

    expect(result.document).toMatchObject({
      filePath: "custom-documents/a.json",
      docId: "doc-1",
      indexStatus: "outdated",
      errorMessage: "hash changed",
      chunkCount: 2,
      embeddingCount: 2,
    });
  });

  it("summarizes indexed, unindexed, indexing, outdated, failed, and deleted counts", async () => {
    Document.forWorkspace.mockResolvedValue([
      { docId: "doc-1", docpath: "indexed.json" },
      { docId: "doc-2", docpath: "indexing.json" },
      { docId: "doc-3", docpath: "outdated.json" },
      { docId: "doc-4", docpath: "failed.json" },
      { docId: "doc-5", docpath: "missing.json" },
    ]);
    DocumentIndexStatus.forWorkspace.mockResolvedValue([
      {
        docId: "doc-1",
        filePath: "indexed.json",
        indexStatus: "indexed",
        chunkCount: 1,
        embeddingCount: 1,
      },
      {
        docId: "doc-2",
        filePath: "indexing.json",
        indexStatus: "indexing",
      },
      {
        docId: "doc-3",
        filePath: "outdated.json",
        indexStatus: "outdated",
      },
      {
        docId: "doc-4",
        filePath: "failed.json",
        indexStatus: "failed",
        errorMessage: "embed failed",
      },
      {
        docId: "doc-6",
        filePath: "deleted.json",
        indexStatus: "deleted",
      },
    ]);
    const { tool } = setupTool();

    const result = JSON.parse(
      await tool.handler.call(tool, {
        action: "get_summary",
        workspaceSlug: "demo",
      })
    );

    expect(result.summary).toEqual({
      indexed: 1,
      unindexed: 3,
      indexing: 1,
      outdated: 1,
      failed: 1,
      deleted: 1,
      pending: 1,
      missingStatus: 1,
      totalCurrentDocuments: 5,
    });
  });
});
