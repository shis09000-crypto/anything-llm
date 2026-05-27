CREATE TABLE IF NOT EXISTS "WorkspaceVisualAsset" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "scopeType" TEXT NOT NULL DEFAULT 'workspace',
  "nodeKey" TEXT,
  "nodeLabel" TEXT,
  "nodeType" TEXT,
  "role" TEXT NOT NULL DEFAULT 'hero_background',
  "filename" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "size" INTEGER NOT NULL DEFAULT 0,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "deletedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceVisualAsset_workspace_scope_node_role_key"
  ON "WorkspaceVisualAsset"("workspaceId","scopeType",COALESCE("nodeKey",'__workspace__'),"role")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "WorkspaceVisualAsset_workspace_scope_idx"
  ON "WorkspaceVisualAsset"("workspaceId","scopeType","role");

CREATE TABLE IF NOT EXISTS "WorkspaceOverviewNarrative" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "tagline" TEXT,
  "sourceHash" TEXT NOT NULL DEFAULT '',
  "model" TEXT,
  "promptVersion" TEXT NOT NULL DEFAULT 'workspace-overview-tagline-v2',
  "status" TEXT NOT NULL DEFAULT 'empty',
  "errorType" TEXT,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "lastGeneratedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceOverviewNarrative_workspaceId_key"
  ON "WorkspaceOverviewNarrative"("workspaceId");

CREATE INDEX IF NOT EXISTS "WorkspaceOverviewNarrative_status_idx"
  ON "WorkspaceOverviewNarrative"("status");
