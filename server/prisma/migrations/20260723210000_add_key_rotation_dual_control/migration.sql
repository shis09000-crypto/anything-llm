ALTER TABLE "security_key_rotation_jobs" ADD COLUMN "requiredApprovals" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "security_key_rotation_jobs" ADD COLUMN "approvalExpiresAt" DATETIME;
ALTER TABLE "security_key_rotation_jobs" ADD COLUMN "approvedAt" DATETIME;
ALTER TABLE "security_key_rotation_jobs" ADD COLUMN "executionStartedBy" INTEGER;

CREATE TABLE "security_key_rotation_approvals" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "approvalId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "approverUserId" INTEGER NOT NULL,
  "decision" TEXT NOT NULL DEFAULT 'approved',
  "metadata" TEXT,
  "approvedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "security_key_rotation_approvals_approvalId_key"
  ON "security_key_rotation_approvals"("approvalId");
CREATE UNIQUE INDEX "security_key_rotation_approvals_jobId_approverUserId_key"
  ON "security_key_rotation_approvals"("jobId", "approverUserId");
CREATE INDEX "security_key_rotation_approvals_jobId_decision_expiresAt_idx"
  ON "security_key_rotation_approvals"("jobId", "decision", "expiresAt");
CREATE INDEX "security_key_rotation_approvals_approverUserId_approvedAt_idx"
  ON "security_key_rotation_approvals"("approverUserId", "approvedAt");
