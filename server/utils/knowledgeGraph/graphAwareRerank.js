function graphAwareRerank(candidates = [], graphSignals = {}) {
  return [...candidates]
    .map((candidate) => {
      const chunkId = candidate.chunkId || candidate.id || candidate.vectorId;
      const signal = graphSignals[chunkId] || {};
      const vectorScore = Number(candidate.score ?? candidate.similarity ?? 0);
      const graphProximity = Number(signal.graphProximity || 0);
      const edgeConfidence = Number(signal.edgeConfidence || 0);
      const conceptOverlap = Number(signal.conceptOverlap || 0);
      const graphScore =
        graphProximity * 0.35 + edgeConfidence * 0.35 + conceptOverlap * 0.3;
      return {
        ...candidate,
        graphScore,
        rerankScore: vectorScore * 0.7 + graphScore * 0.3,
      };
    })
    .sort((a, b) => b.rerankScore - a.rerankScore);
}

module.exports = { graphAwareRerank };
