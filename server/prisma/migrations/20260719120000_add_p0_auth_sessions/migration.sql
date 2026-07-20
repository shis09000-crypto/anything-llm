CREATE TABLE "account_deletion_runs" (
  "runId" TEXT NOT NULL PRIMARY KEY,
  "targetUserId" INTEGER NOT NULL,
  "targetAuthUserId" INTEGER,
  "actorUserId" INTEGER,
  "env" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "currentStep" TEXT,
  "completedStepsJson" TEXT NOT NULL DEFAULT '[]',
  "contextJson" TEXT NOT NULL DEFAULT '{}',
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "errorJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME
);

CREATE INDEX "account_deletion_runs_targetUserId_status_idx"
ON "account_deletion_runs"("targetUserId", "status");
CREATE INDEX "account_deletion_runs_targetAuthUserId_status_idx"
ON "account_deletion_runs"("targetAuthUserId", "status");
CREATE INDEX "account_deletion_runs_createdAt_idx"
ON "account_deletion_runs"("createdAt");

CREATE TABLE "auth_sessions" (
  "sessionId" TEXT NOT NULL PRIMARY KEY,
  "subjectType" TEXT NOT NULL,
  "authUserId" INTEGER,
  "clientId" TEXT,
  "authMode" TEXT NOT NULL,
  "tokenVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idleExpiresAt" DATETIME NOT NULL,
  "absoluteExpiresAt" DATETIME NOT NULL,
  "revokedAt" DATETIME,
  "revokeReason" TEXT,
  CONSTRAINT "auth_sessions_authUserId_fkey"
    FOREIGN KEY ("authUserId") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "auth_sessions_authUserId_revokedAt_idx"
ON "auth_sessions"("authUserId", "revokedAt");
CREATE INDEX "auth_sessions_clientId_revokedAt_idx"
ON "auth_sessions"("clientId", "revokedAt");
CREATE INDEX "auth_sessions_idleExpiresAt_idx"
ON "auth_sessions"("idleExpiresAt");
CREATE INDEX "auth_sessions_absoluteExpiresAt_idx"
ON "auth_sessions"("absoluteExpiresAt");
