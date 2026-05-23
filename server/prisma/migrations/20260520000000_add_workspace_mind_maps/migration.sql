CREATE TABLE IF NOT EXISTS "workspace_mind_maps" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspaceId" INTEGER NOT NULL,
    "user_id" INTEGER,
    "thread_id" INTEGER,
    "cacheUserKey" TEXT NOT NULL DEFAULT 'anonymous',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceTitle" TEXT,
    "sourceHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "layout" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "schema" TEXT NOT NULL,
    "markdown" TEXT,
    "viewport" TEXT,
    "promptVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "generationModel" TEXT,
    "suitability" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_mind_maps_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workspace_mind_maps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_mind_maps_workspaceId_cacheUserKey_sourceHash_key" ON "workspace_mind_maps"("workspaceId", "cacheUserKey", "sourceHash");
CREATE INDEX IF NOT EXISTS "workspace_mind_maps_workspaceId_idx" ON "workspace_mind_maps"("workspaceId");
CREATE INDEX IF NOT EXISTS "workspace_mind_maps_user_id_idx" ON "workspace_mind_maps"("user_id");
CREATE INDEX IF NOT EXISTS "workspace_mind_maps_thread_id_idx" ON "workspace_mind_maps"("thread_id");
CREATE INDEX IF NOT EXISTS "workspace_mind_maps_sourceHash_idx" ON "workspace_mind_maps"("sourceHash");
