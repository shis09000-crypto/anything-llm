const {
  normalizeEvidenceSources,
  scoreOf,
} = require("../../../utils/quiz/evidence");

describe("quiz evidence ranking", () => {
  it("ranks by score, dedupes, and caps at top 10 chunks", () => {
    const sources = Array.from({ length: 14 }, (_, index) => ({
      docId: `doc-${index}`,
      chunkIndex: index,
      title: `Doc ${index}`,
      text: `Chunk ${index}`,
      score: index / 100,
    }));
    sources.push({
      docId: "doc-13",
      chunkIndex: 13,
      title: "Duplicate",
      text: "Chunk 13",
      score: 0.01,
    });

    const chunks = normalizeEvidenceSources(sources);

    expect(chunks).toHaveLength(10);
    expect(chunks[0].score).toBeGreaterThan(chunks[9].score);
    expect(chunks.map((chunk) => chunk.sourceRef.id)).toEqual(
      chunks.map((chunk) => chunk.id)
    );
  });

  it("reads common score field variants", () => {
    expect(scoreOf({ relevanceScore: 0.9 })).toBe(0.9);
    expect(scoreOf({ similarity: 0.8 })).toBe(0.8);
  });
});
