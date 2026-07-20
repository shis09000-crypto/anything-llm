ALTER TABLE "athena_mutation_receipts" ADD COLUMN "baseVersion" INTEGER;
ALTER TABLE "athena_mutation_receipts" ADD COLUMN "resultVersion" INTEGER;
ALTER TABLE "athena_mutation_receipts" ADD COLUMN "requestHash" TEXT;
ALTER TABLE "athena_mutation_receipts" ADD COLUMN "resultJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "athena_mutation_receipts" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "workspace_chats" ADD COLUMN "messageVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "workspace_chats" ADD COLUMN "deletedAt" DATETIME;

CREATE TABLE "sync_nodes" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "nodeKey" TEXT NOT NULL,
  "parentKey" TEXT,
  "ownerType" TEXT NOT NULL,
  "ownerId" INTEGER,
  "visibility" TEXT NOT NULL DEFAULT 'user',
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "stateVersion" INTEGER NOT NULL DEFAULT 1,
  "contentHash" TEXT,
  "hashAlgorithm" TEXT NOT NULL DEFAULT 'sha256',
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" DATETIME
);

CREATE UNIQUE INDEX "sync_nodes_nodeKey_key" ON "sync_nodes"("nodeKey");
CREATE INDEX "sync_nodes_ownerType_ownerId_idx" ON "sync_nodes"("ownerType", "ownerId");
CREATE INDEX "sync_nodes_parentKey_idx" ON "sync_nodes"("parentKey");
CREATE INDEX "sync_nodes_updatedAt_idx" ON "sync_nodes"("updatedAt");

CREATE TABLE "sync_outbox" (
  "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "eventId" TEXT NOT NULL,
  "nodeKey" TEXT NOT NULL,
  "ownerType" TEXT NOT NULL,
  "ownerId" INTEGER,
  "visibility" TEXT NOT NULL DEFAULT 'user',
  "stateVersion" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "changedPathsJson" TEXT NOT NULL DEFAULT '[]',
  "payloadHintJson" TEXT NOT NULL DEFAULT '{}',
  "audienceJson" TEXT NOT NULL DEFAULT '[]',
  "originClientId" TEXT,
  "mutationId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "dispatchedAt" DATETIME
);

CREATE UNIQUE INDEX "sync_outbox_eventId_key" ON "sync_outbox"("eventId");
CREATE INDEX "sync_outbox_nodeKey_stateVersion_idx" ON "sync_outbox"("nodeKey", "stateVersion");
CREATE INDEX "sync_outbox_ownerType_ownerId_seq_idx" ON "sync_outbox"("ownerType", "ownerId", "seq");
CREATE INDEX "sync_outbox_expiresAt_idx" ON "sync_outbox"("expiresAt");
CREATE INDEX "sync_outbox_dispatchedAt_seq_idx" ON "sync_outbox"("dispatchedAt", "seq");
CREATE UNIQUE INDEX "sync_outbox_nodeKey_mutationId_key" ON "sync_outbox"("nodeKey", "mutationId");

CREATE TABLE "sync_client_cursors" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "clientId" TEXT NOT NULL,
  "platform" TEXT,
  "lastAppliedSeq" INTEGER NOT NULL DEFAULT 0,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "sync_client_cursors_userId_clientId_key" ON "sync_client_cursors"("userId", "clientId");
CREATE INDEX "sync_client_cursors_userId_lastAppliedSeq_idx" ON "sync_client_cursors"("userId", "lastAppliedSeq");
CREATE INDEX "sync_client_cursors_lastSeenAt_idx" ON "sync_client_cursors"("lastSeenAt");
