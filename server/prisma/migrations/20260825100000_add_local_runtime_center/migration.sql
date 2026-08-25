CREATE TABLE "local_runtime_pairing_tickets" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerUserId" INTEGER NOT NULL,
  "ownerAuthUserId" TEXT NOT NULL,
  "clientId" TEXT,
  "tokenHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" DATETIME NOT NULL,
  "consumedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "local_runtime_pairing_tickets_tokenHash_key" ON "local_runtime_pairing_tickets"("tokenHash");
CREATE INDEX "local_runtime_pairing_tickets_ownerUserId_status_expiresAt_idx" ON "local_runtime_pairing_tickets"("ownerUserId", "status", "expiresAt");
CREATE INDEX "local_runtime_pairing_tickets_ownerAuthUserId_status_idx" ON "local_runtime_pairing_tickets"("ownerAuthUserId", "status");

CREATE TABLE "local_runtime_devices" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerUserId" INTEGER NOT NULL,
  "ownerAuthUserId" TEXT NOT NULL,
  "clientId" TEXT,
  "name" TEXT NOT NULL,
  "platform" TEXT NOT NULL DEFAULT 'macos',
  "version" TEXT,
  "publicKeyPem" TEXT NOT NULL,
  "keyAlgorithm" TEXT NOT NULL DEFAULT 'p256',
  "status" TEXT NOT NULL DEFAULT 'offline',
  "capabilitiesJson" TEXT NOT NULL DEFAULT '{}',
  "permissionsJson" TEXT NOT NULL DEFAULT '{}',
  "connectionId" TEXT,
  "lastSeenAt" DATETIME,
  "pairedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "local_runtime_devices_ownerAuthUserId_clientId_idx" ON "local_runtime_devices"("ownerAuthUserId", "clientId");
CREATE INDEX "local_runtime_devices_ownerUserId_status_lastSeenAt_idx" ON "local_runtime_devices"("ownerUserId", "status", "lastSeenAt");
CREATE INDEX "local_runtime_devices_ownerAuthUserId_status_idx" ON "local_runtime_devices"("ownerAuthUserId", "status");

CREATE TABLE "local_runtime_leases" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deviceId" TEXT NOT NULL,
  "ownerUserId" INTEGER NOT NULL,
  "ownerAuthUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "capabilitiesJson" TEXT NOT NULL DEFAULT '[]',
  "allowedRootsJson" TEXT NOT NULL DEFAULT '[]',
  "allowedAppsJson" TEXT NOT NULL DEFAULT '[]',
  "riskCeiling" TEXT NOT NULL DEFAULT 'L2',
  "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "revokedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "local_runtime_leases_deviceId_status_expiresAt_idx" ON "local_runtime_leases"("deviceId", "status", "expiresAt");
CREATE INDEX "local_runtime_leases_ownerUserId_status_expiresAt_idx" ON "local_runtime_leases"("ownerUserId", "status", "expiresAt");

CREATE TABLE "local_runtime_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerUserId" INTEGER NOT NULL,
  "ownerAuthUserId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "leaseId" TEXT NOT NULL,
  "responseId" TEXT,
  "toolInvocationId" TEXT,
  "toolName" TEXT NOT NULL,
  "riskLevel" TEXT NOT NULL DEFAULT 'L0',
  "stepUpApproved" BOOLEAN NOT NULL DEFAULT false,
  "priority" TEXT NOT NULL DEFAULT 'P2',
  "executionMode" TEXT NOT NULL DEFAULT 'interactive',
  "status" TEXT NOT NULL DEFAULT 'queued',
  "idempotencyKey" TEXT NOT NULL,
  "argumentHash" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL,
  "resultJson" TEXT,
  "resultHash" TEXT,
  "reasonCode" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "lastSequence" INTEGER NOT NULL DEFAULT 0,
  "deadlineAt" DATETIME NOT NULL,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "local_runtime_jobs_ownerUserId_idempotencyKey_key" ON "local_runtime_jobs"("ownerUserId", "idempotencyKey");
CREATE INDEX "local_runtime_jobs_deviceId_status_priority_createdAt_idx" ON "local_runtime_jobs"("deviceId", "status", "priority", "createdAt");
CREATE INDEX "local_runtime_jobs_responseId_status_idx" ON "local_runtime_jobs"("responseId", "status");
CREATE INDEX "local_runtime_jobs_toolInvocationId_status_idx" ON "local_runtime_jobs"("toolInvocationId", "status");

CREATE TABLE "local_runtime_job_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "jobId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "local_runtime_job_events_jobId_sequence_key" ON "local_runtime_job_events"("jobId", "sequence");
CREATE INDEX "local_runtime_job_events_jobId_createdAt_idx" ON "local_runtime_job_events"("jobId", "createdAt");
