const prisma = require("../prisma");
const { KnowledgeGraph } = require("../../models/knowledgeGraph");
const {
  getGraphRetrievalCache,
  setGraphRetrievalCache,
} = require("./retrievalCache");

const DEFAULT_TRAVERSAL = {
  maxDepth: 2,
  maxExpandedNodes: 40,
  confidenceCutoff: 0.45,
  perNodeFanout: 12,
};

function boundedTraversalOptions(options = {}) {
  return {
    maxDepth: Math.min(
      3,
      Math.max(1, Number(options.maxDepth || DEFAULT_TRAVERSAL.maxDepth))
    ),
    maxExpandedNodes: Math.min(
      100,
      Math.max(
        1,
        Number(options.maxExpandedNodes || DEFAULT_TRAVERSAL.maxExpandedNodes)
      )
    ),
    confidenceCutoff: Math.max(
      0,
      Math.min(
        1,
        Number(options.confidenceCutoff ?? DEFAULT_TRAVERSAL.confidenceCutoff)
      )
    ),
    perNodeFanout: Math.min(
      20,
      Math.max(
        1,
        Number(options.perNodeFanout || DEFAULT_TRAVERSAL.perNodeFanout)
      )
    ),
    includeEvidence: options.includeEvidence === true,
  };
}

function toNode(row = {}) {
  return {
    id: row.id,
    canonicalName: row.canonicalName,
    canonicalKey: row.canonicalKey,
    displayNameZh: row.displayNameZh || null,
    displayNameEn: row.displayNameEn || row.canonicalName,
    entityType: row.entityType,
    summary: row.summary,
    globalImportanceScore: Number(row.globalImportanceScore || 0),
    workspaceImportanceScore: Number(row.workspaceImportanceScore || 0),
    recentImportanceScore: Number(row.recentImportanceScore || 0),
  };
}

async function relatedConcepts({ workspaceId, concept, options = {} }) {
  const traversal = boundedTraversalOptions(options);
  const conceptKey = KnowledgeGraph.canonicalKey(concept);
  const cached = await getGraphRetrievalCache({
    workspaceId,
    conceptKey,
    params: traversal,
  });
  if (cached?.result) return { ...cached.result, cache: { hit: true } };

  const matchedNode = await KnowledgeGraph.findNodeByNameOrAlias({
    workspaceId,
    name: concept,
    ensureSchema: false,
  });
  if (!matchedNode) {
    return {
      concept,
      matchedNode: null,
      relatedNodes: [],
      edges: [],
      evidence: [],
      sourceCounts: { documents: 0, chunks: 0 },
      cache: { hit: false },
    };
  }

  const visited = new Set([matchedNode.id]);
  let frontier = [matchedNode.id];
  const edgeMap = new Map();
  const relatedNodeIds = new Set();

  for (let depth = 0; depth < traversal.maxDepth; depth += 1) {
    if (frontier.length === 0) break;
    const next = [];
    for (const nodeId of frontier) {
      if (visited.size >= traversal.maxExpandedNodes) break;
      const edges = await prisma.$queryRawUnsafe(
        `SELECT * FROM "KnowledgeEdge"
        WHERE "workspaceId" = ? AND "confidence" >= ?
          AND ("sourceNodeId" = ? OR "targetNodeId" = ?)
        ORDER BY ("weight" * "confidence") DESC
        LIMIT ?`,
        Number(workspaceId),
        traversal.confidenceCutoff,
        Number(nodeId),
        Number(nodeId),
        traversal.perNodeFanout
      );
      for (const edge of edges) {
        edgeMap.set(edge.id, edge);
        const other =
          Number(edge.sourceNodeId) === Number(nodeId)
            ? edge.targetNodeId
            : edge.sourceNodeId;
        if (!visited.has(other)) {
          visited.add(other);
          relatedNodeIds.add(other);
          next.push(other);
        }
        if (visited.size >= traversal.maxExpandedNodes) break;
      }
    }
    frontier = next;
  }

  const relatedNodeRows = relatedNodeIds.size
    ? await prisma.$queryRawUnsafe(
        `SELECT * FROM "KnowledgeNode"
        WHERE "workspaceId" = ? AND "id" IN (${Array.from(relatedNodeIds)
          .map(() => "?")
          .join(",")})`,
        Number(workspaceId),
        ...Array.from(relatedNodeIds)
      )
    : [];
  const edges = Array.from(edgeMap.values()).map((edge) => ({
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    relationType: edge.relationType,
    relationLabel: edge.relationLabel,
    relationLabelZh: edge.relationLabelZh || null,
    relationLabelEn: edge.relationLabelEn || edge.relationType,
    confidence: Number(edge.confidence || 0),
    weight: Number(edge.weight || 0),
  }));

  const evidence = traversal.includeEvidence
    ? await prisma.$queryRawUnsafe(
        `SELECT * FROM "EdgeEvidence"
        WHERE "workspaceId" = ? AND "edgeId" IN (${
          edges.length ? edges.map(() => "?").join(",") : "NULL"
        })
        ORDER BY "confidence" DESC
        LIMIT 50`,
        Number(workspaceId),
        ...edges.map((edge) => edge.id)
      )
    : [];
  const sourceCounts = {
    documents: new Set(evidence.map((item) => item.documentId)).size,
    chunks: new Set(evidence.map((item) => item.chunkId)).size,
  };

  const relatedNodes = relatedNodeRows.map(toNode).sort((a, b) => {
    const scoreA =
      a.recentImportanceScore * 0.35 + a.workspaceImportanceScore * 0.45;
    const scoreB =
      b.recentImportanceScore * 0.35 + b.workspaceImportanceScore * 0.45;
    return scoreB - scoreA;
  });

  const result = {
    concept,
    matchedNode: toNode(matchedNode),
    relatedNodes,
    edges,
    evidence,
    sourceCounts,
    cache: { hit: false },
  };
  setImmediate(() => {
    recordTraversalUsage(matchedNode.id);
    setGraphRetrievalCache({
      workspaceId,
      conceptKey,
      params: traversal,
      result,
    }).catch((error) =>
      console.warn(
        "[KnowledgeGraph] traversal cache write skipped:",
        error.message
      )
    );
  });
  return result;
}

async function recordTraversalUsage(nodeId) {
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeNode"
      SET "usageCount" = "usageCount" + 1,
        "recentUsageCount" = "recentUsageCount" + 1,
        "lastReferencedAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ?`,
      Number(nodeId)
    );
  } catch (error) {
    console.warn(
      "[KnowledgeGraph] traversal usage write skipped:",
      error.message
    );
  }
}

module.exports = {
  DEFAULT_TRAVERSAL,
  boundedTraversalOptions,
  relatedConcepts,
};
