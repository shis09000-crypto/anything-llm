const { KnowledgeGraph } = require("../../models/knowledgeGraph");
const {
  ENABLE_NODE_EMBEDDINGS,
  MERGE_LOGIC_VERSION,
  NODE_EMBEDDING_VERSION,
} = require("./constants");

async function maybeEmbedNode({ LLMConnector = null, nodeText = "" }) {
  if (!ENABLE_NODE_EMBEDDINGS || !LLMConnector?.embedTextInput) return {};
  const embedding = await LLMConnector.embedTextInput(nodeText).catch(
    () => null
  );
  if (!embedding) return {};
  return {
    embedding,
    embeddingModel: process.env.EMBEDDING_MODEL_PREF || "system-embedder",
    embeddingVersion: NODE_EMBEDDING_VERSION,
  };
}

async function mergeKnowledgeNode({
  workspaceId,
  entity,
  LLMConnector = null,
}) {
  const embeddingData = await maybeEmbedNode({
    LLMConnector,
    nodeText: `${entity.name}\n${entity.summary || ""}`,
  });
  return await KnowledgeGraph.upsertNode({
    workspaceId,
    name: entity.name,
    entityType: entity.type || "concept",
    summary: entity.summary || null,
    aliases: entity.aliases || [],
    mergeLogicVersion: MERGE_LOGIC_VERSION,
    ...embeddingData,
  });
}

module.exports = { mergeKnowledgeNode, maybeEmbedNode };
