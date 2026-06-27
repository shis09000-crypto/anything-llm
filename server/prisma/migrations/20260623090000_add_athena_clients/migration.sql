CREATE TABLE "athena_clients" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "clientId" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "platform" TEXT NOT NULL,
  "deviceName" TEXT,
  "appVersion" TEXT,
  "trustLevel" TEXT NOT NULL DEFAULT 'low',
  "capabilities" TEXT,
  "capabilitySource" TEXT NOT NULL DEFAULT 'unknown',
  "publicKey" TEXT,
  "deviceFingerprintVersion" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" DATETIME,
  CONSTRAINT "athena_clients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "athena_clients_userId_clientId_key" ON "athena_clients"("userId", "clientId");
CREATE INDEX "athena_clients_clientId_idx" ON "athena_clients"("clientId");
CREATE INDEX "athena_clients_userId_revokedAt_idx" ON "athena_clients"("userId", "revokedAt");
