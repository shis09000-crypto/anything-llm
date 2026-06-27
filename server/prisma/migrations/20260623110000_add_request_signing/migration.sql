ALTER TABLE "athena_clients" ADD COLUMN "signingSecretEncrypted" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "signingSecretVersion" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "signingSecretIssuedAt" DATETIME;

CREATE TABLE "athena_request_nonces" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "clientId" TEXT NOT NULL,
  "userId" INTEGER,
  "nonce" TEXT NOT NULL,
  "requestId" TEXT,
  "timestamp" DATETIME NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "athena_request_nonces_clientId_nonce_key" ON "athena_request_nonces"("clientId", "nonce");
CREATE INDEX "athena_request_nonces_expiresAt_idx" ON "athena_request_nonces"("expiresAt");
CREATE INDEX "athena_request_nonces_clientId_createdAt_idx" ON "athena_request_nonces"("clientId", "createdAt");
