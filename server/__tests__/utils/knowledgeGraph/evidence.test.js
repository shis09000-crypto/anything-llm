const {
  extractSnippet,
  scoreEvidence,
  relationStability,
  detectConflicts,
  driftSummary,
  clusterEvidenceText,
  whyNoEvidence,
  sourceAuthorityScore,
} = require("../../../utils/knowledgeGraph/evidence");

describe("knowledge graph evidence utilities", () => {
  it("extracts evidence snippets from original text without rewriting", () => {
    const chunkText =
      "Chromatin remodeling changes nucleosome positioning. HP1 binds heterochromatin. Gene expression can be reduced.";
    const result = extractSnippet({
      chunkText,
      terms: ["HP1", "heterochromatin"],
    });

    expect(result.snippet).toContain("HP1 binds heterochromatin.");
    expect(result.fullChunk).toBe(chunkText);
    expect(result.highlightTerms).toContain("HP1");
  });

  it("returns explainable trust score and breakdown", () => {
    const score = scoreEvidence({
      confidence: 0.9,
      relationWeight: 3,
      conceptImportance: 0.8,
      freshness: 0.8,
      multiSourceSupport: 0.7,
      chunkQuality: 0.9,
      sourceAuthority: 0.75,
      relationStability: 0.8,
      conflictPenalty: 0,
    });

    expect(score.trustLevel).toBe("high");
    expect(score.trustBreakdown).toEqual(
      expect.objectContaining({
        confidence: 0.9,
        sourceAuthority: 0.75,
        relationStability: 0.8,
      })
    );
    expect(score.trustReasons.length).toBeGreaterThan(0);
  });

  it("distinguishes stable and emerging relations", () => {
    const now = Date.now();
    const stable = relationStability([
      {
        documentId: "doc-1",
        confidence: 0.9,
        createdAt: new Date(now - 40 * 86_400_000),
      },
      {
        documentId: "doc-2",
        confidence: 0.85,
        createdAt: new Date(now - 10 * 86_400_000),
      },
      { documentId: "doc-3", confidence: 0.8, createdAt: new Date(now) },
    ]);
    const emerging = relationStability([
      { documentId: "doc-1", confidence: 0.9, createdAt: new Date(now) },
    ]);

    expect(stable.stabilityLevel).toBe("stable");
    expect(emerging.stabilityLevel).toBe("emerging");
  });

  it("detects deterministic conflict severity", () => {
    const edge = {
      id: 1,
      workspaceId: 1,
      sourceNodeId: 10,
      targetNodeId: 11,
      relationType: "causes",
    };
    const conflicts = detectConflicts(edge, [
      {
        id: 2,
        sourceNodeId: 11,
        targetNodeId: 10,
        relationType: "causes",
        confidence: 0.9,
      },
    ]);

    expect(conflicts[0].severity).toBe("severe");
  });

  it("classifies evidence cluster and no-evidence reasons", () => {
    expect(clusterEvidenceText("This mechanism regulates chromatin.")).toBe(
      "mechanism"
    );
    expect(whyNoEvidence({ total: 0 }).status).toBe("none");
    expect(whyNoEvidence({ total: 2, weak: true }).status).toBe("weak");
  });

  it("surfaces source authority reasons and drift watch state", () => {
    const authority = sourceAuthorityScore({
      document: {
        pinned: true,
        metadata: JSON.stringify({ title: "Paper", source: "local" }),
      },
      chunkText: "A".repeat(400),
      coverage: 0.8,
    });
    const drift = driftSummary({
      evidenceRows: [
        { confidence: 0.9, createdAt: new Date(Date.now() - 10_000) },
        { confidence: 0.4, createdAt: new Date() },
      ],
      conflicts: [{ severity: "mild" }],
    });

    expect(authority.sourceAuthority).toBeGreaterThan(0.7);
    expect(authority.sourceAuthorityReasons.length).toBeGreaterThan(0);
    expect(drift.driftLevel).toBe("degrading");
  });
});
