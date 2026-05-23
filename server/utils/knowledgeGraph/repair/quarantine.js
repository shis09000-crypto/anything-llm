const { KnowledgeGraph } = require("../../../models/knowledgeGraph");
const { priorityForIssue } = require("./prioritize");

function shouldQuarantineDensity({
  edgeCount = 0,
  lowConfidenceRatio = 0,
  relatedToRatio = 0,
}) {
  return (
    Number(edgeCount || 0) >= 10 &&
    (Number(lowConfidenceRatio || 0) >= 0.8 ||
      Number(relatedToRatio || 0) >= 0.9)
  );
}

async function quarantineIssue({
  workspaceId,
  documentId = "",
  chunkId = "",
  issueType = "suspicious_relation_density",
  reason,
  metadata = {},
}) {
  const priority = priorityForIssue({
    issueType,
    hasEvidenceDependency: true,
  });
  return await KnowledgeGraph.upsertRepairIssue({
    workspaceId,
    documentId,
    chunkId,
    issueType,
    status: "quarantined",
    ...priority,
    quarantineReason: reason,
    explainReason: reason,
    repairMethod: "quarantine",
    repairConfidence: "none",
    metadata,
  });
}

module.exports = {
  shouldQuarantineDensity,
  quarantineIssue,
};
