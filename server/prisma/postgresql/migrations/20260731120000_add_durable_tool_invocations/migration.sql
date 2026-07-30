CREATE TABLE "tool_invocations" (
    "id" TEXT NOT NULL,
    "approvalRequestId" TEXT NOT NULL,
    "agentInvocationId" TEXT,
    "clientTurnId" TEXT,
    "ownerUserId" INTEGER,
    "ownerAuthUserId" TEXT,
    "toolName" TEXT NOT NULL,
    "approvalClass" TEXT,
    "status" TEXT NOT NULL DEFAULT 'approval_requested',
    "scopeJson" TEXT NOT NULL DEFAULT '{}',
    "scopeHash" TEXT NOT NULL,
    "argumentHash" TEXT,
    "resultHash" TEXT,
    "reasonCode" TEXT,
    "approvalRequestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tool_invocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tool_invocations_approvalRequestId_key"
ON "tool_invocations"("approvalRequestId");
CREATE INDEX "tool_invocations_agentInvocationId_status_idx"
ON "tool_invocations"("agentInvocationId", "status");
CREATE INDEX "tool_invocations_ownerUserId_status_approvalRequestedAt_idx"
ON "tool_invocations"("ownerUserId", "status", "approvalRequestedAt");
CREATE INDEX "tool_invocations_toolName_status_approvalRequestedAt_idx"
ON "tool_invocations"("toolName", "status", "approvalRequestedAt");

CREATE TABLE "plugin_capability_nonces" (
    "id" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "toolInvocationId" TEXT,
    "audience" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsHash" TEXT NOT NULL,
    "capabilityHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plugin_capability_nonces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plugin_capability_nonces_nonceHash_key"
ON "plugin_capability_nonces"("nonceHash");
CREATE INDEX "plugin_capability_nonces_expiresAt_idx"
ON "plugin_capability_nonces"("expiresAt");
CREATE INDEX "plugin_capability_nonces_toolInvocationId_consumedAt_idx"
ON "plugin_capability_nonces"("toolInvocationId", "consumedAt");
