ALTER TABLE "athena_clients"
  ADD COLUMN "attestationProvider" TEXT,
  ADD COLUMN "attestationKeyIdHash" TEXT,
  ADD COLUMN "attestationStatus" TEXT DEFAULT 'unverified',
  ADD COLUMN "attestationEnvironment" TEXT,
  ADD COLUMN "attestationCounter" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attestedAt" TIMESTAMP(3),
  ADD COLUMN "attestationExpiresAt" TIMESTAMP(3);

CREATE TABLE "athena_device_attestation_challenges" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "clientId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "clientDataHash" TEXT NOT NULL,
  "keyBindingHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "athena_device_attestation_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "athena_device_attestation_challenges_userId_clientId_fkey"
    FOREIGN KEY ("userId", "clientId") REFERENCES "athena_clients" ("userId", "clientId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "athena_device_attestation_challenges_userId_clientId_status_idx"
  ON "athena_device_attestation_challenges"("userId", "clientId", "status");
CREATE INDEX "athena_device_attestation_challenges_expiresAt_idx"
  ON "athena_device_attestation_challenges"("expiresAt");
