ALTER TABLE "workspace_agent_invocations" ADD COLUMN "effectiveModel" TEXT;
ALTER TABLE "workspace_agent_invocations" ADD COLUMN "turnMode" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "workspace_agent_invocations" ADD COLUMN "goalId" TEXT;

CREATE TABLE "workspace_thread_goals" (
  "id" SERIAL NOT NULL,
  "uuid" TEXT NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "thread_id" INTEGER NOT NULL,
  "user_id" INTEGER,
  "objective" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "activeScopeKey" TEXT,
  "sourceClientTurnId" TEXT NOT NULL,
  "pendingStatus" TEXT,
  "pendingStatusClientTurnId" TEXT,
  "statusClientTurnId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "blockedAt" TIMESTAMP(3),
  "abandonedAt" TIMESTAMP(3),
  CONSTRAINT "workspace_thread_goals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspace_thread_goals_uuid_key" ON "workspace_thread_goals"("uuid");
CREATE UNIQUE INDEX "workspace_thread_goals_activeScopeKey_key" ON "workspace_thread_goals"("activeScopeKey");
CREATE UNIQUE INDEX "workspace_thread_goals_sourceClientTurnId_key" ON "workspace_thread_goals"("sourceClientTurnId");
CREATE INDEX "workspace_thread_goals_workspace_id_thread_id_user_id_status_idx" ON "workspace_thread_goals"("workspace_id", "thread_id", "user_id", "status");
CREATE INDEX "workspace_thread_goals_thread_id_createdAt_idx" ON "workspace_thread_goals"("thread_id", "createdAt");
