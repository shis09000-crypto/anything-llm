const { lazyDataAccessProperty } = require("../dataAccess/lazyFacade");
const KnowledgeGraph = lazyDataAccessProperty("knowledgeGraph", "model");

async function upsertConceptChunkMap({
  workspaceId,
  nodeId,
  documentId,
  chunkId,
  relevanceScore = 0.5,
  mentionCount = 1,
}) {
  return await KnowledgeGraph.upsertConceptChunk({
    workspaceId,
    nodeId,
    documentId,
    chunkId,
    relevanceScore,
    mentionCount,
  });
}

module.exports = { upsertConceptChunkMap };
