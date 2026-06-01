const mockList = jest.fn();
const mockFindMany = jest.fn();
const mockFileData = jest.fn();

jest.mock("../../../models/workspaceSupplement", () => ({
  WorkspaceSupplement: {
    list: mockList,
  },
}));

jest.mock("../../../utils/prisma", () => ({
  workspace_documents: {
    findMany: mockFindMany,
  },
}));

jest.mock("../../../utils/files", () => ({
  fileData: mockFileData,
}));

const baseSupplements = [
  {
    id: 1,
    workspaceId: 7,
    scopeType: "workspace",
    primaryDocumentId: null,
    documentId: "concepts",
    documentName: "Concepts",
    supplementKind: "concept_index",
    priority: 20,
    metadata: {},
    updatedAt: "2026-06-01 01:00:00",
  },
  {
    id: 2,
    workspaceId: 7,
    scopeType: "workspace",
    primaryDocumentId: null,
    documentId: "custom-a",
    documentName: "Exam notes",
    supplementKind: "other",
    priority: 10,
    metadata: {},
    updatedAt: "2026-06-01 02:00:00",
  },
  {
    id: 3,
    workspaceId: 7,
    scopeType: "workspace",
    primaryDocumentId: null,
    documentId: "custom-b",
    documentName: "Exam notes",
    supplementKind: "other",
    priority: 9,
    metadata: {},
    updatedAt: "2026-06-01 03:00:00",
  },
  {
    id: 4,
    workspaceId: 7,
    scopeType: "book",
    primaryDocumentId: "book-a",
    documentId: "book-guide",
    documentName: "Book guide",
    supplementKind: "reading_guide",
    priority: 30,
    metadata: {},
    updatedAt: "2026-06-01 04:00:00",
  },
  {
    id: 5,
    workspaceId: 7,
    scopeType: "book",
    primaryDocumentId: "book-b",
    documentId: "other-book-guide",
    documentName: "Other book guide",
    supplementKind: "reading_guide",
    priority: 100,
    metadata: {},
    updatedAt: "2026-06-01 05:00:00",
  },
  {
    id: 6,
    workspaceId: 7,
    scopeType: "workspace",
    primaryDocumentId: null,
    documentId: "structure",
    documentName: "Structure",
    supplementKind: "structure_json",
    priority: 1,
    metadata: {
      structureJsonValidation: { valid: true },
      parsedStructure: { primaryAxis: "人物" },
    },
    updatedAt: "2026-06-01 06:00:00",
  },
];

function setupFiles() {
  mockFindMany.mockImplementation(({ where }) =>
    Promise.resolve(
      where.docId.in.map((docId) => ({
        docId,
        docpath: `custom-documents/${docId}.json`,
      }))
    )
  );
  mockFileData.mockImplementation((docpath) => {
    const docId = docpath.replace("custom-documents/", "").replace(".json", "");
    const long = docId === "concepts" ? "A".repeat(5_000) : "";
    return Promise.resolve({
      pageContent: `${long}Content for ${docId}\n## Important ${docId}`,
    });
  });
}

describe("workspaceSupplementToolManifest", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockList.mockResolvedValue(baseSupplements);
    setupFiles();
  });

  it("builds a manifest with standard kinds and custom documents without exposing other as a kind", async () => {
    const {
      resolveWorkspaceSupplementToolManifest,
    } = require("../../../utils/knowledgeGraph/workspaceSupplementToolManifest");

    const manifest = await resolveWorkspaceSupplementToolManifest({
      workspaceId: 7,
    });

    expect(manifest.standardKinds.map((item) => item.kind)).toEqual([
      "structure_json",
      "concept_index",
    ]);
    expect(manifest.standardKinds.some((item) => item.kind === "other")).toBe(
      false
    );
    expect(manifest.customDocuments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          supplementId: 2,
          title: "Exam notes",
        }),
      ])
    );
    expect(
      manifest.standardKinds.find((item) => item.kind === "structure_json")
        .structureJsonValid
    ).toBe(true);
  });

  it("prefers matching book scope when primaryDocumentId is provided and avoids other books", async () => {
    const {
      resolveWorkspaceSupplementToolManifest,
    } = require("../../../utils/knowledgeGraph/workspaceSupplementToolManifest");

    const manifest = await resolveWorkspaceSupplementToolManifest({
      workspaceId: 7,
      primaryDocumentId: "book-a",
    });

    expect(manifest.standardKinds.map((item) => item.kind)).toContain(
      "reading_guide"
    );
    expect(JSON.stringify(manifest)).not.toContain("other-book-guide");
  });

  it("returns ambiguous_title for exact duplicate custom document titles", async () => {
    const {
      resolveWorkspaceSupplementToolContent,
    } = require("../../../utils/knowledgeGraph/workspaceSupplementToolManifest");

    const result = JSON.parse(
      await resolveWorkspaceSupplementToolContent({
        workspaceId: 7,
        mode: "document",
        documentTitle: "Exam notes",
      })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("ambiguous_title");
    expect(result.matches).toHaveLength(2);
  });

  it("re-reads the latest manifest so deleted supplements cannot be accessed by old ids", async () => {
    mockList
      .mockResolvedValueOnce(baseSupplements)
      .mockResolvedValueOnce(
        baseSupplements.filter((supplement) => supplement.id !== 2)
      );
    const {
      resolveWorkspaceSupplementToolManifest,
      resolveWorkspaceSupplementToolContent,
    } = require("../../../utils/knowledgeGraph/workspaceSupplementToolManifest");

    const manifest = await resolveWorkspaceSupplementToolManifest({
      workspaceId: 7,
    });
    expect(manifest.customDocuments.some((item) => item.supplementId === 2)).toBe(
      true
    );

    const result = JSON.parse(
      await resolveWorkspaceSupplementToolContent({
        workspaceId: 7,
        mode: "document",
        supplementId: 2,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("supplement_document_unavailable");
  });

  it("does not use query for retrieval and truncates long content with length metadata", async () => {
    const {
      resolveWorkspaceSupplementToolContent,
    } = require("../../../utils/knowledgeGraph/workspaceSupplementToolManifest");

    const result = JSON.parse(
      await resolveWorkspaceSupplementToolContent({
        workspaceId: 7,
        mode: "kind",
        supplementKind: "concept_index",
        query: "unused search text",
        limit: 3,
      })
    );

    expect(result.ok).toBe(true);
    expect(result.query).toBe("unused search text");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].truncated).toBe(true);
    expect(result.items[0].originalLength).toBeGreaterThan(
      result.items[0].returnedLength
    );
  });

  it("returns a clear one-call-per-turn limit message from the agent plugin", async () => {
    const {
      workspaceSupplementTool,
    } = require("../../../utils/agents/aibitat/plugins/workspace-supplement-tool");
    let registered = null;
    const aibitat = {
      handlerProps: { invocation: { workspace_id: 7 } },
      function(definition) {
        registered = definition;
      },
      introspect: jest.fn(),
      _workspaceSupplementToolCalls: 1,
      _agentEvents: [],
    };

    workspaceSupplementTool.plugin({ manifest: { hasSupplements: true } }).setup(
      aibitat
    );
    const result = JSON.parse(
      await registered.handler.call(registered, { mode: "kind" })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("tool_call_limit_exceeded");
    expect(result.message).toContain("do not request this tool again");
    expect(aibitat._agentEvents[0]).toEqual(
      expect.objectContaining({ status: "tool_call_limit_exceeded" })
    );
  });
});
