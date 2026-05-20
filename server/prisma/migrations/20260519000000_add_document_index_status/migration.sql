CREATE TABLE "DocumentIndexStatus" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspaceId" INTEGER NOT NULL,
    "docId" TEXT,
    "filePath" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL DEFAULT '',
    "indexStatus" TEXT NOT NULL DEFAULT 'pending',
    "indexedAt" DATETIME,
    "errorMessage" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "embeddingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "DocumentIndexStatus_workspaceId_filePath_key" ON "DocumentIndexStatus"("workspaceId", "filePath");
CREATE INDEX "DocumentIndexStatus_workspaceId_idx" ON "DocumentIndexStatus"("workspaceId");
CREATE INDEX "DocumentIndexStatus_docId_idx" ON "DocumentIndexStatus"("docId");
CREATE INDEX "DocumentIndexStatus_filePath_idx" ON "DocumentIndexStatus"("filePath");
CREATE INDEX "DocumentIndexStatus_fileHash_idx" ON "DocumentIndexStatus"("fileHash");
CREATE INDEX "DocumentIndexStatus_indexStatus_idx" ON "DocumentIndexStatus"("indexStatus");
