const {
  NODE_METRICS_FORMULA_VERSION,
  calculateRadarScores,
  buildReasons,
  ageDecay,
  relationPenalty,
} = require("../../../utils/knowledgeGraph/nodeMetrics");

function baseInputs(overrides = {}) {
  return {
    evidenceCount: 2,
    edgeCount: 2,
    documentCount: 1,
    chunkCount: 2,
    relationTypeCount: 1,
    conflictCount: 0,
    averageConfidence: 0.55,
    averageTrustScore: 0.5,
    relatedToRatio: 0.25,
    recentEvidenceCount: 1,
    usageCount: 1,
    recentUsageCount: 1,
    decayedUsageScore: 1,
    decayedFreshnessScore: 1,
    neighborCount: 2,
    totalEdgeWeight: 2,
    evidenceDocumentCount: 1,
    evidenceSpanDays: 5,
    twoHopPathCount: 1,
    pinnedDocumentRatio: 0,
    watchedDocumentRatio: 0,
    averageChunkCompleteness: 0.5,
    documentCoverageRatio: 0.5,
    workspaceImportanceScore: 0.4,
    nodeFreshnessScore: 0.7,
    ...overrides,
  };
}

describe("knowledge node metrics utilities", () => {
  it("normalizes all scores to 0-100 integers", () => {
    const scores = calculateRadarScores(baseInputs());
    for (const value of Object.values(scores)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("adds formulaVersion and explainable reasons for every dimension", () => {
    const scores = calculateRadarScores(baseInputs());
    const reasons = buildReasons(scores, baseInputs());
    for (const item of Object.values(reasons)) {
      expect(item.formulaVersion).toBe(NODE_METRICS_FORMULA_VERSION);
      expect(item.reasons.length).toBeGreaterThan(0);
      expect(item.labelZh).toBeTruthy();
    }
  });

  it("increases evidence and document driven dimensions with stronger inputs", () => {
    const low = calculateRadarScores(baseInputs());
    const high = calculateRadarScores(
      baseInputs({
        evidenceCount: 10,
        averageTrustScore: 0.9,
        documentCount: 5,
        chunkCount: 12,
        recentEvidenceCount: 5,
        decayedFreshnessScore: 5,
      })
    );

    expect(high.evidenceStrength).toBeGreaterThan(low.evidenceStrength);
    expect(high.crossDocumentPresence).toBeGreaterThan(
      low.crossDocumentPresence
    );
    expect(high.freshness).toBeGreaterThan(low.freshness);
  });

  it("penalizes weak related_to-heavy graphs", () => {
    const diverse = calculateRadarScores(
      baseInputs({ relationTypeCount: 5, relatedToRatio: 0.1, edgeCount: 8 })
    );
    const weak = calculateRadarScores(
      baseInputs({ relationTypeCount: 5, relatedToRatio: 0.95, edgeCount: 8 })
    );

    expect(weak.relationDiversity).toBeLessThan(diverse.relationDiversity);
    expect(weak.knowledgeConnectivity).toBeLessThan(
      diverse.knowledgeConnectivity
    );
    expect(relationPenalty(0.95)).toBeLessThan(relationPenalty(0.1));
  });

  it("lowers conflictSafety as conflicts increase", () => {
    const safe = calculateRadarScores(baseInputs({ conflictCount: 0 }));
    const risky = calculateRadarScores(
      baseInputs({ conflictCount: 4, edgeCount: 4 })
    );

    expect(risky.conflictSafety).toBeLessThan(safe.conflictSafety);
  });

  it("decays older usage and freshness signals", () => {
    const recent = ageDecay(new Date(), 30);
    const old = ageDecay(new Date(Date.now() - 120 * 86_400_000), 30);
    expect(recent).toBeGreaterThan(old);
  });
});
