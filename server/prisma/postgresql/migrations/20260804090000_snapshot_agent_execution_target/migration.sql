ALTER TABLE "workspace_agent_invocations"
ADD COLUMN "requestedProvider" TEXT;

ALTER TABLE "workspace_agent_invocations"
ADD COLUMN "requestedModel" TEXT;
