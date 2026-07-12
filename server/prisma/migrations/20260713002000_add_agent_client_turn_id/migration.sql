ALTER TABLE "workspace_agent_invocations"
ADD COLUMN "clientTurnId" TEXT;

CREATE UNIQUE INDEX "workspace_agent_invocations_clientTurnId_key"
ON "workspace_agent_invocations"("clientTurnId");
