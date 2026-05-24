CREATE TABLE IF NOT EXISTS "KnowledgeNodeMetrics" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "nodeId" INTEGER NOT NULL,
  "evidenceStrength" INTEGER NOT NULL DEFAULT 0,
  "bridgeValue" INTEGER NOT NULL DEFAULT 0,
  "knowledgeConnectivity" INTEGER NOT NULL DEFAULT 0,
  "traversalImportance" INTEGER NOT NULL DEFAULT 0,
  "crossDocumentPresence" INTEGER NOT NULL DEFAULT 0,
  "freshness" INTEGER NOT NULL DEFAULT 0,
  "relationDiversity" INTEGER NOT NULL DEFAULT 0,
  "sourceAuthority" INTEGER NOT NULL DEFAULT 0,
  "stability" INTEGER NOT NULL DEFAULT 0,
  "conflictSafety" INTEGER NOT NULL DEFAULT 0,
  "reasonsJson" TEXT NOT NULL DEFAULT '{}',
  "normalizedInputsJson" TEXT NOT NULL DEFAULT '{}',
  "formulaVersion" TEXT NOT NULL DEFAULT 'metrics-v1',
  "stale" BOOLEAN NOT NULL DEFAULT true,
  "warning" TEXT,
  "lastError" TEXT,
  "lockedAt" DATETIME,
  "lockedBy" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_workspaceId_nodeId_key" ON "KnowledgeNodeMetrics"("workspaceId", "nodeId");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_workspaceId_idx" ON "KnowledgeNodeMetrics"("workspaceId");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_nodeId_idx" ON "KnowledgeNodeMetrics"("nodeId");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_formulaVersion_idx" ON "KnowledgeNodeMetrics"("formulaVersion");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_stale_idx" ON "KnowledgeNodeMetrics"("stale");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_lockedAt_idx" ON "KnowledgeNodeMetrics"("lockedAt");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_updatedAt_idx" ON "KnowledgeNodeMetrics"("updatedAt");

CREATE TABLE IF NOT EXISTS "KnowledgeNodeMetricsSnapshot" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "nodeId" INTEGER NOT NULL,
  "formulaVersion" TEXT NOT NULL,
  "scoresJson" TEXT NOT NULL,
  "normalizedInputsJson" TEXT NOT NULL DEFAULT '{}',
  "snapshotPeriod" TEXT NOT NULL DEFAULT 'daily',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsSnapshot_workspaceId_nodeId_idx" ON "KnowledgeNodeMetricsSnapshot"("workspaceId", "nodeId");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsSnapshot_formulaVersion_idx" ON "KnowledgeNodeMetricsSnapshot"("formulaVersion");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsSnapshot_snapshotPeriod_idx" ON "KnowledgeNodeMetricsSnapshot"("snapshotPeriod");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsSnapshot_createdAt_idx" ON "KnowledgeNodeMetricsSnapshot"("createdAt");

CREATE TABLE IF NOT EXISTS "KnowledgeNodeMetricsRecomputeRun" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER,
  "trigger" TEXT NOT NULL DEFAULT 'worker',
  "formulaVersion" TEXT NOT NULL DEFAULT 'metrics-v1',
  "batchSize" INTEGER NOT NULL DEFAULT 0,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "succeeded" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER NOT NULL DEFAULT 0,
  "lockedCount" INTEGER NOT NULL DEFAULT 0,
  "errorJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsRecomputeRun_workspaceId_idx" ON "KnowledgeNodeMetricsRecomputeRun"("workspaceId");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsRecomputeRun_trigger_idx" ON "KnowledgeNodeMetricsRecomputeRun"("trigger");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsRecomputeRun_formulaVersion_idx" ON "KnowledgeNodeMetricsRecomputeRun"("formulaVersion");
CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsRecomputeRun_createdAt_idx" ON "KnowledgeNodeMetricsRecomputeRun"("createdAt");
