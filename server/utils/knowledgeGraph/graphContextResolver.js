const { getEmbeddingEngineSelection, getVectorDbClass } = require("../helpers");
const {
  WorkspaceKnowledgeProfile,
} = require("../../models/workspaceKnowledgeProfile");
const { buildWorkspaceKnowledgeProfile } = require("./workspaceProfileBuilder");
const {
  sourceRefForChunk,
  originalEvidenceChunks,
} = require("./evidenceResolver");
const { keyPathsForNode } = require("./pathResolver");
const { getLearningState, recordNodeView } = require("./learningStateResolver");
const { relatedNodes, resolveNode } = require("./nodeResolver");
const { supplementChunks } = require("./supplementResolver");
const {
  workspaceSupplementsWithContent,
} = require("./workspaceSupplementResolver");

const DEFAULT_BUDGET = {
  supplementChunks: 4,
  originalChunks: 5,
  paths: 3,
  neighbors: 8,
  vectorChunks: 3,
  sourceRefs: 12,
  contextChars: 12_000,
  workspaceSupplementChunks: 4,
};

function budget(input = {}) {
  return {
    supplementChunks: Math.min(
      8,
      Math.max(
        0,
        Number(input.supplementChunks ?? DEFAULT_BUDGET.supplementChunks)
      )
    ),
    originalChunks: Math.min(
      10,
      Math.max(0, Number(input.originalChunks ?? DEFAULT_BUDGET.originalChunks))
    ),
    paths: Math.min(
      5,
      Math.max(0, Number(input.paths ?? DEFAULT_BUDGET.paths))
    ),
    neighbors: Math.min(
      16,
      Math.max(0, Number(input.neighbors ?? DEFAULT_BUDGET.neighbors))
    ),
    vectorChunks: Math.min(
      5,
      Math.max(0, Number(input.vectorChunks ?? DEFAULT_BUDGET.vectorChunks))
    ),
    sourceRefs: Math.min(
      20,
      Math.max(1, Number(input.sourceRefs ?? DEFAULT_BUDGET.sourceRefs))
    ),
    workspaceSupplementChunks: Math.min(
      8,
      Math.max(
        0,
        Number(
          input.workspaceSupplementChunks ??
            DEFAULT_BUDGET.workspaceSupplementChunks
        )
      )
    ),
    contextChars: Math.min(
      30_000,
      Math.max(1_000, Number(input.contextChars ?? DEFAULT_BUDGET.contextChars))
    ),
  };
}

function usesWorkspaceSupplements(intent = "") {
  return [
    "recommend",
    "review",
    "summarize",
    "workspace_summary",
    "path",
    "profile_refresh",
  ].includes(String(intent || ""));
}

function clipContextText(sections = [], maxChars) {
  const out = [];
  let used = 0;
  for (const section of sections.filter(Boolean)) {
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const text = String(section).slice(0, remaining);
    out.push(text);
    used += text.length;
  }
  return out.join("\n\n");
}

function chunkSection(prefix, chunk) {
  return `[${prefix}: ${chunk.title || chunk.document?.filename || chunk.documentId || "source"}]\n${chunk.text}`;
}

async function vectorFallback({ workspace, query, limit }) {
  if (!workspace?.slug || !query || limit <= 0) return [];
  const VectorDb = getVectorDbClass();
  const EmbedderEngine = getEmbeddingEngineSelection();
  const LLMConnector = {
    embedTextInput: (input) => EmbedderEngine.embedTextInput(input),
  };
  const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
  const embeddingsCount = hasVectorizedSpace
    ? await VectorDb.namespaceCount(workspace.slug)
    : 0;
  if (!hasVectorizedSpace || embeddingsCount === 0) return [];
  const result = await VectorDb.performSimilaritySearch({
    namespace: workspace.slug,
    input: query,
    LLMConnector,
    similarityThreshold: workspace?.similarityThreshold,
    topN: limit,
    filterIdentifiers: [],
    rerank: workspace?.vectorSearchMode === "rerank",
  });
  if (result.message) return [];
  return (result.sources || []).map((source) => ({
    text: source.text || source.pageContent || "",
    title: source.title || source.docpath || "Workspace search",
    documentId: source.docId || null,
    docpath: source.docpath || null,
    sourceType: "workspace_vector_fallback",
    score: source.score || source.relevanceScore || 0,
  }));
}

