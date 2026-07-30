CREATE TABLE "tool_invocations" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "approvalRequestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "lastUpdatedAt" DATETIME NOT NULL
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
    "id" TEXT NOT NULL PRIMARY KEY,
    "nonceHash" TEXT NOT NULL,
    "toolInvocationId" TEXT,
    "audience" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsHash" TEXT NOT NULL,
    "capabilityHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "plugin_capability_nonces_nonceHash_key"
ON "plugin_capability_nonces"("nonceHash");
CREATE INDEX "plugin_capability_nonces_expiresAt_idx"
ON "plugin_capability_nonces"("expiresAt");
CREATE INDEX "plugin_capability_nonces_toolInvocationId_consumedAt_idx"
ON "plugin_capability_nonces"("toolInvocationId", "consumedAt");
