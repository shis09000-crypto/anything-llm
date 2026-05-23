const { KnowledgeGraph } = require("../../models/knowledgeGraph");
const {
  GRAPH_VERSION,
  EXTRACTION_PROMPT_VERSION,
  MERGE_LOGIC_VERSION,
} = require("./constants");
const { normalizeRelationType } = require("./relationOntology");

async function createKnowledgeEdge({
  workspaceId,
  sourceNode,
  targetNode,
  relation,
  documentId,
  chunkId,
  extractionJobId = null,
}) {
  const normalized = normalizeRelationType(relation.relation);
  return await KnowledgeGraph.upsertEdgeWithEvidence({
    workspaceId,
    sourceNodeId: sourceNode.id,
    targetNodeId: targetNode.id,
    relationType: normalized.relationType,
    relationLabel: normalized.relationLabel,
    confidence: relation.confidence,
    documentId,
    chunkId,
    snippet: relation.snippet,
    extractionJobId,
    extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
    mergeLogicVersion: MERGE_LOGIC_VERSION,
    relationOntologyVersion: normalized.relationOntologyVersion,
    graphVersion: GRAPH_VERSION,
  });
}

module.exports = { createKnowledgeEdge };
