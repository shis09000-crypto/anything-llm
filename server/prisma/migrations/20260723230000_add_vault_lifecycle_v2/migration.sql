ALTER TABLE "athena_clients" ADD COLUMN "vaultKeyGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "vault_device_key_envelopes" ADD COLUMN "sourceKeyGeneration" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "vault_device_key_envelopes" ADD COLUMN "targetKeyGeneration" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "vault_key_epochs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "keyEpoch" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'staging',
  "createdByClientId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" DATETIME,
  "retirementRequestedAt" DATETIME,
  "retiredAt" DATETIME,
  CONSTRAINT "vault_key_epochs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "vault_key_epochs_userId_keyEpoch_key" ON "vault_key_epochs"("userId", "keyEpoch");
CREATE INDEX "vault_key_epochs_userId_status_keyEpoch_idx" ON "vault_key_epochs"("userId", "status", "keyEpoch");

CREATE TABLE "vault_device_key_registrations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "clientId" TEXT NOT NULL,
  "keyGeneration" INTEGER NOT NULL,
  "suiteId" TEXT NOT NULL,
  "kemPublicKey" TEXT NOT NULL,
  "p256PublicKey" TEXT NOT NULL,
  "mlDSA65PublicKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "hardwareProtection" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededAt" DATETIME,
  "revokedAt" DATETIME,
  CONSTRAINT "vault_device_key_registrations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "vault_device_key_registrations_userId_clientId_keyGeneration_key" ON "vault_device_key_registrations"("userId", "clientId", "keyGeneration");
CREATE INDEX "vault_device_key_registrations_userId_clientId_status_idx" ON "vault_device_key_registrations"("userId", "clientId", "status");

CREATE TABLE "vault_epoch_acknowledgements" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "clientId" TEXT NOT NULL,
  "keyEpoch" INTEGER NOT NULL,
  "keyGeneration" INTEGER NOT NULL,
  "inventoryHash" TEXT,
  "acknowledgedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vault_epoch_acknowledgements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "vault_epoch_acknowledgements_userId_clientId_keyEpoch_key" ON "vault_epoch_acknowledgements"("userId", "clientId", "keyEpoch");
CREATE INDEX "vault_epoch_acknowledgements_userId_keyEpoch_idx" ON "vault_epoch_acknowledgements"("userId", "keyEpoch");

CREATE TABLE "vault_recovery_packages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "recoveryKeyId" TEXT NOT NULL,
  "keyEpoch" INTEGER NOT NULL,
  "suiteId" TEXT NOT NULL,
  "encryptedPackageJson" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "createdByClientId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastRecoveredAt" DATETIME,
  "revokedAt" DATETIME,
  CONSTRAINT "vault_recovery_packages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "vault_recovery_packages_userId_recoveryKeyId_key" ON "vault_recovery_packages"("userId", "recoveryKeyId");
CREATE INDEX "vault_recovery_packages_userId_status_keyEpoch_idx" ON "vault_recovery_packages"("userId", "status", "keyEpoch");
