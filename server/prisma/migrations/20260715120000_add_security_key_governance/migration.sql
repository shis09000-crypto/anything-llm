CREATE TABLE "security_key_registry" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "keyId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "providerType" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "canaryEnvelope" TEXT,
  "sourceDescriptor" TEXT,
  "metadata" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" DATETIME,
  "retiredAt" DATETIME,
  "lastVerifiedAt" DATETIME
);

CREATE UNIQUE INDEX "security_key_registry_keyId_key"
  ON "security_key_registry"("keyId");
CREATE INDEX "security_key_registry_purpose_status_idx"
  ON "security_key_registry"("purpose", "status");
CREATE INDEX "security_key_registry_fingerprint_idx"
  ON "security_key_registry"("fingerprint");

CREATE TABLE "security_key_domain_bindings" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "domain" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "activeKeyId" TEXT NOT NULL,
  "envelopeVersion" TEXT NOT NULL DEFAULT 'enc:v1',
  "coverageState" TEXT NOT NULL DEFAULT 'unknown',
  "coverage" TEXT,
  "lastVerifiedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "security_key_domain_bindings_domain_key"
  ON "security_key_domain_bindings"("domain");
CREATE INDEX "security_key_domain_bindings_purpose_idx"
  ON "security_key_domain_bindings"("purpose");
CREATE INDEX "security_key_domain_bindings_activeKeyId_idx"
  ON "security_key_domain_bindings"("activeKeyId");

CREATE TABLE "security_key_rotation_jobs" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "jobId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "sourceKeyId" TEXT,
  "targetKeyId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "stage" TEXT NOT NULL DEFAULT 'prepare',
  "progress" TEXT,
  "failure" TEXT,
  "createdBy" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME
);

CREATE UNIQUE INDEX "security_key_rotation_jobs_jobId_key"
  ON "security_key_rotation_jobs"("jobId");
CREATE UNIQUE INDEX "security_key_rotation_jobs_idempotencyKey_key"
  ON "security_key_rotation_jobs"("idempotencyKey");
CREATE INDEX "security_key_rotation_jobs_purpose_status_idx"
  ON "security_key_rotation_jobs"("purpose", "status");
CREATE INDEX "security_key_rotation_jobs_createdAt_idx"
  ON "security_key_rotation_jobs"("createdAt");

CREATE TABLE "security_key_events" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "event" TEXT NOT NULL,
  "keyId" TEXT,
  "purpose" TEXT,
  "jobId" TEXT,
  "metadata" TEXT,
  "createdBy" INTEGER,
  "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "security_key_events_event_idx" ON "security_key_events"("event");
CREATE INDEX "security_key_events_keyId_idx" ON "security_key_events"("keyId");
CREATE INDEX "security_key_events_jobId_idx" ON "security_key_events"("jobId");
