ALTER TABLE "KnowledgeNode" ADD COLUMN "displayNameZh" TEXT;
ALTER TABLE "KnowledgeNode" ADD COLUMN "displayNameEn" TEXT;

ALTER TABLE "KnowledgeEdge" ADD COLUMN "relationLabelZh" TEXT;
ALTER TABLE "KnowledgeEdge" ADD COLUMN "relationLabelEn" TEXT;

CREATE TABLE IF NOT EXISTS "GraphLabelTranslationCache" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "cacheKey" TEXT NOT NULL,
  "sourceText" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL DEFAULT 'node',
  "displayNameZh" TEXT,
  "displayNameEn" TEXT,
  "aliasesJson" TEXT NOT NULL DEFAULT '[]',
  "model" TEXT,
  "promptVersion" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "GraphLabelTranslationCache_workspaceId_cacheKey_key"
  ON "GraphLabelTranslationCache"("workspaceId", "cacheKey");
