const { lazyDataAccessProperty } = require("../../dataAccess/lazyFacade");
const { v4: uuidv4 } = require("uuid");
const {
  getVectorDbClass,
  getEmbeddingEngineSelection,
  toChunks,
} = require("../../helpers");
const { TextSplitter } = require("../../TextSplitter");
const SystemSettings = lazyDataAccessProperty(
  "knowledgeGraph",
  "systemSettings"
);
const { vectorRowsForDocument } = require("../chunks");

const DASH_SCOPE_BASE_PATH =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DASH_SCOPE_MODEL = "text-embedding-v4";

function fileHelpers() {
  return require("../../files");
}

async function repairVectorCacheByReadback({ workspace, document }) {
  const { cachedVectorInformation, storeVectorResult } = fileHelpers();
  if (!workspace?.slug || !document?.docId || !document?.docpath)
    return { repaired: false, reason: "invalid_document" };
  if (await cachedVectorInformation(document.docpath, true))
    return { repaired: true, method: "vector_cache_already_exists" };

  const VectorDb = getVectorDbClass();
  if (VectorDb.name !== "LanceDb")
    return { repaired: false, reason: "vector_readback_unsupported" };

  const vectorRows = await vectorRowsForDocument(document.docId);
  if (vectorRows.length === 0)
    return { repaired: false, reason: "document_vectors_missing" };

  try {
    const { client } = await VectorDb.connect();
    const table = await client.openTable(workspace.slug);
    const ids = vectorRows.map((row) => String(row.vectorId));
    const records = await readLanceRows(table, ids);
    if (records.length !== ids.length)
      return { repaired: false, reason: "vector_readback_partial" };

    const byId = new Map(records.map((record) => [String(record.id), record]));
    const vectors = ids
      .map((id, chunkIndex) =>
        normalizeReadbackRecord(byId.get(id), document, chunkIndex)
      )
      .filter(Boolean);
    if (vectors.length !== ids.length)
      return { repaired: false, reason: "vector_readback_missing_text" };

    await storeVectorResult(toChunks(vectors, 500), document.docpath);
    return {
      repaired: true,
      method: "vector_readback_recovery",
      confidence: "high",
      count: vectors.length,
    };
  } catch (error) {
    return {
      repaired: false,
      reason: "vector_readback_failed",
      error: error.message,
    };
  }
}

async function repairVectorCacheByDashScopeReembed({ document }) {
  const { fileData, storeVectorResult } = fileHelpers();
  const guard = dashScopeGuard();
  if (guard) return { repaired: false, reason: guard };

  const source = await fileData(document.docpath).catch(() => null);
  if (!source?.pageContent)
    return { repaired: false, reason: "missing_source_text" };

  const { pageContent, ...metadata } = source;
  const EmbedderEngine = getEmbeddingEngineSelection();
  const textSplitter = new TextSplitter({
    chunkSize: TextSplitter.determineMaxChunkSize(
      await SystemSettings.getValueOrFallback({
        label: "text_splitter_chunk_size",
      })
    ),
    chunkOverlap: await SystemSettings.getValueOrFallback({
      label: "text_splitter_chunk_overlap",
    }),
    chunkHeaderMeta: TextSplitter.buildHeaderMeta(metadata),
    chunkPrefix: EmbedderEngine?.embeddingPrefix,
  });
  const textChunks = await textSplitter.splitText(pageContent);
  const embeddings = await EmbedderEngine.embedChunks(textChunks);
  if (!Array.isArray(embeddings) || embeddings.length !== textChunks.length)
    return { repaired: false, reason: "embedding_result_mismatch" };

  const vectors = textChunks.map((text, index) => ({
    id: uuidv4(),
    values: embeddings[index],
    metadata: {
      ...metadata,
      docId: document.docId,
      docpath: document.docpath,
      chunkIndex: index,
      text,
    },
  }));
  await storeVectorResult(toChunks(vectors, 500), document.docpath);
  return {
    repaired: true,
    method: "manual_dashscope_reembed",
    confidence: "high",
    count: vectors.length,
  };
}

function dashScopeGuard() {
  const basePath = String(process.env.EMBEDDING_BASE_PATH || "").replace(
    /\/+$/,
    ""
  );
  if (process.env.EMBEDDING_ENGINE !== "generic-openai")
    return "embedding_model_mismatch";
  if (basePath !== DASH_SCOPE_BASE_PATH) return "embedding_model_mismatch";
  if (process.env.EMBEDDING_MODEL_PREF !== DASH_SCOPE_MODEL)
    return "embedding_model_mismatch";
  if (!process.env.GENERIC_OPEN_AI_EMBEDDING_API_KEY)
    return "missing_generic_openai_embedding_api_key";
  return null;
}

async function readLanceRows(table, ids = []) {
  const quoted = ids
    .map((id) => `'${String(id).replace(/'/g, "''")}'`)
    .join(",");
  if (!quoted) return [];
  try {
    return await table
      .query()
      .where(`id IN (${quoted})`)
      .limit(ids.length)
      .toArray();
  } catch {
    const rows = await table
      .query()
      .limit(Math.max(ids.length, 10_000))
      .toArray();
    const wanted = new Set(ids);
    return rows.filter((row) => wanted.has(String(row.id)));
  }
}

function normalizeReadbackRecord(record, document, chunkIndex) {
  if (!record) return null;
  const text = record.text || record.metadata?.text;
  const values = record.vector || record.values;
  if (!text || !Array.isArray(values)) return null;
  const { vector: _vector, values: _values, _distance, ...metadata } = record;
  return {
    id: record.id,
    values,
    metadata: {
      ...metadata,
      docId: metadata.docId || document.docId,
      docpath: metadata.docpath || document.docpath,
      chunkIndex: metadata.chunkIndex ?? chunkIndex,
      text,
    },
  };
}

module.exports = {
  DASH_SCOPE_BASE_PATH,
  DASH_SCOPE_MODEL,
  dashScopeGuard,
  repairVectorCacheByReadback,
  repairVectorCacheByDashScopeReembed,
};
