const prisma = require("../prisma");
const { KnowledgeGraph } = require("../../models/knowledgeGraph");
const {
  buildNodeKey,
  nodeKeyCandidates,
  parseNodeKey,
} = require("./nodeIdentity");

function toNode(row = null) {
  if (!row) return null;
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspaceId),
    canonicalName: row.canonicalName,
    canonicalKey: row.canonicalKey,
    displayNameZh: row.displayNameZh || null,
    displayNameEn: row.displayNameEn || null,
    entityType: row.entityType || "concept",
    summary: row.summary || "",
    workspaceImportanceScore: Number(row.workspaceImportanceScore || 0),
    recentImportanceScore: Number(row.recentImportanceScore || 0),
    nodeKey: buildNodeKey({
      entityType: row.entityType || "concept",
      canonicalKey: row.canonicalKey,
    }),
  };
}

async function resolveNode({ workspaceId, nodeKey = null, nodeId = null }) {
  await KnowledgeGraph.ensureTables();
  if (nodeId) {
    return toNode(await KnowledgeGraph.getNode(Number(nodeId)));
  }
  const parsed = parseNodeKey(nodeKey);
  if (!parsed) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM "KnowledgeNode" WHERE "workspaceId" = ?`,
    Number(workspaceId)
  );
  const candidates = new Set(nodeKeyCandidates(nodeKey));
  return rows.map(toNode).find((node) => candidates.has(node.nodeKey)) || null;
}

async function relatedNodes({ workspaceId, nodeId, limit = 8 }) {
  if (!workspaceId || !nodeId) return [];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT n.*, e."relationType", e."confidence", e."weight"
    FROM "KnowledgeEdge" e
    JOIN "KnowledgeNode" n
      ON n."id" = CASE
        WHEN e."sourceNodeId" = ? THEN e."targetNodeId"
        ELSE e."sourceNodeId"
      END
    WHERE e."workspaceId" = ?
      AND (e."sourceNodeId" = ? OR e."targetNodeId" = ?)
    ORDER BY e."confidence" DESC, e."weight" DESC
    LIMIT ?`,
    Number(nodeId),
    Number(workspaceId),
    Number(nodeId),
    Number(nodeId),
    Number(limit || 8)
  );
  return rows.map((row) => ({
    ...toNode(row),
    relationType: row.relationType,
    confidence: Number(row.confidence || 0),
    weight: Number(row.weight || 0),
  }));
}

module.exports = {
  relatedNodes,
  resolveNode,
  toNode,
};
