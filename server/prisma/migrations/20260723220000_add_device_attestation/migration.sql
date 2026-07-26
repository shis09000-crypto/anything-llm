ALTER TABLE "athena_clients" ADD COLUMN "attestationProvider" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "attestationKeyIdHash" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "attestationStatus" TEXT DEFAULT 'unverified';
ALTER TABLE "athena_clients" ADD COLUMN "attestationEnvironment" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "attestationCounter" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "athena_clients" ADD COLUMN "attestedAt" DATETIME;
ALTER TABLE "athena_clients" ADD COLUMN "attestationExpiresAt" DATETIME;

CREATE TABLE "athena_device_attestation_challenges" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "clientId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "clientDataHash" TEXT NOT NULL,
  "keyBindingHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" DATETIME NOT NULL,
  "consumedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "athena_device_attestation_challenges_userId_clientId_fkey"
    FOREIGN KEY ("userId", "clientId") REFERENCES "athena_clients" ("userId", "clientId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "athena_device_attestation_challenges_userId_clientId_status_idx"
  ON "athena_device_attestation_challenges"("userId", "clientId", "status");
CREATE INDEX "athena_device_attestation_challenges_expiresAt_idx"
  ON "athena_device_attestation_challenges"("expiresAt");
