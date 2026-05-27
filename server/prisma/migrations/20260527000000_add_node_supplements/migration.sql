CREATE TABLE IF NOT EXISTS "NodeSupplement" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "nodeId" INTEGER,
  "nodeKey" TEXT NOT NULL,
  "nodeLabel" TEXT NOT NULL,
  "nodeType" TEXT NOT NULL DEFAULT 'concept',
  "documentId" TEXT NOT NULL,
  "documentName" TEXT NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "metadata" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NodeSupplement_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "workspace_documents"("docId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "NodeSupplement_workspaceId_nodeKey_documentId_key"
  ON "NodeSupplement"("workspaceId", "nodeKey", "documentId");
CREATE INDEX IF NOT EXISTS "NodeSupplement_workspaceId_nodeKey_idx"
  ON "NodeSupplement"("workspaceId", "nodeKey");
CREATE INDEX IF NOT EXISTS "NodeSupplement_workspaceId_documentId_idx"
  ON "NodeSupplement"("workspaceId", "documentId");
CREATE INDEX IF NOT EXISTS "NodeSupplement_workspaceId_nodeId_idx"
  ON "NodeSupplement"("workspaceId", "nodeId");
