ALTER TABLE "athena_mutation_receipts" ADD COLUMN "nodeKey" TEXT;
ALTER TABLE "athena_mutation_receipts" ADD COLUMN "mutationId" TEXT;
ALTER TABLE "athena_mutation_receipts" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "athena_mutation_receipts" ADD COLUMN "leaseExpiresAt" DATETIME;
ALTER TABLE "athena_mutation_receipts" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "athena_mutation_receipts" ADD COLUMN "lastErrorCode" TEXT;
ALTER TABLE "athena_mutation_receipts" ADD COLUMN "recoveredAt" DATETIME;

CREATE INDEX "athena_mutation_receipts_status_leaseExpiresAt_idx"
  ON "athena_mutation_receipts"("status", "leaseExpiresAt");
CREATE INDEX "athena_mutation_receipts_nodeKey_status_idx"
  ON "athena_mutation_receipts"("nodeKey", "status");
CREATE INDEX "athena_mutation_receipts_mutationId_idx"
  ON "athena_mutation_receipts"("mutationId");

ALTER TABLE "sync_outbox" ADD COLUMN "requestId" TEXT;
ALTER TABLE "sync_outbox" ADD COLUMN "traceId" TEXT;
ALTER TABLE "sync_outbox" ADD COLUMN "traceparent" TEXT;
ALTER TABLE "sync_outbox" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "sync_outbox" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sync_outbox" ADD COLUMN "nextAttemptAt" DATETIME;
ALTER TABLE "sync_outbox" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "sync_outbox" ADD COLUMN "leaseExpiresAt" DATETIME;
ALTER TABLE "sync_outbox" ADD COLUMN "lastErrorCode" TEXT;
ALTER TABLE "sync_outbox" ADD COLUMN "lastErrorDetail" TEXT;
ALTER TABLE "sync_outbox" ADD COLUMN "deadLetteredAt" DATETIME;

UPDATE "sync_outbox"
SET "status" = 'dispatched'
WHERE "dispatchedAt" IS NOT NULL;

CREATE INDEX "sync_outbox_status_nextAttemptAt_seq_idx"
  ON "sync_outbox"("status", "nextAttemptAt", "seq");
CREATE INDEX "sync_outbox_leaseOwner_leaseExpiresAt_idx"
  ON "sync_outbox"("leaseOwner", "leaseExpiresAt");
CREATE INDEX "sync_outbox_deadLetteredAt_seq_idx"
  ON "sync_outbox"("deadLetteredAt", "seq");

CREATE TABLE "security_audit_ledger" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "chainId" TEXT NOT NULL DEFAULT 'security-v1',
  "sequence" INTEGER NOT NULL,
  "eventId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "userId" INTEGER,
  "requestId" TEXT,
  "traceId" TEXT,
  "previousHash" TEXT NOT NULL,
  "entryHash" TEXT NOT NULL,
  "occurredAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "security_audit_ledger_eventId_key"
  ON "security_audit_ledger"("eventId");
CREATE UNIQUE INDEX "security_audit_ledger_entryHash_key"
  ON "security_audit_ledger"("entryHash");
CREATE UNIQUE INDEX "security_audit_ledger_chainId_sequence_key"
  ON "security_audit_ledger"("chainId", "sequence");
CREATE INDEX "security_audit_ledger_chainId_createdAt_idx"
  ON "security_audit_ledger"("chainId", "createdAt");
CREATE INDEX "security_audit_ledger_userId_createdAt_idx"
  ON "security_audit_ledger"("userId", "createdAt");

CREATE TABLE "security_audit_checkpoints" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "chainId" TEXT NOT NULL DEFAULT 'security-v1',
  "throughSequence" INTEGER NOT NULL,
  "throughHash" TEXT NOT NULL,
  "algorithm" TEXT NOT NULL DEFAULT 'ed25519',
  "keyId" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "security_audit_checkpoints_chainId_throughSequence_key"
  ON "security_audit_checkpoints"("chainId", "throughSequence");
CREATE INDEX "security_audit_checkpoints_keyId_createdAt_idx"
  ON "security_audit_checkpoints"("keyId", "createdAt");

ALTER TABLE "scheduled_jobs" ADD COLUMN "capabilityManifest" TEXT NOT NULL DEFAULT '{}';
UPDATE "scheduled_jobs"
SET "capabilityManifest" = '{"version":1,"tools":' || COALESCE("tools", '[]') || ',"scheduledAutoApprove":' || COALESCE("tools", '[]') || ',"allowHighRisk":false,"maxToolCalls":10}';
