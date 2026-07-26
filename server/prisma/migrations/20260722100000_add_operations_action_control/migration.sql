CREATE TABLE "operations_action_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceActionId" TEXT NOT NULL,
  "actionId" TEXT NOT NULL,
  "actionVersion" TEXT NOT NULL,
  "riskLevel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "requestedBy" INTEGER,
  "requestedByType" TEXT NOT NULL DEFAULT 'human',
  "scopeJson" TEXT NOT NULL DEFAULT '{}',
  "parametersJson" TEXT NOT NULL DEFAULT '{}',
  "policyJson" TEXT NOT NULL DEFAULT '{}',
  "dryRunJson" TEXT NOT NULL DEFAULT '{}',
  "canaryJson" TEXT NOT NULL DEFAULT '{}',
  "resultJson" TEXT NOT NULL DEFAULT '{}',
  "validationJson" TEXT NOT NULL DEFAULT '{}',
  "rollbackJson" TEXT NOT NULL DEFAULT '{}',
  "errorCode" TEXT,
  "leaseOwner" TEXT,
  "leaseExpiresAt" DATETIME,
  "approvedAt" DATETIME,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "rolledBackAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "operations_action_runs_sourceActionId_key"
  ON "operations_action_runs"("sourceActionId");
CREATE INDEX "operations_action_runs_actionId_status_idx"
  ON "operations_action_runs"("actionId", "status");
CREATE INDEX "operations_action_runs_status_createdAt_idx"
  ON "operations_action_runs"("status", "createdAt");
CREATE INDEX "operations_action_runs_requestedBy_createdAt_idx"
  ON "operations_action_runs"("requestedBy", "createdAt");

CREATE TABLE "operations_action_approvals" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "runId" TEXT NOT NULL,
  "approverUserId" INTEGER NOT NULL,
  "decision" TEXT NOT NULL,
  "reasonCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "operations_action_approvals_runId_approverUserId_key"
  ON "operations_action_approvals"("runId", "approverUserId");
CREATE INDEX "operations_action_approvals_runId_decision_idx"
  ON "operations_action_approvals"("runId", "decision");
CREATE INDEX "operations_action_approvals_approverUserId_createdAt_idx"
  ON "operations_action_approvals"("approverUserId", "createdAt");
