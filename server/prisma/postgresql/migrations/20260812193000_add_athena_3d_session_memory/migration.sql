ALTER TABLE "character_conversation_turns"
  ADD COLUMN "expectedMemoryRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "memoryStatus" TEXT NOT NULL DEFAULT 'preparing',
  ADD COLUMN "memoryCommitAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "memoryErrorCode" TEXT,
  ADD COLUMN "memoryCommittedAt" TIMESTAMP(3);

CREATE TABLE "athena_3d_session_memories" (
  "conversationId" TEXT NOT NULL,
  "workspaceId" INTEGER,
  "threadId" INTEGER,
  "ownerUserId" INTEGER,
  "agentRunId" TEXT,
  "characterId" TEXT NOT NULL,
  "characterInstanceId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "activeCheckpointId" TEXT,
  "lastCommittedTurnOrdinal" INTEGER NOT NULL DEFAULT 0,
  "memoryRevision" INTEGER NOT NULL DEFAULT 0,
  "stateRevision" INTEGER NOT NULL DEFAULT 0,
  "uncompactedTokens" INTEGER NOT NULL DEFAULT 0,
  "uncompactedTurns" INTEGER NOT NULL DEFAULT 0,
  "projectedContextTokens" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "athena_3d_session_memories_pkey" PRIMARY KEY ("conversationId")
);

CREATE TABLE "athena_3d_session_memory_turns" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "responseId" TEXT,
  "userCiphertext" TEXT NOT NULL,
  "assistantCiphertext" TEXT NOT NULL,
  "languageHash" TEXT NOT NULL,
  "tokenCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "athena_3d_session_memory_turns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "athena_3d_session_memory_checkpoints" (
  "id" TEXT NOT NULL,
  "rangeKey" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "previousCheckpointId" TEXT,
  "coveredFromOrdinal" INTEGER NOT NULL,
  "coveredToOrdinal" INTEGER NOT NULL,
  "summaryCiphertext" TEXT,
  "sourceHash" TEXT NOT NULL,
  "summaryHash" TEXT,
  "provider" TEXT,
  "model" TEXT,
  "compressionVersion" TEXT NOT NULL,
  "tokenBefore" INTEGER NOT NULL DEFAULT 0,
  "tokenAfter" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "athena_3d_session_memory_checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "athena_3d_character_state_windows" (
  "conversationId" TEXT NOT NULL,
  "stateRevision" INTEGER NOT NULL DEFAULT 0,
  "previousCiphertext" TEXT NOT NULL,
  "transitionCiphertext" TEXT,
  "currentCiphertext" TEXT NOT NULL,
  "windowHash" TEXT NOT NULL,
  "tokenCount" INTEGER NOT NULL DEFAULT 0,
  "sourceTurnId" TEXT,
  "sourceResponseId" TEXT,
  "sourceSequenceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "athena_3d_character_state_windows_pkey" PRIMARY KEY ("conversationId")
);

CREATE INDEX "athena_3d_session_memories_workspaceId_threadId_status_idx" ON "athena_3d_session_memories"("workspaceId", "threadId", "status");
CREATE INDEX "athena_3d_session_memories_ownerUserId_status_idx" ON "athena_3d_session_memories"("ownerUserId", "status");
CREATE INDEX "athena_3d_session_memories_status_lastUpdatedAt_idx" ON "athena_3d_session_memories"("status", "lastUpdatedAt");
CREATE UNIQUE INDEX "athena_3d_session_memory_turns_conversationId_ordinal_key" ON "athena_3d_session_memory_turns"("conversationId", "ordinal");
CREATE INDEX "athena_3d_session_memory_turns_conversationId_createdAt_idx" ON "athena_3d_session_memory_turns"("conversationId", "createdAt");
CREATE INDEX "athena_3d_session_memory_turns_responseId_idx" ON "athena_3d_session_memory_turns"("responseId");
CREATE UNIQUE INDEX "athena_3d_session_memory_checkpoints_rangeKey_key" ON "athena_3d_session_memory_checkpoints"("rangeKey");
CREATE INDEX "athena_3d_session_memory_checkpoints_conversationId_createdAt_idx" ON "athena_3d_session_memory_checkpoints"("conversationId", "createdAt");
CREATE INDEX "athena_3d_session_memory_checkpoints_status_leaseExpiresAt_idx" ON "athena_3d_session_memory_checkpoints"("status", "leaseExpiresAt");
CREATE INDEX "athena_3d_session_memory_checkpoints_previousCheckpointId_idx" ON "athena_3d_session_memory_checkpoints"("previousCheckpointId");
CREATE INDEX "athena_3d_character_state_windows_stateRevision_lastUpdatedAt_idx" ON "athena_3d_character_state_windows"("stateRevision", "lastUpdatedAt");
CREATE INDEX "athena_3d_character_state_windows_sourceTurnId_idx" ON "athena_3d_character_state_windows"("sourceTurnId");
