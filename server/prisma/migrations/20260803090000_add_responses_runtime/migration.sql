CREATE TABLE "responses_conversations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeKey" TEXT NOT NULL,
    "workspaceId" INTEGER,
    "threadId" INTEGER,
    "agentRunId" TEXT,
    "ownerUserId" INTEGER,
    "currentHeadResponseId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME
);
CREATE UNIQUE INDEX "responses_conversations_scopeKey_key" ON "responses_conversations"("scopeKey");
CREATE INDEX "responses_conversations_workspaceId_threadId_idx" ON "responses_conversations"("workspaceId", "threadId");
CREATE INDEX "responses_conversations_agentRunId_idx" ON "responses_conversations"("agentRunId");
CREATE INDEX "responses_conversations_status_lastUpdatedAt_idx" ON "responses_conversations"("status", "lastUpdatedAt");

CREATE TABLE "responses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT,
    "previousResponseId" TEXT,
    "chatRunId" TEXT,
    "agentRunId" TEXT,
    "ownerUserId" INTEGER,
    "idempotencyKey" TEXT,
    "taskPriority" TEXT NOT NULL DEFAULT 'P2',
    "taskIntent" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "requestedProtocol" TEXT NOT NULL DEFAULT 'responses',
    "effectiveProtocol" TEXT,
    "degradedReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "background" BOOLEAN NOT NULL DEFAULT false,
    "store" BOOLEAN NOT NULL DEFAULT true,
    "inputHash" TEXT NOT NULL,
    "branchReason" TEXT,
    "usageJson" TEXT,
    "resultSha256" TEXT,
    "errorCode" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "cancelRequestedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "expiresAt" DATETIME,
    "contentPrunedAt" DATETIME,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "responses_conversationId_createdAt_idx" ON "responses"("conversationId", "createdAt");
CREATE UNIQUE INDEX "responses_idempotencyKey_key" ON "responses"("idempotencyKey");
CREATE INDEX "responses_previousResponseId_idx" ON "responses"("previousResponseId");
CREATE INDEX "responses_chatRunId_idx" ON "responses"("chatRunId");
CREATE INDEX "responses_agentRunId_idx" ON "responses"("agentRunId");
CREATE INDEX "responses_status_background_leaseExpiresAt_idx" ON "responses"("status", "background", "leaseExpiresAt");
CREATE INDEX "responses_expiresAt_idx" ON "responses"("expiresAt");
CREATE INDEX "responses_contentPrunedAt_idx" ON "responses"("contentPrunedAt");

CREATE TABLE "response_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "responseId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "itemType" TEXT NOT NULL,
    "role" TEXT,
    "callId" TEXT,
    "status" TEXT,
    "payloadCiphertext" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "response_items_responseId_sequence_key" ON "response_items"("responseId", "sequence");
CREATE INDEX "response_items_responseId_createdAt_idx" ON "response_items"("responseId", "createdAt");
CREATE INDEX "response_items_callId_idx" ON "response_items"("callId");

CREATE TABLE "response_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "responseId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadCiphertext" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "response_events_responseId_sequence_key" ON "response_events"("responseId", "sequence");
CREATE INDEX "response_events_responseId_createdAt_idx" ON "response_events"("responseId", "createdAt");

CREATE TABLE "response_checkpoints" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "responseId" TEXT NOT NULL,
    "stateCiphertext" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "response_checkpoints_responseId_key" ON "response_checkpoints"("responseId");

CREATE TABLE "response_compactions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "throughResponseId" TEXT NOT NULL,
    "sourceCapsuleId" TEXT,
    "payloadCiphertext" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "response_compactions_conversationId_createdAt_idx" ON "response_compactions"("conversationId", "createdAt");
CREATE INDEX "response_compactions_throughResponseId_idx" ON "response_compactions"("throughResponseId");
