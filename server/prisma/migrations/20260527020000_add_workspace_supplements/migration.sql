CREATE TABLE IF NOT EXISTS "WorkspaceSupplement" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "scopeType" TEXT NOT NULL DEFAULT 'workspace',
  "primaryDocumentId" TEXT NOT NULL DEFAULT '__workspace__',
  "documentId" TEXT NOT NULL,
  "documentName" TEXT NOT NULL,
  "supplementKind" TEXT NOT NULL DEFAULT 'other',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "metadata" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("documentId") REFERENCES "workspace_documents"("docId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceSupplement_workspace_scope_primary_document_key"
  ON "WorkspaceSupplement"("workspaceId","scopeType","primaryDocumentId","documentId");
CREATE INDEX IF NOT EXISTS "WorkspaceSupplement_workspace_scope_kind_idx"
  ON "WorkspaceSupplement"("workspaceId","scopeType","supplementKind");
CREATE INDEX IF NOT EXISTS "WorkspaceSupplement_workspace_document_idx"
  ON "WorkspaceSupplement"("workspaceId","documentId");
