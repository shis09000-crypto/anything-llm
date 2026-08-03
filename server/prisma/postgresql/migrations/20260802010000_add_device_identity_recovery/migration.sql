CREATE TABLE "auth_device_recovery_challenges" (
  "id" TEXT NOT NULL,
  "challengeHash" TEXT NOT NULL,
  "recoveryTicketHash" TEXT,
  "clientId" TEXT NOT NULL,
  "authUserId" INTEGER,
  "shadowUserId" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'issued',
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auth_device_recovery_challenges_pkey" PRIMARY KEY ("id")
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
