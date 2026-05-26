CREATE TABLE IF NOT EXISTS "WorkspaceOverviewRecommendationUsage" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL DEFAULT 0,
  "recommendationId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "formulaVersion" TEXT NOT NULL,
  "impressionCount" INTEGER NOT NULL DEFAULT 0,
  "clickCount" INTEGER NOT NULL DEFAULT 0,
  "dismissCount" INTEGER NOT NULL DEFAULT 0,
  "continueCount" INTEGER NOT NULL DEFAULT 0,
  "lastShownAt" DATETIME,
  "lastInteractedAt" DATETIME,
  "cooldownUntil" DATETIME,
  "metadata" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceOverviewRecommendationUsage_workspaceId_userId_recommendationId_key"
  ON "WorkspaceOverviewRecommendationUsage"("workspaceId", "userId", "recommendationId");
CREATE INDEX IF NOT EXISTS "WorkspaceOverviewRecommendationUsage_workspaceId_idx"
  ON "WorkspaceOverviewRecommendationUsage"("workspaceId");
CREATE INDEX IF NOT EXISTS "WorkspaceOverviewRecommendationUsage_userId_idx"
  ON "WorkspaceOverviewRecommendationUsage"("userId");
CREATE INDEX IF NOT EXISTS "WorkspaceOverviewRecommendationUsage_recommendationId_idx"
  ON "WorkspaceOverviewRecommendationUsage"("recommendationId");
CREATE INDEX IF NOT EXISTS "WorkspaceOverviewRecommendationUsage_workspaceId_cooldownUntil_idx"
  ON "WorkspaceOverviewRecommendationUsage"("workspaceId", "cooldownUntil");
CREATE INDEX IF NOT EXISTS "WorkspaceOverviewRecommendationUsage_workspaceId_type_idx"
  ON "WorkspaceOverviewRecommendationUsage"("workspaceId", "type");
CREATE INDEX IF NOT EXISTS "WorkspaceOverviewRecommendationUsage_workspaceId_targetType_targetId_idx"
  ON "WorkspaceOverviewRecommendationUsage"("workspaceId", "targetType", "targetId");
