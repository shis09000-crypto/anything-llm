CREATE TABLE "browser_profiles" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "executionLocation" TEXT NOT NULL DEFAULT 'cloud',
    "status" TEXT NOT NULL DEFAULT 'ready',
    "archiveRef" TEXT,
    "archiveManifestJson" TEXT,
    "archiveSha256" TEXT,
    "archiveBytes" INTEGER,
    "checkpointedAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "browser_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "browser_profiles_ownerUserId_profileId_key"
ON "browser_profiles"("ownerUserId", "profileId");
CREATE INDEX "browser_profiles_ownerUserId_status_idx"
ON "browser_profiles"("ownerUserId", "status");
CREATE INDEX "browser_profiles_leaseExpiresAt_idx"
ON "browser_profiles"("leaseExpiresAt");
CREATE INDEX "browser_profiles_lastUsedAt_idx"
ON "browser_profiles"("lastUsedAt");

CREATE TABLE "browser_sessions" (
    "id" TEXT NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "profileId" TEXT NOT NULL,
    "workerSessionId" TEXT,
    "driver" TEXT NOT NULL,
    "executionLocation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "currentTabId" TEXT,
    "nodeId" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "browser_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "browser_sessions_ownerUserId_status_idx"
ON "browser_sessions"("ownerUserId", "status");
CREATE INDEX "browser_sessions_profileId_status_idx"
ON "browser_sessions"("profileId", "status");
CREATE INDEX "browser_sessions_leaseExpiresAt_idx"
ON "browser_sessions"("leaseExpiresAt");

CREATE TABLE "browser_workspaces" (
    "id" TEXT NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "preferredLocation" TEXT NOT NULL DEFAULT 'desktop',
    "stateJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "browser_workspaces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "browser_workspaces_ownerUserId_updatedAt_idx"
ON "browser_workspaces"("ownerUserId", "updatedAt");

CREATE TABLE "browser_tabs" (
    "id" TEXT NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "sessionId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "title" TEXT,
    "urlWithoutQuery" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "browser_tabs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "browser_tabs_ownerUserId_sessionId_status_idx"
ON "browser_tabs"("ownerUserId", "sessionId", "status");
CREATE INDEX "browser_tabs_workspaceId_position_idx"
ON "browser_tabs"("workspaceId", "position");

CREATE TABLE "browser_tasks" (
    "id" TEXT NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "sessionId" TEXT,
    "tabId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT NOT NULL,
    "argumentHash" TEXT NOT NULL,
    "resultSha256" TEXT,
    "approvalRequestId" TEXT,
    "reasonCode" TEXT,
    "checkpointJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "browser_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "browser_tasks_ownerUserId_idempotencyKey_key"
ON "browser_tasks"("ownerUserId", "idempotencyKey");
CREATE INDEX "browser_tasks_ownerUserId_status_createdAt_idx"
ON "browser_tasks"("ownerUserId", "status", "createdAt");
CREATE INDEX "browser_tasks_sessionId_status_idx"
ON "browser_tasks"("sessionId", "status");

CREATE TABLE "browser_artifacts" (
    "id" TEXT NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "taskId" TEXT,
    "sessionId" TEXT,
    "type" TEXT NOT NULL,
    "displayName" TEXT,
    "mimeType" TEXT,
    "objectRef" TEXT,
    "sha256" TEXT,
    "sizeBytes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "browser_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "browser_artifacts_ownerUserId_createdAt_idx"
ON "browser_artifacts"("ownerUserId", "createdAt");
CREATE INDEX "browser_artifacts_taskId_idx"
ON "browser_artifacts"("taskId");
CREATE INDEX "browser_artifacts_expiresAt_idx"
ON "browser_artifacts"("expiresAt");

CREATE TABLE "browser_bookmarks" (
    "id" TEXT NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "title" TEXT,
    "urlWithoutQuery" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "browser_bookmarks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "browser_bookmarks_ownerUserId_updatedAt_idx"
ON "browser_bookmarks"("ownerUserId", "updatedAt");

CREATE TABLE "browser_history" (
    "id" TEXT NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "title" TEXT,
    "urlWithoutQuery" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "visitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "browser_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "browser_history_ownerUserId_visitedAt_idx"
ON "browser_history"("ownerUserId", "visitedAt");
