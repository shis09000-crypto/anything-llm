const {
  lazyDataAccessFacade,
  lazyDataAccessProperty,
} = require("../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const knowledgeGraphDb = KnowledgeGraphData.db;
const KnowledgeGraph = lazyDataAccessProperty("knowledgeGraph", "model");
const { buildNodeKey } = require("./nodeIdentity");

const DEFAULT_PATH_OPTIONS = {
  maxDepth: 4,
  limit: 3,
  confidenceCutoff: 0.45,
  perNodeFanout: 12,
  includeEvidence: true,
};

function boundedPathOptions(options = {}) {
  return {
    maxDepth: Math.min(
      4,
      Math.max(1, Number(options.maxDepth || DEFAULT_PATH_OPTIONS.maxDepth))
    ),
    limit: Math.min(
      5,
      Math.max(1, Number(options.limit || DEFAULT_PATH_OPTIONS.limit))
    ),
    confidenceCutoff: Math.max(
      0,
      Math.min(
        1,
        Number(
          options.confidenceCutoff ?? DEFAULT_PATH_OPTIONS.confidenceCutoff
        )
      )
    ),
    perNodeFanout: Math.min(
      20,
      Math.max(
        1,
        Number(options.perNodeFanout || DEFAULT_PATH_OPTIONS.perNodeFanout)
      )
    ),
    includeEvidence: options.includeEvidence !== false,
  };
}

function nodeDto(row = {}) {
  const nodeKey = buildNodeKey({
    entityType: row.entityType || "concept",
    canonicalKey: row.canonicalKey,
  });
  return {
    id: Number(row.id),
    nodeId: Number(row.id),
    sourceNodeId: Number(row.id),
    nodeKey,
    canonicalName: row.canonicalName,
    canonicalKey: row.canonicalKey,
    displayNameZh: row.displayNameZh || null,
    displayNameEn: row.displayNameEn || row.canonicalName,
    entityType: row.entityType || null,
    workspaceImportanceScore: Number(row.workspaceImportanceScore || 0),
    recentImportanceScore: Number(row.recentImportanceScore || 0),
  };
}

function edgeDto(row = {}) {
  return {
    id: Number(row.id),
    sourceNodeId: Number(row.sourceNodeId),
    targetNodeId: Number(row.targetNodeId),
    relationType: row.relationType,
    relationLabel: row.relationLabel || row.relationType,
    relationLabelZh: row.relationLabelZh || null,
    relationLabelEn: row.relationLabelEn || row.relationType,
    confidence: Number(row.confidence || 0),
    weight: Number(row.weight || 0),
  };
}

function pathScore(path = []) {
  if (!path.length) return 0;
  return (
    path.reduce((sum, edge) => {
      const confidence = Number(edge.confidence || 0);
      const weight = Math.min(1, Number(edge.weight || 0) / 4);
      const specificity = edge.relationType === "related_to" ? -0.15 : 0.1;
      return sum + confidence * 0.68 + weight * 0.22 + specificity;
    }, 0) / path.length
  );
}

function orderedNodeIdsForPath(
  sourceNodeId,
  edgeIds = [],
  edgeMap = new Map()
) {
  const ordered = [Number(sourceNodeId)];
  let current = Number(sourceNodeId);
  for (const edgeId of edgeIds) {
    const edge = edgeMap.get(edgeId);
    if (!edge) continue;
    const next =
      edge.sourceNodeId === current ? edge.targetNodeId : edge.sourceNodeId;
    ordered.push(next);
    current = next;
  }
  return ordered;
}

async function reasoningPaths({
  workspaceId,
  source,
  target,
  options = {},
} = {}) {
  await KnowledgeGraph.ensureTables();
  const bounded = boundedPathOptions(options);
  const [sourceNode, targetNode] = await Promise.all([
    KnowledgeGraph.findNodeByNameOrAlias({ workspaceId, name: source }),
    KnowledgeGraph.findNodeByNameOrAlias({ workspaceId, name: target }),
  ]);

  if (!sourceNode || !targetNode) {
    return {
      source,
      target,
      sourceNode: sourceNode ? nodeDto(sourceNode) : null,
      targetNode: targetNode ? nodeDto(targetNode) : null,
      paths: [],
      evidence: [],
      cache: { hit: false },
      emptyReason: !sourceNode ? "source_not_found" : "target_not_found",
      options: bounded,
    };
  }

  const queue = [
    {
      nodeId: Number(sourceNode.id),
      edgeIds: [],
      visited: new Set([Number(sourceNode.id)]),
    },
  ];
  const found = [];
  const edgeMap = new Map();

  while (queue.length && found.length < bounded.limit * 4) {
    const current = queue.shift();
    if (current.edgeIds.length >= bounded.maxDepth) continue;
    const rows = await knowledgeGraphDb.$queryRawUnsafe(
      `SELECT * FROM "KnowledgeEdge"
      WHERE "workspaceId" = ? AND "confidence" >= ?
        AND ("sourceNodeId" = ? OR "targetNodeId" = ?)
      ORDER BY ("confidence" * "weight") DESC
      LIMIT ?`,
      Number(workspaceId),
      bounded.confidenceCutoff,
      Number(current.nodeId),
      Number(current.nodeId),
      bounded.perNodeFanout
    );

    for (const row of rows) {
      const edge = edgeDto(row);
      edgeMap.set(edge.id, edge);
      const nextNodeId =
        edge.sourceNodeId === Number(current.nodeId)
          ? edge.targetNodeId
          : edge.sourceNodeId;
      if (current.visited.has(nextNodeId)) continue;
      const nextPath = [...current.edgeIds, edge.id];
      if (nextNodeId === Number(targetNode.id)) {
        found.push(nextPath);
        continue;
      }
      queue.push({
        nodeId: nextNodeId,
        edgeIds: nextPath,
        visited: new Set([...current.visited, nextNodeId]),
      });
    }
  }

  const rankedPaths = found
    .map((edgeIds) => {
      const edges = edgeIds.map((id) => edgeMap.get(id)).filter(Boolean);
      const orderedNodeIds = orderedNodeIdsForPath(
        sourceNode.id,
        edgeIds,
        edgeMap
      );
      const nodeIds = new Set(orderedNodeIds);
      edges.forEach((edge) => {
        nodeIds.add(edge.sourceNodeId);
        nodeIds.add(edge.targetNodeId);
      });
      return {
        edgeIds,
        orderedNodeIds,
        nodeIds: Array.from(nodeIds),
        score: pathScore(edges),
        edges,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, bounded.limit);

  const allNodeIds = new Set();
  const allEdgeIds = new Set();
  rankedPaths.forEach((path) => {
    path.nodeIds.forEach((id) => allNodeIds.add(id));
    path.edgeIds.forEach((id) => allEdgeIds.add(id));
  });

  const nodes = allNodeIds.size
    ? await knowledgeGraphDb.$queryRawUnsafe(
        `SELECT * FROM "KnowledgeNode"
        WHERE "workspaceId" = ? AND "id" IN (${Array.from(allNodeIds)
          .map(() => "?")
          .join(",")})`,
        Number(workspaceId),
        ...Array.from(allNodeIds)
      )
    : [];
  const nodeMap = new Map(
    nodes.map((node) => [Number(node.id), nodeDto(node)])
  );

  const evidence =
    bounded.includeEvidence && allEdgeIds.size
      ? await knowledgeGraphDb.$queryRawUnsafe(
          `SELECT * FROM "EdgeEvidence"
          WHERE "workspaceId" = ? AND "edgeId" IN (${Array.from(allEdgeIds)
            .map(() => "?")
            .join(",")})
          ORDER BY "confidence" DESC
          LIMIT 40`,
          Number(workspaceId),
          ...Array.from(allEdgeIds)
        )
      : [];

  return {
    source,
    target,
    sourceNode: nodeDto(sourceNode),
    targetNode: nodeDto(targetNode),
    paths: rankedPaths.map((path) => ({
      ...path,
      nodes: path.orderedNodeIds.map((id) => nodeMap.get(id)).filter(Boolean),
      trustSummary: {
        score: Number(path.score.toFixed(3)),
        level:
          path.score >= 0.72 ? "high" : path.score >= 0.48 ? "medium" : "low",
        reasons: [
          "基于已有 KnowledgeEdge 的多跳路径计算",
          "路径分数综合 confidence、weight 和关系类型明确性",
        ],
      },
    })),
    evidence,
    cache: { hit: false },
    options: bounded,
  };
}

module.exports = {
  boundedPathOptions,
  reasoningPaths,
};
