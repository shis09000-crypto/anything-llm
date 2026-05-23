function priorityForIssue({
  issueType,
  workspaceImportanceScore = 0,
  traversalUsageCount = 0,
  rootConceptHit = false,
  hasEvidenceDependency = false,
} = {}) {
  let score = 10;
  const reasons = [];

  if (rootConceptHit) {
    score += 60;
    reasons.push("root concept");
  }
  if (Number(workspaceImportanceScore || 0) >= 0.35) {
    score += 40;
    reasons.push("high workspace importance");
  }
  if (Number(traversalUsageCount || 0) > 0) {
    score += Math.min(30, Number(traversalUsageCount) * 3);
    reasons.push("traversal usage");
  }
  if (hasEvidenceDependency) {
    score += 20;
    reasons.push("has evidence dependency");
  }

  const typeBoosts = {
    missing_graph_job: 25,
    stale_processing_job: 20,
    failed_graph_job: 18,
    missing_vector_cache: 12,
    suspicious_relation_density: 8,
    missing_graph_text: 5,
  };
  score += typeBoosts[issueType] || 0;

  if (reasons.length === 0) reasons.push(issueType || "standard repair");
  return {
    priorityScore: Number(score.toFixed(2)),
    priorityReason: reasons.join(", "),
  };
}

module.exports = { priorityForIssue };
