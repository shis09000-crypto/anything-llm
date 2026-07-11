ALTER TABLE "workspaces" ADD COLUMN "sourceActionId" TEXT;
ALTER TABLE "workspace_threads" ADD COLUMN "sourceActionId" TEXT;
ALTER TABLE "workspace_chats" ADD COLUMN "clientTurnId" TEXT;

CREATE UNIQUE INDEX "workspaces_sourceActionId_key"
  ON "workspaces"("sourceActionId");
CREATE UNIQUE INDEX "workspace_threads_sourceActionId_key"
  ON "workspace_threads"("sourceActionId");
CREATE UNIQUE INDEX "workspace_chats_clientTurnId_key"
  ON "workspace_chats"("clientTurnId");
