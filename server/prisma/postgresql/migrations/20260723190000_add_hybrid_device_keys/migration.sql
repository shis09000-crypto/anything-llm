ALTER TABLE "athena_clients" ADD COLUMN "pqPublicKey" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "pqKeyAlgorithm" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "pqPublicKeyParameterSet" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "pqPublicKeyOrigin" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "pqPublicKeyHardwareProtection" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "hybridKemPublicKey" TEXT;
ALTER TABLE "athena_clients" ADD COLUMN "hybridKemSuiteId" TEXT;

CREATE TABLE "vault_device_key_envelopes" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "sourceClientId" TEXT NOT NULL,
  "targetClientId" TEXT NOT NULL,
  "keyEpoch" INTEGER NOT NULL,
  "envelopeJson" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "vault_device_key_envelopes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vault_device_key_envelopes_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "vault_device_key_envelopes_userId_targetClientId_keyEpoch_key"
  ON "vault_device_key_envelopes"("userId", "targetClientId", "keyEpoch");
CREATE INDEX "vault_device_key_envelopes_userId_targetClientId_consumedAt_idx"
  ON "vault_device_key_envelopes"("userId", "targetClientId", "consumedAt");
