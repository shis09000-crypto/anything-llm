const { KnowledgeGraph } = require("../../models/knowledgeGraph");

const DEFAULT_GRAPH_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

async function getGraphRetrievalCache({ workspaceId, conceptKey, params }) {
  return await KnowledgeGraph.getCache({ workspaceId, conceptKey, params });
}

async function setGraphRetrievalCache({
  workspaceId,
  conceptKey,
  params,
  result,
  ttlMs = DEFAULT_GRAPH_CACHE_TTL_MS,
}) {
  return await KnowledgeGraph.setCache({
    workspaceId,
    conceptKey,
    params,
    result,
    ttlMs,
  });
}

async function invalidateGraphRetrievalCache(workspaceId) {
  return await KnowledgeGraph.invalidateCache(workspaceId);
}

module.exports = {
  DEFAULT_GRAPH_CACHE_TTL_MS,
  getGraphRetrievalCache,
  setGraphRetrievalCache,
  invalidateGraphRetrievalCache,
};
