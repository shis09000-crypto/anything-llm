const { getEmbeddingEngineSelection, getVectorDbClass } = require("../helpers");
const { sourceIdentifier } = require("../chats");
const {
  resolveGraphContext,
} = require("../knowledgeGraph/graphContextResolver");
const { MAX_EVIDENCE_CHUNKS } = require("./constants");

function scoreOf(source = {}) {
  const value =
    source.score ??
    source.relevanceScore ??
    source.similarity ??
    source._score ??
    source._distance;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function textOf(source = {}) {
  return String(
    source.text || source.pageContent || source.metadata?.text || ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

function sourceKey(source = {}) {
  return [
    source.id,
    source.docId,
    source.docpath,
    source.filePath,
    source.title,
    source.chunkIndex,
    textOf(source).slice(0, 160),
  ]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join(":");
}

function toSourceRef(source = {}, id, score) {
  return {
    id,
    title:
      source.title ||
      source.name ||
      source.fileName ||
      source.docpath ||
      "Source",
    docId: source.docId || null,
    docpath: source.docpath || source.filePath || source.source || null,
    chunkIndex:
      source.chunkIndex === undefined || source.chunkIndex === null
        ? null
        : Number(source.chunkIndex),
    score,
    published: source.published || null,
    sourceType: source.sourceType || null,
    nodeKey: source.nodeKey || null,
    nodeLabel: source.nodeLabel || null,
  };
}

function normalizeEvidenceSources(sources = []) {
  const seen = new Map();
  for (const source of sources) {
    const text = textOf(source);
    if (!text) continue;
    const key = sourceKey(source) || sourceIdentifier(source);
    const score = scoreOf(source);
    const previous = seen.get(key);
    if (!previous || score > previous.score) {
      seen.set(key, { source, text, score });
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_EVIDENCE_CHUNKS)
    .map((item, index) => {
      const id = `evidence-${index + 1}`;
      return {
        id,
        text: item.text,
        score: item.score,
        sourceRef: toSourceRef(item.source, id, item.score),
      };
    });
}

async function retrieveQuizEvidence({ workspace, plan, nodeContext = null }) {
  const VectorDb = getVectorDbClass();
  const EmbedderEngine = getEmbeddingEngineSelection();
  const LLMConnector = {
    embedTextInput: (input) => EmbedderEngine.embedTextInput(input),
  };
  const queries = (
    plan.searchQueries?.length ? plan.searchQueries : [plan.topic]
  )
    .map((query) => String(query || "").trim())
    .filter(Boolean);
  const graphContext =
    nodeContext?.nodeKey || nodeContext?.nodeId
      ? await resolveGraphContext({
          workspace,
          nodeKey: nodeContext.nodeKey,
          nodeId: nodeContext.nodeId,
          intent: "quiz",
          query: [plan.topic, ...queries].filter(Boolean).join(" "),
          budget: {
            supplementChunks: Math.min(MAX_EVIDENCE_CHUNKS, 4),
            originalChunks: Math.min(MAX_EVIDENCE_CHUNKS, 4),
            vectorChunks: 0,
            contextChars: 10_000,
          },
        })
      : null;
  const supplementSources = (graphContext?.evidenceChunks || []).map(
    (chunk, index) => ({
      ...chunk,
      id: chunk.id || `graph-context-${index + 1}`,
      text: chunk.text,
    })
  );
  const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
  const embeddingsCount = hasVectorizedSpace
    ? await VectorDb.namespaceCount(workspace.slug)
    : 0;
  if (!hasVectorizedSpace || embeddingsCount === 0) {
    if (supplementSources.length > 0) {
      const evidenceChunks = normalizeEvidenceSources(supplementSources);
      return {
        evidenceChunks,
        sourceRefs: evidenceChunks.map((chunk) => chunk.sourceRef),
        error: null,
      };
    }
    return {
      evidenceChunks: [],
      sourceRefs: [],
      error: "workspace_has_no_vectors",
    };
  }

  const sources = [...supplementSources];
  for (const query of queries) {
    const result = await VectorDb.performSimilaritySearch({
      namespace: workspace.slug,
      input: query,
      LLMConnector,
      similarityThreshold: workspace?.similarityThreshold,
      topN: MAX_EVIDENCE_CHUNKS,
      filterIdentifiers: [],
      rerank: workspace?.vectorSearchMode === "rerank",
    });
    if (result.message)
      return { evidenceChunks: [], sourceRefs: [], error: result.message };
    sources.push(...(result.sources || []));
  }

  const evidenceChunks = normalizeEvidenceSources(sources);
  return {
    evidenceChunks,
    sourceRefs: evidenceChunks.map((chunk) => chunk.sourceRef),
    error: null,
  };
}

module.exports = {
  retrieveQuizEvidence,
  normalizeEvidenceSources,
  scoreOf,
};
