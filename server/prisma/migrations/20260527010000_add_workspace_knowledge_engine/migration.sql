CREATE TABLE IF NOT EXISTS "WorkspaceKnowledgeProfile" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "profileType" TEXT NOT NULL DEFAULT 'mixed',
  "confidence" REAL NOT NULL DEFAULT 0,
  "primaryDocumentIdsJson" TEXT NOT NULL DEFAULT '[]',
  "mainTopic" TEXT,
  "detectedStructureJson" TEXT NOT NULL DEFAULT '{}',
  "suggestedGraphStrategy" TEXT,
  "profileVersion" TEXT NOT NULL DEFAULT 'workspace-profile-v1',
  "manualOverride" BOOLEAN NOT NULL DEFAULT false,
  "overrideSource" TEXT,
  "overrideReason" TEXT,
  "originalProfileType" TEXT,
  "originalConfidence" REAL,
  "userDescription" TEXT,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "lastAnalyzedAt" DATETIME,
  "nextRefreshAfter" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceKnowledgeProfile_workspaceId_key"
  ON "WorkspaceKnowledgeProfile"("workspaceId");
CREATE INDEX IF NOT EXISTS "WorkspaceKnowledgeProfile_profileType_idx"
  ON "WorkspaceKnowledgeProfile"("profileType");
CREATE INDEX IF NOT EXISTS "WorkspaceKnowledgeProfile_nextRefreshAfter_idx"
  ON "WorkspaceKnowledgeProfile"("nextRefreshAfter");

CREATE TABLE IF NOT EXISTS "BookStructureAnalysis" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "structureType" TEXT NOT NULL DEFAULT 'mixed_structure',
  "confidence" REAL NOT NULL DEFAULT 0,
  "primaryAxis" TEXT,
  "secondaryAxesJson" TEXT NOT NULL DEFAULT '[]',
  "recommendedNodeTypesJson" TEXT NOT NULL DEFAULT '[]',
  "recommendedPathTypesJson" TEXT NOT NULL DEFAULT '[]',
  "extractionFocusJson" TEXT NOT NULL DEFAULT '[]',
  "recommendationFocusJson" TEXT NOT NULL DEFAULT '[]',
  "structureVersion" TEXT NOT NULL DEFAULT 'book-structure-v1',
  "manualOverride" BOOLEAN NOT NULL DEFAULT false,
  "overrideSource" TEXT,
  "overrideReason" TEXT,
  "originalStructureType" TEXT,
  "originalConfidence" REAL,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "lastAnalyzedAt" DATETIME,
  "nextRefreshAfter" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "BookStructureAnalysis_workspaceId_key"
  ON "BookStructureAnalysis"("workspaceId");
CREATE INDEX IF NOT EXISTS "BookStructureAnalysis_structureType_idx"
  ON "BookStructureAnalysis"("structureType");
CREATE INDEX IF NOT EXISTS "BookStructureAnalysis_nextRefreshAfter_idx"
  ON "BookStructureAnalysis"("nextRefreshAfter");

CREATE TABLE IF NOT EXISTS "NodeChunkBinding" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "nodeKey" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "chunkId" TEXT NOT NULL,
  "relevanceScore" REAL NOT NULL DEFAULT 0,
  "evidenceType" TEXT NOT NULL DEFAULT 'original',
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "NodeChunkBinding_workspaceId_nodeKey_documentId_chunkId_evidenceType_key"
  ON "NodeChunkBinding"("workspaceId","nodeKey","documentId","chunkId","evidenceType");
CREATE INDEX IF NOT EXISTS "NodeChunkBinding_workspaceId_nodeKey_idx"
  ON "NodeChunkBinding"("workspaceId","nodeKey");
CREATE INDEX IF NOT EXISTS "NodeChunkBinding_workspaceId_documentId_idx"
  ON "NodeChunkBinding"("workspaceId","documentId");
CREATE INDEX IF NOT EXISTS "NodeChunkBinding_workspaceId_chunkId_idx"
  ON "NodeChunkBinding"("workspaceId","chunkId");

CREATE TABLE IF NOT EXISTS "NodeLearningState" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL DEFAULT 0,
  "nodeKey" TEXT NOT NULL,
  "viewedCount" INTEGER NOT NULL DEFAULT 0,
  "lastViewedAt" DATETIME,
  "quizAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "wrongCount" INTEGER NOT NULL DEFAULT 0,
  "correctCount" INTEGER NOT NULL DEFAULT 0,
  "masteryScore" REAL NOT NULL DEFAULT 0,
  "confusionScore" REAL NOT NULL DEFAULT 0,
  "supplementCount" INTEGER NOT NULL DEFAULT 0,
  "hasUserSupplement" BOOLEAN NOT NULL DEFAULT false,
  "recommendedCount" INTEGER NOT NULL DEFAULT 0,
  "dismissedCount" INTEGER NOT NULL DEFAULT 0,
  "lastRecommendedAt" DATETIME,
  "userMarkedImportant" BOOLEAN NOT NULL DEFAULT false,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "NodeLearningState_workspaceId_userId_nodeKey_key"
  ON "NodeLearningState"("workspaceId","userId","nodeKey");
CREATE INDEX IF NOT EXISTS "NodeLearningState_workspaceId_nodeKey_idx"
  ON "NodeLearningState"("workspaceId","nodeKey");
CREATE INDEX IF NOT EXISTS "NodeLearningState_workspaceId_userId_idx"
  ON "NodeLearningState"("workspaceId","userId");
