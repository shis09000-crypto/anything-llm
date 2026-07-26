CREATE TABLE "crypto_account_connections" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "authUserId" INTEGER NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'gate',
  "environment" TEXT NOT NULL DEFAULT 'production',
  "status" TEXT NOT NULL DEFAULT 'pending_wrap',
  "readOnly" BOOLEAN NOT NULL DEFAULT true,
  "encryptedCredentials" TEXT NOT NULL,
  "platformWrappedDek" TEXT NOT NULL,
  "wrapVersion" TEXT NOT NULL,
  "rootKeyId" TEXT NOT NULL,
  "rootEpoch" INTEGER NOT NULL,
  "domainKeyVersion" INTEGER NOT NULL DEFAULT 1,
  "credentialVersion" INTEGER NOT NULL DEFAULT 1,
  "rotationState" TEXT NOT NULL DEFAULT 'stable',
  "credentialFingerprint" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "crypto_account_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crypto_account_connections_owner_provider_env"
ON "crypto_account_connections"("authUserId", "provider", "environment");

CREATE INDEX "crypto_account_connections_userId_status_idx"
ON "crypto_account_connections"("userId", "status");

CREATE INDEX "crypto_account_connections_authUserId_status_provider_idx"
ON "crypto_account_connections"("authUserId", "status", "provider");

CREATE INDEX "crypto_account_connections_rootKeyId_domainKeyVersion_idx"
ON "crypto_account_connections"("rootKeyId", "domainKeyVersion");

ALTER TABLE "scheduled_jobs"
ADD COLUMN "ownerUserId" INTEGER,
ADD COLUMN "ownerAuthUserId" INTEGER;

UPDATE "scheduled_jobs"
SET
  "ownerUserId" = owner."id",
  "ownerAuthUserId" = owner."authUserId"
FROM (
  SELECT "id", "authUserId"
  FROM "users"
  WHERE "status" = 'active'
    AND "ownerType" = 'primary'
    AND "authUserId" IS NOT NULL
  ORDER BY "id"
  LIMIT 1
) owner
WHERE (
  SELECT COUNT(*)
  FROM "users"
  WHERE "status" = 'active' AND "ownerType" = 'primary'
) = 1
AND (
  SELECT COUNT(*)
  FROM "users"
  WHERE "status" = 'active'
    AND "ownerType" = 'primary'
    AND "authUserId" IS NOT NULL
) = 1;

CREATE INDEX "scheduled_jobs_ownerUserId_enabled_idx"
ON "scheduled_jobs"("ownerUserId", "enabled");

CREATE INDEX "scheduled_jobs_ownerAuthUserId_enabled_idx"
ON "scheduled_jobs"("ownerAuthUserId", "enabled");
