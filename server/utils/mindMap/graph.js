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
  part_of: "属于",
  depends_on: "依赖",
  regulates: "调控",
  related_to: "相关",
  contrasts_with: "对比",
  precedes: "先于",
  used_in: "用于",
  acts_at: "作用于",
  implements: "实现",
  references: "引用",
};

function graphNodeId(id) {
  return `kg-${id}`;
}

function relationColor(type) {
  return RELATION_STYLES[type] || "#64748B";
}

function relationLabel(edge = {}) {
  return edge.relationLabel || edge.relationType || "";
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
    (a, b) =>
      Number(b.confidence || 0) * Number(b.weight || 1) -
      Number(a.confidence || 0) * Number(a.weight || 1)
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
    };
  });

  const edges = traversal.edges.map((edge) => {
    const evidence = evidenceByEdge.get(Number(edge.id)) || [];
    return {
      id: `kg-edge-${edge.id}`,
      source: graphNodeId(edge.sourceNodeId),
      target: graphNodeId(edge.targetNodeId),
      label: relationLabel(edge),
      type: "graph",
      relationType: edge.relationType,
      relationLabelZh:
        edge.relationLabelZh || RELATION_LABELS_ZH[edge.relationType] || null,
      relationLabelEn: edge.relationLabelEn || edge.relationType,
      confidence: Number(edge.confidence || 0),
      weight: Number(edge.weight || 0),
      evidenceCount: evidence.length,
      documentIds: [...new Set(evidence.map((item) => item.documentId))],
      chunkIds: [...new Set(evidence.map((item) => item.chunkId))],
      evidence,
      color: relationColor(edge.relationType),
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
};
