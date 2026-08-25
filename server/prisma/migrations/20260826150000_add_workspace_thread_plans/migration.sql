ALTER TABLE "workspace_agent_invocations" ADD COLUMN "planId" TEXT;
ALTER TABLE "workspace_agent_invocations" ADD COLUMN "planAction" TEXT;

CREATE TABLE "workspace_thread_plans" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "uuid" TEXT NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "thread_id" INTEGER NOT NULL,
  "user_id" INTEGER,
  "goalId" TEXT,
  "objective" TEXT NOT NULL,
  "title" TEXT,
  "markdown" TEXT,
  "stepsJson" TEXT NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'drafting',
  "activeScopeKey" TEXT,
  "createClientTurnId" TEXT NOT NULL,
  "lastClientTurnId" TEXT,
  "executionClientTurnId" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt" DATETIME,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "abandonedAt" DATETIME
);
CREATE UNIQUE INDEX "workspace_thread_plans_uuid_key" ON "workspace_thread_plans"("uuid");
CREATE UNIQUE INDEX "workspace_thread_plans_activeScopeKey_key" ON "workspace_thread_plans"("activeScopeKey");
CREATE UNIQUE INDEX "workspace_thread_plans_createClientTurnId_key" ON "workspace_thread_plans"("createClientTurnId");
CREATE INDEX "workspace_thread_plans_workspace_id_thread_id_user_id_status_idx" ON "workspace_thread_plans"("workspace_id", "thread_id", "user_id", "status");
CREATE INDEX "workspace_thread_plans_thread_id_createdAt_idx" ON "workspace_thread_plans"("thread_id", "createdAt");