async function resolveGraphContext({
  workspace,
  user = null,
  nodeKey = null,
  nodeId = null,
  intent = "explain",
  query = "",
  budget: inputBudget = {},
  recordView = false,
} = {}) {
  await WorkspaceKnowledgeProfile.ensureTables();
  const workspaceId = Number(workspace?.id || workspace);
  const limits = budget(inputBudget);
  const { profile, bookStructure } = await buildWorkspaceKnowledgeProfile({
    workspace,
  });

  if (!nodeKey && !nodeId) {
    const workspaceSupplements = usesWorkspaceSupplements(intent)
      ? await workspaceSupplementsWithContent({
          workspaceId,
          limit: limits.workspaceSupplementChunks,
        })
      : [];
    const contextText = clipContextText(
      workspaceSupplements.map((item) =>
        [
          `[全书补充: ${item.documentName}]`,
          `类型：${item.supplementKind}`,
          item.parsedStructure
            ? `结构化 JSON：${JSON.stringify(item.parsedStructure)}`
            : "",
          item.text,
        ]
          .filter(Boolean)
          .join("\n")
      ),
      limits.contextChars
    );
    return {
      node: null,
      workspaceProfile: profile,
      bookStructure,
      nodeSummary: "",
      supplements: workspaceSupplements,
      evidenceChunks: workspaceSupplements.map((item) => ({
        text: item.text,
        title: item.documentName,
        documentId: item.documentId,
        sourceType: "workspace_supplement",
        supplementKind: item.supplementKind,
      })),
      relatedNodes: [],
      keyPaths: [],
      learningState: null,
      sourceRefs: [],
      contextText,
      budget: limits,
      skippedReason: workspaceSupplements.length
        ? null
        : "explicit_node_required",
    };
  }

  const node = await resolveNode({ workspaceId, nodeKey, nodeId });
  if (!node) {
    return {
      node: null,
      workspaceProfile: profile,
      bookStructure,
      nodeSummary: "",
      supplements: [],
      evidenceChunks: [],
      relatedNodes: [],
      keyPaths: [],
      learningState: null,
      sourceRefs: [],
      contextText: "",
      budget: limits,
      skippedReason: "node_not_found",
    };
  }

  const supplement = await supplementChunks({
    workspace,
    node,
    query,
    limit: limits.supplementChunks,
  });
  const originals = await originalEvidenceChunks({
    workspaceId,
    node,
    nodeKey: node.nodeKey,
    limit: limits.originalChunks,
  });
  const paths = await keyPathsForNode({
    workspaceId,
    node,
    profile,
    bookStructure,
    workspaceSupplements: usesWorkspaceSupplements(intent)
      ? await workspaceSupplementsWithContent({
          workspaceId,
          limit: limits.workspaceSupplementChunks,
        })
      : [],
    limit: limits.paths,
  });
  const neighbors = await relatedNodes({
    workspaceId,
    nodeId: node.id,
    limit: limits.neighbors,
  });
  const fallback = await vectorFallback({
    workspace,
    query: query || node.canonicalName,
    limit: limits.vectorChunks,
  });
  const evidenceChunks = [...supplement.chunks, ...originals, ...fallback];
  const sourceRefs = evidenceChunks
    .slice(0, limits.sourceRefs)
    .map(sourceRefForChunk);
  const learningState = recordView
    ? await recordNodeView({
        workspaceId,
        userId: user?.id || 0,
        nodeKey: node.nodeKey,
        supplementCount: supplement.supplements.length,
      })
    : await getLearningState({
        workspaceId,
        userId: user?.id || 0,
        nodeKey: node.nodeKey,
      });
  const contextText = clipContextText(
    [
      `节点：${node.displayNameZh || node.displayNameEn || node.canonicalName}\n类型：${node.entityType}\n摘要：${node.summary || ""}\n意图：${intent}`,
      ...supplement.chunks.map((chunk) => chunkSection("节点补充", chunk)),
      ...originals.map((chunk) => chunkSection("原始证据", chunk)),
      paths.length
        ? `关键路径：\n${paths.map((path) => `- ${path.summary}`).join("\n")}`
        : "",
      neighbors.length
        ? `关键邻居：${neighbors
            .map((item) => item.displayNameZh || item.canonicalName)
            .join("、")}`
        : "",
      ...fallback.map((chunk) => chunkSection("普通检索补充", chunk)),
    ],
    limits.contextChars
  );

  return {
    node,
    workspaceProfile: profile,
    bookStructure,
    nodeSummary: node.summary || "",
    supplements: supplement.supplements,
    evidenceChunks,
    relatedNodes: neighbors,
    keyPaths: paths,
    learningState,
    sourceRefs,
    contextText,
    budget: limits,
  };
}

module.exports = {
  DEFAULT_BUDGET,
  resolveGraphContext,
};
