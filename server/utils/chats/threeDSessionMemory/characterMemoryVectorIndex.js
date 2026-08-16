const crypto = require("crypto");
const {
  getEmbeddingEngineSelection,
  getVectorDbClass,
} = require("../../helpers");

const TYPES = Object.freeze({
  user_model: {
    delegate: "athena_3d_character_user_model_entries",
    text: (row) => `${row.firstPersonInterpretation}\n${row.observation}`,
  },
  memory: {
    delegate: "athena_3d_character_memories",
    text: (row) => `${row.firstPersonMemory}\n${row.eventSummary}`,
  },
  growth: {
    delegate: "athena_3d_character_growth_nodes",
    text: (row) => row.firstPersonSummary,
  },
  milestone: {
    delegate: "athena_3d_character_emotional_milestones",
    text: (row) => row.firstPersonMemory,
  },
});

function profileNamespace(profileId) {
  const hash = crypto
    .createHash("sha256")
    .update(String(profileId))
    .digest("hex");
  return `athena-character-memory-${hash}`;
}

function embeddingIdentity() {
  return {
    model: process.env.EMBEDDING_MODEL_PREF || "system-default",
    version: process.env.EMBEDDING_ENGINE || "system-default",
  };
}

async function indexPending(client, { limit = 16 } = {}) {
  const VectorDb = getVectorDbClass();
  const identity = embeddingIdentity();
  const result = { inspected: 0, indexed: 0, failed: 0 };
  for (const [type, config] of Object.entries(TYPES)) {
    if (result.inspected >= limit) break;
    const delegate = client[config.delegate];
    const rows = await delegate.findMany({
      where: {
        indexStatus: { in: ["pending", "failed"] },
        indexAttempts: { lt: 5 },
        status: "active",
      },
      orderBy: { lastUpdatedAt: "asc" },
      take: limit - result.inspected,
    });
    for (const row of rows) {
      result.inspected += 1;
      const docId = `character-memory-${type}-${row.id}`;
      try {
        await delegate.update({
          where: { id: row.id },
          data: { indexStatus: "indexing", indexAttempts: { increment: 1 } },
        });
        await VectorDb.deleteDocumentFromNamespace(
          profileNamespace(row.profileId),
          docId
        ).catch(() => false);
        const outcome = await VectorDb.addDocumentToNamespace(
          profileNamespace(row.profileId),
          {
            docId,
            pageContent: config.text(row),
            sourceType: "athena_character_memory",
            objectType: type,
            objectId: row.id,
            version: 1,
          },
          null,
          true
        );
        if (!outcome?.vectorized)
          throw new Error(
            outcome?.error || "character_memory_vector_write_failed"
          );
        await delegate.update({
          where: { id: row.id },
          data: {
            indexStatus: "indexed",
            embeddingModel: identity.model,
            embeddingVersion: identity.version,
            indexedAt: new Date(),
            indexError: null,
          },
        });
        result.indexed += 1;
      } catch (error) {
        await delegate
          .update({
            where: { id: row.id },
            data: {
              indexStatus: "failed",
              indexError: String(error.message || error).slice(0, 1000),
            },
          })
          .catch(() => {});
        result.failed += 1;
      }
    }
  }
  return result;
}

async function semanticRecall(profileId, query, { topN = 32 } = {}) {
  const VectorDb = getVectorDbClass();
  const EmbedderEngine = getEmbeddingEngineSelection();
  const result = await VectorDb.performSimilaritySearch({
    namespace: profileNamespace(profileId),
    input: String(query || ""),
    LLMConnector: {
      embedTextInput: (input) => EmbedderEngine.embedTextInput(input),
    },
    similarityThreshold: 0.1,
    topN,
    filterIdentifiers: [],
  });
  if (result?.message) throw new Error(String(result.message));
  return (result?.sources || [])
    .map((source, index) => ({
      type: source.objectType || source.metadata?.objectType,
      id: source.objectId || source.metadata?.objectId,
      semantic_score: Number(
        source.score ??
          source.similarity ??
          Math.max(0, 1 - index / Math.max(1, topN))
      ),
    }))
    .filter((entry) => entry.type && entry.id);
}

async function deleteProfileIndex(client, profileId) {
  const VectorDb = getVectorDbClass();
  for (const [type, config] of Object.entries(TYPES)) {
    const rows = await client[config.delegate].findMany({
      where: { profileId },
      select: { id: true },
    });
    for (const row of rows)
      await VectorDb.deleteDocumentFromNamespace(
        profileNamespace(profileId),
        `character-memory-${type}-${row.id}`
      ).catch(() => false);
  }
}

async function deleteObjectIndex(profileId, type, objectId) {
  if (!TYPES[type]) return false;
  const VectorDb = getVectorDbClass();
  return VectorDb.deleteDocumentFromNamespace(
    profileNamespace(profileId),
    `character-memory-${type}-${objectId}`
  ).catch(() => false);
}

module.exports = {
  deleteObjectIndex,
  deleteProfileIndex,
  indexPending,
  profileNamespace,
  semanticRecall,
};
