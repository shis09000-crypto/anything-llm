const prisma = require("../prisma");
const { KnowledgeGraph } = require("../../models/knowledgeGraph");
const {
  relatedConcepts,
  boundedTraversalOptions,
} = require("../knowledgeGraph/traversal");
const {
  DEFAULT_LAYOUT,
  normalizeMindMapSchema,
  mindMapToMarkdown,
} = require("./schema");

const GRAPH_THEME = "napkin";
const DEFAULT_GRAPH_LAYOUT = "tree";
const RELATION_STYLES = {
  causes: "#F97316",
  part_of: "#3B82F6",
  depends_on: "#8B5CF6",
  regulates: "#22C55E",
  related_to: "#94A3B8",
  contrasts_with: "#E11D48",
  precedes: "#0EA5E9",
  used_in: "#14B8A6",
  acts_at: "#10B981",
  implements: "#6366F1",
  references: "#64748B",
};
const RELATION_LABELS_ZH = {
  causes: "导致",
  part_of: "属于/组成",
  depends_on: "依赖",
  regulates: "调控",
  related_to: "相关",
  contrasts_with: "对比/相反",
  precedes: "先于",
  used_in: "用于",
  acts_at: "作用于",
  implements: "实现/体现",
  references: "引用",
};
const RELATION_CLUSTER_LABELS = {
  causes: ["mechanism", "机制簇"],
  regulates: ["regulation", "调控簇"],
  acts_at: ["mechanism", "机制簇"],
  depends_on: ["mechanism", "机制簇"],
  part_of: ["structure", "结构簇"],
  used_in: ["application", "应用簇"],
  implements: ["application", "应用簇"],
  contrasts_with: ["comparison", "对比簇"],
  precedes: ["history", "时间簇"],
  references: ["reference", "引用簇"],
  related_to: ["related", "相关簇"],
};

function graphNodeId(id) {
  return `kg-${id}`;
}

function relationColor(type) {
  return RELATION_STYLES[type] || "#64748B";
}

function relationLabel(edge = {}) {
  return (
    edge.relationLabelZh ||
    RELATION_LABELS_ZH[edge.relationType] ||
    edge.relationLabelEn ||
    edge.relationLabel ||
    edge.relationType ||
    ""
  );
}

function importanceScore(node = {}) {
  return (
    Number(node.workspaceImportanceScore || 0) * 0.55 +
    Number(node.recentImportanceScore || 0) * 0.3 +
    Number(node.globalImportanceScore || 0) * 0.15
  );
}

async function fullNodesById({ workspaceId, nodeIds = [] }) {
  if (!nodeIds.length) return new Map();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "id", "canonicalName", "canonicalKey", "aliases", "entityType",
      "displayNameZh", "displayNameEn", "summary", "globalImportanceScore",
      "workspaceImportanceScore", "recentImportanceScore"
    FROM "KnowledgeNode"
    WHERE "workspaceId" = ? AND "id" IN (${nodeIds.map(() => "?").join(",")})`,
    Number(workspaceId),
    ...nodeIds.map(Number)
  );
  const map = new Map();
  rows.forEach((row) => {
    map.set(Number(row.id), {
      ...row,
      aliases: safeParseArray(row.aliases),
      globalImportanceScore: Number(row.globalImportanceScore || 0),
      workspaceImportanceScore: Number(row.workspaceImportanceScore || 0),
      recentImportanceScore: Number(row.recentImportanceScore || 0),
    });
  });
  return map;
}

function safeParseArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function nodeEvidenceCounts({ workspaceId, nodeIds = [] }) {
  if (!nodeIds.length) return new Map();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT nodeId, COUNT(*) AS count FROM (
      SELECT e."sourceNodeId" AS nodeId, ev."id" AS evidenceId
      FROM "KnowledgeEdge" e
      JOIN "EdgeEvidence" ev ON ev."edgeId" = e."id"
      WHERE e."workspaceId" = ? AND e."sourceNodeId" IN (${nodeIds
        .map(() => "?")
        .join(",")})
      UNION ALL
      SELECT e."targetNodeId" AS nodeId, ev."id" AS evidenceId
      FROM "KnowledgeEdge" e
      JOIN "EdgeEvidence" ev ON ev."edgeId" = e."id"
      WHERE e."workspaceId" = ? AND e."targetNodeId" IN (${nodeIds
        .map(() => "?")
        .join(",")})
    ) GROUP BY nodeId`,
    Number(workspaceId),
    ...nodeIds.map(Number),
    Number(workspaceId),
    ...nodeIds.map(Number)
  );
  return new Map(
    rows.map((row) => [Number(row.nodeId), Number(row.count || 0)])
  );
}

