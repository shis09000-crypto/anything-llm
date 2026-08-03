CREATE TABLE "auth_device_recovery_challenges" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "challengeHash" TEXT NOT NULL,
  "recoveryTicketHash" TEXT,
  "clientId" TEXT NOT NULL,
  "authUserId" INTEGER,
  "shadowUserId" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'issued',
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" DATETIME NOT NULL,
  "consumedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "auth_device_recovery_challenges_challengeHash_key"
ON "auth_device_recovery_challenges"("challengeHash");
CREATE UNIQUE INDEX "auth_device_recovery_challenges_recoveryTicketHash_key"
ON "auth_device_recovery_challenges"("recoveryTicketHash");
CREATE INDEX "auth_device_recovery_challenges_clientId_status_expiresAt_idx"
ON "auth_device_recovery_challenges"("clientId", "status", "expiresAt");
CREATE INDEX "auth_device_recovery_challenges_authUserId_status_idx"
ON "auth_device_recovery_challenges"("authUserId", "status");
CREATE INDEX "auth_device_recovery_challenges_expiresAt_idx"
ON "auth_device_recovery_challenges"("expiresAt");
