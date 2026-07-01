CREATE TABLE "email_verification_grants" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "grant_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "grant_hash" TEXT NOT NULL,
    "challenge_id" TEXT,
    "email" TEXT NOT NULL,
    "client_id" TEXT,
    "device_id" TEXT,
    "session_id" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_verification_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "email_verification_rate_limits" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "bucket_hash" TEXT NOT NULL,
    "bucket_type" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "window_start" DATETIME NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "blockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "email_verification_grants_grant_id_key" ON "email_verification_grants"("grant_id");
CREATE UNIQUE INDEX "email_verification_grants_grant_hash_key" ON "email_verification_grants"("grant_hash");
CREATE INDEX "email_verification_grants_user_id_scope_idx" ON "email_verification_grants"("user_id", "scope");
CREATE INDEX "email_verification_grants_challenge_id_idx" ON "email_verification_grants"("challenge_id");
CREATE INDEX "email_verification_grants_client_id_scope_idx" ON "email_verification_grants"("client_id", "scope");
CREATE INDEX "email_verification_grants_expiresAt_idx" ON "email_verification_grants"("expiresAt");

CREATE UNIQUE INDEX "email_verification_rate_limits_bucket_hash_key" ON "email_verification_rate_limits"("bucket_hash");
CREATE INDEX "email_verification_rate_limits_bucket_type_purpose_idx" ON "email_verification_rate_limits"("bucket_type", "purpose");
CREATE INDEX "email_verification_rate_limits_blockedUntil_idx" ON "email_verification_rate_limits"("blockedUntil");
CREATE INDEX "email_verification_rate_limits_window_start_idx" ON "email_verification_rate_limits"("window_start");
