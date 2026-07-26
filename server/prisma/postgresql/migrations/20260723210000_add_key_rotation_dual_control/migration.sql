ALTER TABLE "security_key_rotation_jobs"
  ADD COLUMN "requiredApprovals" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "approvalExpiresAt" TIMESTAMP(3),
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "executionStartedBy" INTEGER;

CREATE TABLE "security_key_rotation_approvals" (
  "id" SERIAL NOT NULL,
  "approvalId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "approverUserId" INTEGER NOT NULL,
  "decision" TEXT NOT NULL DEFAULT 'approved',
  "metadata" TEXT,
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "security_key_rotation_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "security_key_rotation_approvals_approvalId_key"
  ON "security_key_rotation_approvals"("approvalId");
CREATE UNIQUE INDEX "security_key_rotation_approvals_jobId_approverUserId_key"
  ON "security_key_rotation_approvals"("jobId", "approverUserId");
CREATE INDEX "security_key_rotation_approvals_jobId_decision_expiresAt_idx"
  ON "security_key_rotation_approvals"("jobId", "decision", "expiresAt");
CREATE INDEX "security_key_rotation_approvals_approverUserId_approvedAt_idx"
  ON "security_key_rotation_approvals"("approverUserId", "approvedAt");
