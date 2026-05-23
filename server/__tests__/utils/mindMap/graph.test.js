const { normalizeMindMapSchema } = require("../../../utils/mindMap/schema");
const { relationColor } = require("../../../utils/mindMap/graph");

describe("graph-backed mind map helpers", () => {
  it("preserves graph node and edge metadata during schema normalization", () => {
    const schema = normalizeMindMapSchema({
      title: "Knowledge Graph",
      layout: "tree",
      theme: "napkin",
      nodes: [
        {
          id: "kg-1",
          label: "Chromatin",
          level: 0,
          sourceType: "graph",
          sourceNodeId: 1,
          aliases: ["chromatin fiber"],
          evidenceCount: 3,
          topChunks: [{ chunkId: "vector-1", documentId: "doc-1" }],
          importanceScore: 0.8,
          workspaceImportanceScore: 0.7,
          recentImportanceScore: 0.2,
          collapsedByDefault: false,
          size: "root",
        },
        {
          id: "kg-2",
          label: "HP1",
          level: 1,
          parentId: "kg-1",
          sourceType: "graph",
          sourceNodeId: 2,
          collapsedByDefault: true,
        },
      ],
      edges: [
        {
          id: "kg-edge-1",
          source: "kg-1",
          target: "kg-2",
          label: "regulates",
          relationType: "regulates",
          confidence: 0.91,
          weight: 2,
          evidenceCount: 2,
          documentIds: ["doc-1"],
          chunkIds: ["vector-1"],
          evidence: [{ chunkId: "vector-1", snippet: "HP1 regulates chromatin." }],
          color: relationColor("regulates"),
        },
      ],
    });

    expect(schema.nodes[0]).toEqual(
      expect.objectContaining({
        sourceType: "graph",
        sourceNodeId: 1,
        aliases: ["chromatin fiber"],
        evidenceCount: 3,
        importanceScore: 0.8,
        workspaceImportanceScore: 0.7,
        recentImportanceScore: 0.2,
        size: "root",
      })
    );
    expect(schema.nodes[1].collapsedByDefault).toBe(true);
    expect(schema.edges[0]).toEqual(
      expect.objectContaining({
        relationType: "regulates",
        confidence: 0.91,
        weight: 2,
        evidenceCount: 2,
        documentIds: ["doc-1"],
        chunkIds: ["vector-1"],
        color: "#22C55E",
      })
    );
  });

  it("maps ontology relation types to stable visual colors", () => {
    expect(relationColor("causes")).toBe("#F97316");
    expect(relationColor("part_of")).toBe("#3B82F6");
    expect(relationColor("depends_on")).toBe("#8B5CF6");
    expect(relationColor("regulates")).toBe("#22C55E");
    expect(relationColor("related_to")).toBe("#94A3B8");
    expect(relationColor("unknown_relation")).toBe("#64748B");
  });
});
