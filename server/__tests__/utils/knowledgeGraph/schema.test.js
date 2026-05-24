const {
  normalizeExtractionResult,
} = require("../../../utils/knowledgeGraph/schema");
const {
  detectPromptDomain,
  buildExtractionPrompt,
} = require("../../../utils/knowledgeGraph/promptRegistry");
const {
  normalizeRelationType,
} = require("../../../utils/knowledgeGraph/relationOntology");
const {
  boundedTraversalOptions,
} = require("../../../utils/knowledgeGraph/traversal");
const { boundedPathOptions } = require("../../../utils/knowledgeGraph/path");
const {
  graphAwareRerank,
} = require("../../../utils/knowledgeGraph/graphAwareRerank");

describe("knowledge graph utilities", () => {
  it("repairs and normalizes malformed extraction JSON", () => {
    const result = normalizeExtractionResult(`{
      entities: [
        { name: "DNA helicase", type: "protein", summary: "Unwinds DNA" },
        { name: "replication fork", type: "process" },
      ],
      relations: [
        { source: "DNA helicase", target: "replication fork", relation: "acts_at", confidence: 1.4 },
        { source: "missing", target: "replication fork", relation: "related_to" },
      ],
    }`);

    expect(result.entities).toHaveLength(2);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toEqual(
      expect.objectContaining({
        relation: "acts_at",
        confidence: 1,
      })
    );
  });

  it("chooses domain prompts using deterministic hints", () => {
    expect(
      detectPromptDomain({
        text: "Histone acetylation regulates chromatin and gene expression.",
      })
    ).toBe("biology");
    expect(
      detectPromptDomain({
        filePath: "src/api/routes.js",
        text: "This function implements an endpoint.",
      })
    ).toBe("code");
    expect(
      buildExtractionPrompt({ text: "revenue margin", domain: "finance" })
    ).toContain("companies, metrics, events");
  });

  it("normalizes relation aliases and downgrades unknown labels", () => {
    expect(normalizeRelationType("requires").relationType).toBe("depends_on");
    expect(normalizeRelationType("totally custom relation").relationType).toBe(
      "related_to"
    );
  });

  it("bounds traversal options", () => {
    const options = boundedTraversalOptions({
      maxDepth: 99,
      maxExpandedNodes: 999,
      confidenceCutoff: 2,
      perNodeFanout: 99,
      includeEvidence: true,
    });
    expect(options).toEqual({
      maxDepth: 3,
      maxExpandedNodes: 100,
      confidenceCutoff: 1,
      perNodeFanout: 20,
      includeEvidence: true,
    });
  });

  it("bounds multi-hop reasoning path options", () => {
    const options = boundedPathOptions({
      maxDepth: 99,
      limit: 99,
      confidenceCutoff: -1,
      perNodeFanout: 99,
      includeEvidence: false,
    });
    expect(options).toEqual({
      maxDepth: 4,
      limit: 5,
      confidenceCutoff: 0,
      perNodeFanout: 20,
      includeEvidence: false,
    });
  });

  it("combines vector and graph signals for rerank without replacing vector score", () => {
    const ranked = graphAwareRerank(
      [
        { chunkId: "a", score: 0.9 },
        { chunkId: "b", score: 0.7 },
      ],
      {
        b: { graphProximity: 1, edgeConfidence: 1, conceptOverlap: 1 },
      }
    );
    expect(ranked[0].chunkId).toBe("b");
    expect(ranked[0].rerankScore).toBeGreaterThan(ranked[0].score * 0.7);
  });
});
