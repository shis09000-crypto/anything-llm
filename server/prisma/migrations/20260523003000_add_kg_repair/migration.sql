CREATE TABLE IF NOT EXISTS "KnowledgeGraphRepairIssue" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "documentId" TEXT NOT NULL DEFAULT '',
  "chunkId" TEXT NOT NULL DEFAULT '',
  "issueType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "priorityScore" REAL NOT NULL DEFAULT 0,
  "priorityReason" TEXT,
  "rootConceptHit" BOOLEAN NOT NULL DEFAULT false,
  "workspaceImportanceScore" REAL NOT NULL DEFAULT 0,
  "traversalUsageCount" INTEGER NOT NULL DEFAULT 0,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" DATETIME,
  "cooldownUntil" DATETIME,
  "repairMethod" TEXT,
  "repairConfidence" TEXT,
  "lastError" TEXT,
  "explainReason" TEXT,
  "quarantineReason" TEXT,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeGraphRepairIssue_workspaceId_issueType_documentId_chunkId_key"
  ON "KnowledgeGraphRepairIssue"("workspaceId", "issueType", "documentId", "chunkId");
CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairIssue_workspaceId_status_idx"
  ON "KnowledgeGraphRepairIssue"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairIssue_workspaceId_priorityScore_idx"
  ON "KnowledgeGraphRepairIssue"("workspaceId", "priorityScore");
CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairIssue_workspaceId_nextRetryAt_idx"
  ON "KnowledgeGraphRepairIssue"("workspaceId", "nextRetryAt");
CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairIssue_workspaceId_cooldownUntil_idx"
  ON "KnowledgeGraphRepairIssue"("workspaceId", "cooldownUntil");

CREATE TABLE IF NOT EXISTS "KnowledgeGraphRepairRun" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "trigger" TEXT NOT NULL DEFAULT 'auto',
  "scanned" INTEGER NOT NULL DEFAULT 0,
  "repaired" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "budgetExhausted" BOOLEAN NOT NULL DEFAULT false,
  "durationMs" INTEGER NOT NULL DEFAULT 0,
  "tokenBudgetUsed" INTEGER NOT NULL DEFAULT 0,
  "providerBudgetUsed" INTEGER NOT NULL DEFAULT 0,
  "successRate" REAL NOT NULL DEFAULT 0,
  "avgRepairLatencyMs" REAL NOT NULL DEFAULT 0,
  "providerFailureRate" REAL NOT NULL DEFAULT 0,
  "needsReembedCount" INTEGER NOT NULL DEFAULT 0,
  "quarantinedCount" INTEGER NOT NULL DEFAULT 0,
  "lowConfidenceRelationRatio" REAL NOT NULL DEFAULT 0,
  "relatedToRatio" REAL NOT NULL DEFAULT 0,
  "malformedExtractionRatio" REAL NOT NULL DEFAULT 0,
  "abnormalFanoutCount" INTEGER NOT NULL DEFAULT 0,
  "timeoutRate" REAL NOT NULL DEFAULT 0,
  "malformedJsonRate" REAL NOT NULL DEFAULT 0,
  "avgExtractionLatencyMs" REAL NOT NULL DEFAULT 0,
  "providerFailureTrend" REAL NOT NULL DEFAULT 0,
  "metricsJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairRun_workspaceId_createdAt_idx"
  ON "KnowledgeGraphRepairRun"("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairRun_workspaceId_trigger_idx"
  ON "KnowledgeGraphRepairRun"("workspaceId", "trigger");
