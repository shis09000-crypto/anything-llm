ALTER TABLE "responses_conversations" ADD COLUMN "conversationType" TEXT NOT NULL DEFAULT 'responses';
ALTER TABLE "responses_conversations" ADD COLUMN "characterId" TEXT;
ALTER TABLE "responses_conversations" ADD COLUMN "characterInstanceId" TEXT;
ALTER TABLE "responses_conversations" ADD COLUMN "currentTurnId" TEXT;
ALTER TABLE "responses_conversations" ADD COLUMN "stateRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "responses_conversations" ADD COLUMN "stateCiphertext" TEXT;
ALTER TABLE "responses_conversations" ADD COLUMN "stateHash" TEXT;
ALTER TABLE "responses_conversations" ADD COLUMN "previousActivity" TEXT;
ALTER TABLE "responses_conversations" ADD COLUMN "softCloseDueAt" DATETIME;
ALTER TABLE "responses_conversations" ADD COLUMN "suspensionReason" TEXT;
ALTER TABLE "responses_conversations" ADD COLUMN "suspendedAt" DATETIME;
ALTER TABLE "responses_conversations" ADD COLUMN "endedAt" DATETIME;

CREATE INDEX "responses_conversations_conversationType_status_softCloseDueAt_idx"
ON "responses_conversations"("conversationType", "status", "softCloseDueAt");

CREATE TABLE "character_conversation_turns" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "previousTurnId" TEXT,
    "responseId" TEXT,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "expectedStateRevision" INTEGER NOT NULL DEFAULT 0,
    "inputCiphertext" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "controlCiphertext" TEXT,
    "controlHash" TEXT,
    "modelWaitMs" INTEGER,
    "effectiveWaitMs" INTEGER,
    "timingSource" TEXT,
    "endReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "character_conversation_turns_idempotencyKey_key" ON "character_conversation_turns"("idempotencyKey");
CREATE UNIQUE INDEX "character_conversation_turns_conversationId_ordinal_key" ON "character_conversation_turns"("conversationId", "ordinal");
CREATE INDEX "character_conversation_turns_conversationId_createdAt_idx" ON "character_conversation_turns"("conversationId", "createdAt");
CREATE INDEX "character_conversation_turns_responseId_idx" ON "character_conversation_turns"("responseId");
CREATE INDEX "character_conversation_turns_status_lastUpdatedAt_idx" ON "character_conversation_turns"("status", "lastUpdatedAt");

CREATE TABLE "character_conversation_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conversationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "turnId" TEXT,
    "responseId" TEXT,
    "payloadCiphertext" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "character_conversation_events_conversationId_sequence_key" ON "character_conversation_events"("conversationId", "sequence");
CREATE INDEX "character_conversation_events_conversationId_createdAt_idx" ON "character_conversation_events"("conversationId", "createdAt");
CREATE INDEX "character_conversation_events_turnId_idx" ON "character_conversation_events"("turnId");
CREATE INDEX "character_conversation_events_responseId_idx" ON "character_conversation_events"("responseId");
