CREATE TABLE "TrustedLoginDevice" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL DEFAULT 'This Device',
    "verifier" TEXT NOT NULL,
    "publicCommitment" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "TrustedLoginDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TrustedLoginDevice_userId_deviceId_key" ON "TrustedLoginDevice"("userId", "deviceId");
CREATE INDEX "TrustedLoginDevice_userId_idx" ON "TrustedLoginDevice"("userId");
CREATE INDEX "TrustedLoginDevice_userId_revokedAt_idx" ON "TrustedLoginDevice"("userId", "revokedAt");
