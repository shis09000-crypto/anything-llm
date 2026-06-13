ALTER TABLE "TrustedLoginDevice" ADD COLUMN "opaqueRegistrationRecord" TEXT;
ALTER TABLE "TrustedLoginDevice" ADD COLUMN "deviceSalt" TEXT;
ALTER TABLE "TrustedLoginDevice" ADD COLUMN "lastChallengeAt" DATETIME;
ALTER TABLE "TrustedLoginDevice" ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TrustedLoginDevice" ADD COLUMN "lockedUntil" DATETIME;

CREATE TABLE "ZkLoginAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "serverLoginState" TEXT NOT NULL,
    "requestIp" TEXT,
    "userAgent" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ZkLoginAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ZkLoginAttempt_userId_deviceId_idx" ON "ZkLoginAttempt"("userId", "deviceId");
CREATE INDEX "ZkLoginAttempt_expiresAt_idx" ON "ZkLoginAttempt"("expiresAt");
