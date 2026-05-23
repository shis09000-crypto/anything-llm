const prisma = require("../prisma");
const { KnowledgeGraph } = require("../../models/knowledgeGraph");

async function cleanupKnowledgeGraph({ workspaceId = null } = {}) {
  await KnowledgeGraph.ensureTables();
  const workspaceClause = workspaceId ? `AND "workspaceId" = ?` : "";
  const values = workspaceId ? [Number(workspaceId)] : [];

  await prisma.$executeRawUnsafe(
    `UPDATE "KnowledgeEdge"
    SET "confidence" = "confidence" * 0.95, "updatedAt" = CURRENT_TIMESTAMP
    WHERE ("lastReferencedAt" IS NULL OR "lastReferencedAt" < datetime('now', '-30 days'))
      ${workspaceClause}`,
    ...values
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "EdgeEvidence"
    WHERE "edgeId" IN (
      SELECT "id" FROM "KnowledgeEdge"
      WHERE "confidence" < 0.25 AND "weight" <= 1
        AND ("lastReferencedAt" IS NULL OR "lastReferencedAt" < datetime('now', '-90 days'))
        ${workspaceClause}
    )`,
    ...values
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "KnowledgeEdge"
    WHERE "confidence" < 0.25 AND "weight" <= 1
      AND ("lastReferencedAt" IS NULL OR "lastReferencedAt" < datetime('now', '-90 days'))
      ${workspaceClause}`,
    ...values
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "KnowledgeNode"
    WHERE "usageCount" = 0 AND "workspaceImportanceScore" < 0.2
      AND "updatedAt" < datetime('now', '-30 days')
      AND "id" NOT IN (
        SELECT "sourceNodeId" FROM "KnowledgeEdge"
        UNION
        SELECT "targetNodeId" FROM "KnowledgeEdge"
      )
      ${workspaceClause}`,
    ...values
  );
  if (workspaceId) await KnowledgeGraph.invalidateCache(workspaceId);
  return { success: true };
}

module.exports = { cleanupKnowledgeGraph };