async function edgeEvidenceStats({ workspaceId, edgeIds = [] }) {
  if (!edgeIds.length) return new Map();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "edgeId",
      COUNT(*) AS evidenceCount,
      COUNT(DISTINCT "documentId") AS documentCount,
      COUNT(DISTINCT "chunkId") AS chunkCount,
      MIN("createdAt") AS firstSeenAt,
      MAX("createdAt") AS latestSeenAt
    FROM "EdgeEvidence"
    WHERE "workspaceId" = ? AND "edgeId" IN (${edgeIds.map(() => "?").join(",")})
    GROUP BY "edgeId"`,
    Number(workspaceId),
    ...edgeIds.map(Number)
  );
  return new Map(
    rows.map((row) => [
      Number(row.edgeId),
      {
        evidenceCount: Number(row.evidenceCount || 0),
        documentCount: Number(row.documentCount || 0),
        chunkCount: Number(row.chunkCount || 0),
        firstSeenAt: row.firstSeenAt || null,
        latestSeenAt: row.latestSeenAt || null,
      },
    ])
  );
}

async function topChunksByNode({ workspaceId, nodeIds = [] }) {
  if (!nodeIds.length) return new Map();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c."nodeId", c."chunkId", c."documentId", c."relevanceScore",
      d."filename", d."docpath"
    FROM "ConceptChunkMap" c
    LEFT JOIN "workspace_documents" d
      ON d."docId" = c."documentId" AND d."workspaceId" = c."workspaceId"
    WHERE c."workspaceId" = ? AND c."nodeId" IN (${nodeIds
      .map(() => "?")
      .join(",")})
    ORDER BY c."relevanceScore" DESC, c."updatedAt" DESC`,
    Number(workspaceId),
    ...nodeIds.map(Number)
  );
  const map = new Map();
  for (const row of rows) {
    const current = map.get(Number(row.nodeId)) || [];
    if (current.length >= 3) continue;
    current.push({
      chunkId: row.chunkId,
      documentId: row.documentId,
      title: row.filename || row.docpath || row.documentId,
      path: row.docpath || "",
      relevanceScore: Number(row.relevanceScore || 0),
    });
    map.set(Number(row.nodeId), current);
  }
  return map;
}

function edgeEvidenceMap(evidence = []) {
  const map = new Map();
  for (const item of evidence) {
    const current = map.get(Number(item.edgeId)) || [];
    if (current.length < 3) {
      current.push({
        id: item.id,
        documentId: item.documentId,
        chunkId: item.chunkId,
        snippet: item.snippet || "",
        confidence: Number(item.confidence || 0),
      });
    }
    map.set(Number(item.edgeId), current);
  }
  return map;
}

function buildDepths({ rootId, nodeIds, edges }) {
  const adjacency = new Map();
  edges.forEach((edge) => {
    adjacency.set(edge.sourceNodeId, [
      ...(adjacency.get(edge.sourceNodeId) || []),
      edge.targetNodeId,
    ]);
    adjacency.set(edge.targetNodeId, [
      ...(adjacency.get(edge.targetNodeId) || []),
      edge.sourceNodeId,
    ]);
  });
  const depths = new Map([[rootId, 0]]);
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift();
    const depth = depths.get(current) || 0;
    for (const next of adjacency.get(current) || []) {
      if (depths.has(next) || !nodeIds.has(next)) continue;
      depths.set(next, depth + 1);
      queue.push(next);
    }
  }
  nodeIds.forEach((id) => {
    if (!depths.has(id)) depths.set(id, 1);
  });
  return depths;
}

