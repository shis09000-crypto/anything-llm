const prisma = require("../prisma");
const { KnowledgeGraph } = require("../../models/knowledgeGraph");

function clampScore(value = 0) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

async function updateNodeImportance({ workspaceId, nodeIds = [] }) {
  await KnowledgeGraph.ensureTables();
  const ids = [...new Set(nodeIds.map(Number).filter(Boolean))];
  for (const nodeId of ids) {
    const edgeRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS edgeCount, COALESCE(SUM("weight"), 0) AS totalWeight
      FROM "KnowledgeEdge"
      WHERE "workspaceId" = ? AND ("sourceNodeId" = ? OR "targetNodeId" = ?)`,
      Number(workspaceId),
      nodeId,
      nodeId
    );
    const evidenceRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT "documentId") AS docCount, COUNT(*) AS evidenceCount
      FROM "EdgeEvidence"
      WHERE "workspaceId" = ? AND "edgeId" IN (
        SELECT "id" FROM "KnowledgeEdge"
        WHERE "workspaceId" = ? AND ("sourceNodeId" = ? OR "targetNodeId" = ?)
      )`,
      Number(workspaceId),
      Number(workspaceId),
      nodeId,
      nodeId
    );
    const mapRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS chunkCount, COALESCE(SUM("mentionCount"), 0) AS mentions
      FROM "ConceptChunkMap"
      WHERE "workspaceId" = ? AND "nodeId" = ?`,
      Number(workspaceId),
      nodeId
    );
    const usageRows = await prisma.$queryRawUnsafe(
      `SELECT "usageCount", "recentUsageCount" FROM "KnowledgeNode" WHERE "id" = ?`,
      nodeId
    );

    const edgeCount = Number(edgeRows?.[0]?.edgeCount || 0);
    const totalWeight = Number(edgeRows?.[0]?.totalWeight || 0);
    const docCount = Number(evidenceRows?.[0]?.docCount || 0);
    const evidenceCount = Number(evidenceRows?.[0]?.evidenceCount || 0);
    const chunkCount = Number(mapRows?.[0]?.chunkCount || 0);
    const mentions = Number(mapRows?.[0]?.mentions || 0);
    const usageCount = Number(usageRows?.[0]?.usageCount || 0);
    const recentUsageCount = Number(usageRows?.[0]?.recentUsageCount || 0);

    const globalImportanceScore = clampScore(
      evidenceCount * 0.015 + totalWeight * 0.03 + usageCount * 0.02
    );
    const workspaceImportanceScore = clampScore(
      docCount * 0.08 + edgeCount * 0.035 + chunkCount * 0.02 + mentions * 0.01
    );
    const recentImportanceScore = clampScore(
      recentUsageCount * 0.08 + Math.min(evidenceCount, 10) * 0.025
    );

    await prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeNode"
      SET "globalImportanceScore" = ?, "workspaceImportanceScore" = ?,
        "recentImportanceScore" = ?, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ?`,
      globalImportanceScore,
      workspaceImportanceScore,
      recentImportanceScore,
      nodeId
    );
  }
}

module.exports = { updateNodeImportance, clampScore };
