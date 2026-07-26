CREATE TABLE "user_domain_key_wraps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "authUserId" INTEGER NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "wrapVersion" TEXT NOT NULL,
    "rootKeyId" TEXT NOT NULL,
    "rootEpoch" INTEGER NOT NULL,
    "domainKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "platformWrapVersion" TEXT,
    "platformKeyId" TEXT,
    "userWrappedKeyJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdByClientId" TEXT,
    "migrationJobId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

CREATE TABLE "user_domain_migration_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "authUserId" INTEGER NOT NULL,
    "resourceType" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "checkpointJson" TEXT NOT NULL DEFAULT '{}',
    "batchSize" INTEGER NOT NULL DEFAULT 100,
    "scannedCount" INTEGER NOT NULL DEFAULT 0,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "createdByClientId" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

CREATE UNIQUE INDEX "user_domain_key_wraps_resource_key"
ON "user_domain_key_wraps"(
    "authUserId",
    "resourceType",
    "resourceId",
    "domain",
    "rootKeyId",
    "domainKeyVersion"
);

CREATE UNIQUE INDEX "user_domain_key_wraps_idempotencyKey_key"
ON "user_domain_key_wraps"("idempotencyKey");

CREATE INDEX "user_domain_key_wraps_userId_status_createdAt_idx"
ON "user_domain_key_wraps"("userId", "status", "createdAt");

CREATE INDEX "user_domain_key_wraps_authUserId_domain_status_idx"
ON "user_domain_key_wraps"("authUserId", "domain", "status");

CREATE INDEX "user_domain_key_wraps_rootKeyId_domainKeyVersion_idx"
ON "user_domain_key_wraps"("rootKeyId", "domainKeyVersion");

CREATE UNIQUE INDEX "user_domain_migration_jobs_idempotencyKey_key"
ON "user_domain_migration_jobs"("idempotencyKey");

CREATE INDEX "user_domain_migration_jobs_authUserId_status_updatedAt_idx"
ON "user_domain_migration_jobs"("authUserId", "status", "updatedAt");

CREATE INDEX "user_domain_migration_jobs_resourceType_domain_status_idx"
ON "user_domain_migration_jobs"("resourceType", "domain", "status");
