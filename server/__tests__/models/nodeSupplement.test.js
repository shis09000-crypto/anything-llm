const mockExecuteRawUnsafe = jest.fn();
const mockQueryRawUnsafe = jest.fn();

jest.mock("../../utils/prisma", () => ({
  $executeRawUnsafe: mockExecuteRawUnsafe,
  $queryRawUnsafe: mockQueryRawUnsafe,
}));

jest.mock("../../models/knowledgeGraph", () => ({
  KnowledgeGraph: {
    canonicalKey: (value = "") =>
      String(value || "")
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
  },
}));

function setupQueryMock(rows = []) {
  mockQueryRawUnsafe.mockImplementation((sql, ...params) => {
    if (sql.includes('FROM "KnowledgeNode"')) {
      const nodeId = params[1] || 101;
      return Promise.resolve([
        {
          id: nodeId,
          canonicalName: nodeId === 202 ? "Arche" : "Thales",
          canonicalKey: nodeId === 202 ? "arche" : "thales",
          entityType: nodeId === 202 ? "concept" : "person",
          displayNameZh: nodeId === 202 ? "本原" : "泰勒斯",
          displayNameEn: nodeId === 202 ? "Arche" : "Thales",
        },
      ]);
    }
    if (sql.includes('FROM "workspace_documents"')) {
      const documentId = params[1];
      return Promise.resolve([
        {
          docId: documentId,
          filename: `${documentId}.md`,
          docpath: `custom-documents/${documentId}.json`,
        },
      ]);
    }
    if (
      sql.includes('FROM "NodeSupplement"') &&
      sql.includes('AND "documentId" = ?')
    ) {
      return Promise.resolve([
        {
          id: 1,
          workspaceId: params[0],
          nodeId: 101,
          nodeKey: params[1],
          nodeLabel: "泰勒斯",
          nodeType: "person",
          documentId: params[2],
          documentName: `${params[2]}.md`,
          priority: 0,
          metadata: "{}",
          createdAt: "2026-05-27T00:00:00.000Z",
          updatedAt: "2026-05-27T00:00:00.000Z",
        },
      ]);
    }
    if (sql.includes('FROM "NodeSupplement"')) {
      return Promise.resolve(
        rows.filter((row) => {
          if (params[0] && Number(row.workspaceId) !== Number(params[0]))
            return false;
          if (params[1] && !params.slice(1).includes(row.nodeKey)) return false;
          return true;
        })
      );
    }
    return Promise.resolve([]);
  });
}

describe("NodeSupplement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupQueryMock();
  });

  it("creates a workspace-scoped node supplement binding", async () => {
    const { NodeSupplement } = require("../../models/nodeSupplement");

    const result = await NodeSupplement.upsert({
      workspaceId: 7,
      nodeKey: "person:thales",
      nodeLabel: "泰勒斯",
      nodeType: "person",
      documentId: "doc-thales",
    });

    expect(result.success).toBe(true);
    expect(result.supplement).toEqual(
      expect.objectContaining({
        workspaceId: 7,
        nodeKey: "kg:person:thales",
        documentId: "doc-thales",
      })
    );
    expect(
      mockExecuteRawUnsafe.mock.calls.some(([sql]) =>
        sql.includes('CREATE TABLE IF NOT EXISTS "NodeSupplement"')
      )
    ).toBe(true);
  });

  it("allows one node to bind multiple documents", async () => {
    const rows = [
      {
        id: 1,
        workspaceId: 7,
        nodeId: 101,
        nodeKey: "kg:person:thales",
        nodeLabel: "泰勒斯",
        nodeType: "person",
        documentId: "doc-a",
        documentName: "泰勒斯人物资料.md",
        priority: 0,
        metadata: "{}",
      },
      {
        id: 2,
        workspaceId: 7,
        nodeId: 101,
        nodeKey: "kg:person:thales",
        nodeLabel: "泰勒斯",
        nodeType: "person",
        documentId: "doc-b",
        documentName: "泰勒斯年表.md",
        priority: 0,
        metadata: "{}",
      },
    ];
    setupQueryMock(rows);
    const { NodeSupplement } = require("../../models/nodeSupplement");

    const supplements = await NodeSupplement.list({
      workspaceId: 7,
      nodeKey: "person:thales",
    });

    expect(supplements.map((item) => item.documentId)).toEqual([
      "doc-a",
      "doc-b",
    ]);
  });

  it("uses an upsert conflict key to avoid duplicate bindings", async () => {
    const { NodeSupplement } = require("../../models/nodeSupplement");

    await NodeSupplement.upsert({
      workspaceId: 7,
      nodeKey: "person:thales",
      documentId: "doc-thales",
    });

    const insertSql = mockExecuteRawUnsafe.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('INSERT INTO "NodeSupplement"'));
    expect(insertSql).toContain(
      'ON CONFLICT("workspaceId", "nodeKey", "documentId")'
    );
  });

  it("cleans bindings for a deleted workspace document", async () => {
    const { NodeSupplement } = require("../../models/nodeSupplement");

    await NodeSupplement.deleteForDocument({
      workspaceId: 7,
      documentId: "doc-thales",
    });

    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
      'DELETE FROM "NodeSupplement" WHERE "workspaceId" = ? AND "documentId" = ?',
      7,
      "doc-thales"
    );
  });

  it("keeps bindings isolated by workspace", async () => {
    setupQueryMock([
      {
        id: 1,
        workspaceId: 7,
        nodeId: 101,
        nodeKey: "kg:person:thales",
        nodeLabel: "泰勒斯",
        nodeType: "person",
        documentId: "doc-a",
        documentName: "A.md",
        priority: 0,
        metadata: "{}",
      },
      {
        id: 2,
        workspaceId: 8,
        nodeId: 101,
        nodeKey: "kg:person:thales",
        nodeLabel: "泰勒斯",
        nodeType: "person",
        documentId: "doc-b",
        documentName: "B.md",
        priority: 0,
        metadata: "{}",
      },
    ]);
    const { NodeSupplement } = require("../../models/nodeSupplement");

    const supplements = await NodeSupplement.list({
      workspaceId: 8,
      nodeKey: "person:thales",
    });

    expect(supplements).toHaveLength(1);
    expect(supplements[0].documentId).toBe("doc-b");
  });
});