function chooseParentEdges({ rootId, nodeIds, depths, edges }) {
  const parentByNode = new Map();
  const ordered = [...edges].sort(
    (a, b) => edgeRankScore(b) - edgeRankScore(a)
  );
  for (const edge of ordered) {
    const sourceDepth = depths.get(edge.sourceNodeId) ?? 99;
    const targetDepth = depths.get(edge.targetNodeId) ?? 99;
    let parent = edge.sourceNodeId;
    let child = edge.targetNodeId;
    if (targetDepth < sourceDepth) {
      parent = edge.targetNodeId;
      child = edge.sourceNodeId;
    }
    if (child === rootId || !nodeIds.has(parent) || !nodeIds.has(child))
      continue;
    if (parentByNode.has(child)) continue;
    parentByNode.set(child, { parent, edgeId: edge.id });
  }
  return parentByNode;
}

function edgeRankScore(edge = {}) {
  const confidence = Number(edge.confidence || 0);
  const weight = Number(edge.weight || 1);
  const evidenceCount = Number(edge.evidenceCount || 0);
  const ontologyBonus = edge.relationType === "related_to" ? -0.25 : 0.15;
  return (
    confidence * 0.48 +
    Math.min(1, weight / 4) * 0.22 +
    Math.min(1, evidenceCount / 3) * 0.2 +
    ontologyBonus
  );
}

function edgeRelationCluster(edge = {}) {
  const [clusterKey, clusterLabel] = RELATION_CLUSTER_LABELS[
    edge.relationType
  ] || ["other", "其他簇"];
  return { clusterKey, clusterLabel };
}

function classifyEdgeRole({ edge, parentEdgeIds = new Set(), stats = {} }) {
  const confidence = Number(edge.confidence || 0);
  const evidenceCount = Number(stats.evidenceCount || edge.evidenceCount || 0);
  const relationType = edge.relationType || "related_to";
  const hasConflict =
    Array.isArray(edge.conflicts) && edge.conflicts.length > 0;
  if (hasConflict) return "conflict";
  if (parentEdgeIds.has(Number(edge.id))) return "main";
  if (confidence >= 0.65 && evidenceCount > 0 && relationType !== "related_to")
    return "branch";
  if (confidence < 0.55 || evidenceCount === 0 || relationType === "related_to")
    return "weak";
  return "support";
}

function edgeDisplay(edge = {}, role = "support", stats = {}) {
  const confidence = Number(edge.confidence || 0);
  const evidenceCount = Number(stats.evidenceCount || edge.evidenceCount || 0);
  const labelZh = relationLabel(edge);
  const trustScore = Math.max(
    0,
    Math.min(
      1,
      confidence * 0.55 +
        Math.min(1, evidenceCount / 3) * 0.25 +
        Math.min(1, Number(edge.weight || 0) / 4) * 0.2
    )
  );
  const visualWeightByRole = {
    main: 4.2,
    branch: 3.2,
    support: 2.1,
    weak: 1.3,
    conflict: 2.8,
    layout: 1,
  };
  const visualOpacityByRole = {
    main: 0.94,
    branch: 0.78,
    support: 0.48,
    weak: 0.22,
    conflict: 0.82,
    layout: 0.16,
  };
  return {
    displayLabel: labelZh,
    displayLabelZh: labelZh,
    displayLabelEn: edge.relationLabelEn || edge.relationType || "",
    shouldShowLabel: role === "main" || role === "branch",
    labelModeDefault:
      role === "main" ? "visible" : role === "branch" ? "auto" : "hover",
    visualWeight: visualWeightByRole[role] || 2,
    visualOpacity: visualOpacityByRole[role] || 0.45,
    visualStyle:
      role === "weak" || role === "conflict"
        ? "dashed"
        : role === "layout"
          ? "layout"
          : "solid",
    trustScore,
    trustLevel:
      trustScore >= 0.72 ? "high" : trustScore >= 0.45 ? "medium" : "low",
    trustReasons: [
      evidenceCount > 1 ? "有多条证据支持" : "证据来源较少",
      confidence >= 0.7 ? "关系置信度较高" : "关系置信度有限",
      edge.relationType === "related_to"
        ? "属于泛化相关关系"
        : "关系类型较明确",
    ],
    evidenceSupportLevel:
      evidenceCount >= 3
        ? "multi_source"
        : evidenceCount > 0
          ? "single_or_limited"
          : "none",
  };
}

