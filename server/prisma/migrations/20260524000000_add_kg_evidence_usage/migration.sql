CREATE TABLE IF NOT EXISTS "KnowledgeGraphEvidenceUsage" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeGraphEvidenceUsage_workspaceId_targetType_targetId_action_key"
  ON "KnowledgeGraphEvidenceUsage"("workspaceId", "targetType", "targetId", "action");

CREATE INDEX IF NOT EXISTS "KnowledgeGraphEvidenceUsage_workspaceId_targetType_targetId_idx"
  ON "KnowledgeGraphEvidenceUsage"("workspaceId", "targetType", "targetId");

CREATE INDEX IF NOT EXISTS "KnowledgeGraphEvidenceUsage_workspaceId_action_idx"
  ON "KnowledgeGraphEvidenceUsage"("workspaceId", "action");

CREATE INDEX IF NOT EXISTS "KnowledgeGraphEvidenceUsage_workspaceId_lastUsedAt_idx"
  ON "KnowledgeGraphEvidenceUsage"("workspaceId", "lastUsedAt");
