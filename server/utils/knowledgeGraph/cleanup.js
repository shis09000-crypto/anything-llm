const {
  lazyDataAccessFacade,
  lazyDataAccessProperty,
} = require("../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const knowledgeGraphDb = KnowledgeGraphData.db;
const KnowledgeGraph = lazyDataAccessProperty("knowledgeGraph", "model");

async function cleanupKnowledgeGraph({ workspaceId = null } = {}) {
  await KnowledgeGraph.ensureTables();
  const workspaceClause = workspaceId ? `AND "workspaceId" = ?` : "";
  const scopeValues = workspaceId ? [Number(workspaceId)] : [];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60_000);

  await knowledgeGraphDb.$executeRawUnsafe(
    `UPDATE "KnowledgeEdge"
    SET "confidence" = "confidence" * 0.95, "updatedAt" = CURRENT_TIMESTAMP
    WHERE ("lastReferencedAt" IS NULL OR "lastReferencedAt" < ?)
      ${workspaceClause}`,
    thirtyDaysAgo,
    ...scopeValues
  );
  await knowledgeGraphDb.$executeRawUnsafe(
    `DELETE FROM "EdgeEvidence"
    WHERE "edgeId" IN (
      SELECT "id" FROM "KnowledgeEdge"
      WHERE "confidence" < 0.25 AND "weight" <= 1
        AND ("lastReferencedAt" IS NULL OR "lastReferencedAt" < ?)
        ${workspaceClause}
    )`,
    ninetyDaysAgo,
    ...scopeValues
  );
  await knowledgeGraphDb.$executeRawUnsafe(
    `DELETE FROM "KnowledgeEdge"
    WHERE "confidence" < 0.25 AND "weight" <= 1
      AND ("lastReferencedAt" IS NULL OR "lastReferencedAt" < ?)
      ${workspaceClause}`,
    ninetyDaysAgo,
    ...scopeValues
  );
  await knowledgeGraphDb.$executeRawUnsafe(
    `DELETE FROM "KnowledgeNode"
    WHERE "usageCount" = 0 AND "workspaceImportanceScore" < 0.2
      AND "updatedAt" < ?
      AND "id" NOT IN (
        SELECT "sourceNodeId" FROM "KnowledgeEdge"
        UNION
        SELECT "targetNodeId" FROM "KnowledgeEdge"
      )
      ${workspaceClause}`,
    thirtyDaysAgo,
    ...scopeValues
  );
  if (workspaceId) await KnowledgeGraph.invalidateCache(workspaceId);
  if (workspaceId)
    await KnowledgeGraph.markWorkspaceNodeMetricsStale(
      workspaceId,
      "cleanup_decay_completed"
    );
  return { success: true };
}

module.exports = { cleanupKnowledgeGraph };