function edgeTimeRange(stats = {}) {
  if (!stats.firstSeenAt && !stats.latestSeenAt) return null;
  return {
    firstSeenAt: stats.firstSeenAt || null,
    latestSeenAt: stats.latestSeenAt || stats.firstSeenAt || null,
  };
}

async function graphMindMapFromConcept({
  workspaceId,
  concept,
  layout = DEFAULT_GRAPH_LAYOUT,
  maxDepth = 2,
  maxExpandedNodes = 60,
  confidenceCutoff = 0.45,
} = {}) {
  const traversalOptions = boundedTraversalOptions({
    maxDepth,
    maxExpandedNodes,
    confidenceCutoff,
    includeEvidence: true,
  });
  const graphStatus = await KnowledgeGraph.graphStats(workspaceId);
  const traversal = await relatedConcepts({
    workspaceId,
    concept,
    options: traversalOptions,
  });
  if (!traversal.matchedNode) {
    return {
      mindMap: null,
      traversal,
      cache: traversal.cache,
      graphStatus,
      sourceMode: "graph",
      emptyReason: "concept_not_found",
    };
  }

  const rootId = Number(traversal.matchedNode.id);
  const allNodeIds = new Set([
    rootId,
    ...traversal.relatedNodes.map((node) => Number(node.id)),
  ]);
  const fullNodes = await fullNodesById({
    workspaceId,
    nodeIds: Array.from(allNodeIds),
  });
  const evidenceCounts = await nodeEvidenceCounts({
    workspaceId,
    nodeIds: Array.from(allNodeIds),
  });
  const topChunks = await topChunksByNode({
    workspaceId,
    nodeIds: Array.from(allNodeIds),
  });
  const evidenceByEdge = edgeEvidenceMap(traversal.evidence || []);
  const edgeStats = await edgeEvidenceStats({
    workspaceId,
    edgeIds: traversal.edges.map((edge) => Number(edge.id)),
  });
  traversal.edges.forEach((edge) => {
    const stats = edgeStats.get(Number(edge.id));
    if (stats) edge.evidenceCount = stats.evidenceCount;
  });
  const depths = buildDepths({
    rootId,
    nodeIds: allNodeIds,
    edges: traversal.edges,
  });
  const parentEdges = chooseParentEdges({
    rootId,
    nodeIds: allNodeIds,
    depths,
    edges: traversal.edges,
  });
  const parentEdgeIds = new Set(
    Array.from(parentEdges.values()).map((item) => Number(item.edgeId))
  );
  const nodeClusterById = new Map();
  for (const edge of traversal.edges) {
    const cluster = edgeRelationCluster(edge);
    if (!nodeClusterById.has(Number(edge.sourceNodeId)))
      nodeClusterById.set(Number(edge.sourceNodeId), cluster);
    if (!nodeClusterById.has(Number(edge.targetNodeId)))
      nodeClusterById.set(Number(edge.targetNodeId), cluster);
  }

  const nodes = Array.from(allNodeIds).map((nodeId) => {
    const node =
      fullNodes.get(Number(nodeId)) ||
      traversal.relatedNodes.find(
        (item) => Number(item.id) === Number(nodeId)
      ) ||
      traversal.matchedNode;
    const score = importanceScore(node);
    const parent = parentEdges.get(Number(nodeId));
    const level = depths.get(Number(nodeId)) || 0;
    const cluster =
      level === 0
        ? { clusterKey: "root", clusterLabel: "核心概念" }
        : nodeClusterById.get(Number(nodeId)) || {
            clusterKey: "other",
            clusterLabel: "其他簇",
          };
    return {
      id: graphNodeId(nodeId),
      label: node.displayNameZh || node.canonicalName,
      description: node.summary || node.entityType || "",
      icon: level === 0 ? "*" : level === 1 ? "o" : "-",
      level,
      color: level === 0 ? "#FDE68A" : score > 0.35 ? "#DBEAFE" : "#F8FAFC",
      parentId: parent ? graphNodeId(parent.parent) : null,
      sourceType: "graph",
      sourceNodeId: Number(node.id),
      canonicalName: node.canonicalName,
      displayNameZh: node.displayNameZh || null,
      displayNameEn: node.displayNameEn || node.canonicalName,
      aliases: node.aliases || [],
      evidenceCount: evidenceCounts.get(Number(nodeId)) || 0,
      topChunks: topChunks.get(Number(nodeId)) || [],
      importanceScore: score,
      workspaceImportanceScore: Number(node.workspaceImportanceScore || 0),
      recentImportanceScore: Number(node.recentImportanceScore || 0),
      collapsedByDefault:
        level > 1 &&
        (score < 0.15 ||
          traversal.edges.some(
            (edge) =>
              (Number(edge.sourceNodeId) === Number(nodeId) ||
                Number(edge.targetNodeId) === Number(nodeId)) &&
              Number(edge.confidence || 0) < 0.55
          )),
      size: level === 0 ? "root" : score > 0.35 ? "large" : "normal",
      clusterKey: cluster.clusterKey,
      clusterLabel: cluster.clusterLabel,
    };
  });

  const edges = traversal.edges.map((edge) => {
    const evidence = evidenceByEdge.get(Number(edge.id)) || [];
    const stats = edgeStats.get(Number(edge.id)) || {};
    const edgeRole = classifyEdgeRole({ edge, parentEdgeIds, stats });
    const display = edgeDisplay(edge, edgeRole, stats);
    const timeRange = edgeTimeRange(stats);
    return {
      id: `kg-edge-${edge.id}`,
      source: graphNodeId(edge.sourceNodeId),
      target: graphNodeId(edge.targetNodeId),
      label: relationLabel(edge),
      type: "graph",
      edgeRole,
      isMainEdge: edgeRole === "main",
      isBranchEdge: edgeRole === "branch",
      isSupportEdge: edgeRole === "support",
      isWeakRelation: edgeRole === "weak",
      isConflictEdge: edgeRole === "conflict",
      isLayoutEdge: false,
      isCycleEdge:
        !parentEdgeIds.has(Number(edge.id)) &&
        depths.get(Number(edge.sourceNodeId)) ===
          depths.get(Number(edge.targetNodeId)),
      isPrimaryEdge: edgeRole === "main",
      clickable: true,
      relationType: edge.relationType,
      relationLabelZh:
        edge.relationLabelZh || RELATION_LABELS_ZH[edge.relationType] || null,
      relationLabelEn: edge.relationLabelEn || edge.relationType,
      confidence: Number(edge.confidence || 0),
      weight: Number(edge.weight || 0),
      evidenceCount: Number(stats.evidenceCount || evidence.length || 0),
      documentIds: [...new Set(evidence.map((item) => item.documentId))],
      chunkIds: [...new Set(evidence.map((item) => item.chunkId))],
      evidence,
      color: relationColor(edge.relationType),
      firstSeenAt: stats.firstSeenAt || null,
      latestSeenAt: stats.latestSeenAt || null,
      evidenceTimeRange: timeRange,
      ...display,
    };
  });

  const schema = normalizeMindMapSchema(
    {
      title: `知识图谱：${traversal.matchedNode.canonicalName}`,
      layout: layout || DEFAULT_LAYOUT,
      recommendedLayout: layout || DEFAULT_LAYOUT,
      theme: GRAPH_THEME,
      summary: `从知识图谱中围绕「${traversal.matchedNode.canonicalName}」展开的概念关系。`,
      nodes,
      edges,
    },
    { layout, theme: GRAPH_THEME }
  );
  const markdown = mindMapToMarkdown(schema);
  return {
    mindMap: {
      id: null,
      sourceType: "graph",
      sourceId: String(traversal.matchedNode.id),
      sourceTitle: traversal.matchedNode.canonicalName,
      title: schema.title,
      layout: schema.layout,
      theme: schema.theme,
      schema,
      markdown,
      viewport: null,
    },
    traversal: {
      options: traversalOptions,
      sourceCounts: traversal.sourceCounts,
      relatedNodeCount: traversal.relatedNodes.length,
      edgeCount: traversal.edges.length,
    },
    cache: traversal.cache,
    graphStatus,
    sourceMode: "graph",
  };
}

module.exports = {
  graphMindMapFromConcept,
  relationColor,
  relationLabel,
  RELATION_LABELS_ZH,
  classifyEdgeRole,
};
