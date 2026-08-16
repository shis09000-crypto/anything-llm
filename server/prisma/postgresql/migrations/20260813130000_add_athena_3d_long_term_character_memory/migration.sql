ALTER TABLE "athena_3d_session_memories" ADD COLUMN "memoryMode" TEXT NOT NULL DEFAULT 'ephemeral';
ALTER TABLE "athena_3d_session_memories" ADD COLUMN "longTermProfileId" TEXT;
ALTER TABLE "athena_3d_session_memories" ADD COLUMN "longTermProfileRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "athena_3d_session_memories" ADD COLUMN "longTermContextJson" TEXT;

CREATE TABLE "athena_3d_character_memory_profiles" (
  "id" TEXT PRIMARY KEY,
  "ownerUserId" INTEGER NOT NULL,
  "characterId" TEXT NOT NULL,
  "characterInstanceId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "relationshipJson" TEXT NOT NULL,
  "emotionJson" TEXT NOT NULL,
  "latestSessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "athena_3d_character_memory_profiles_owner_character_instance_key" ON "athena_3d_character_memory_profiles"("ownerUserId", "characterId", "characterInstanceId");
CREATE INDEX "athena_3d_character_memory_profiles_owner_updated_idx" ON "athena_3d_character_memory_profiles"("ownerUserId", "lastUpdatedAt");

CREATE TABLE "athena_3d_character_memory_sessions" (
  "id" TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL UNIQUE,
  "profileId" TEXT NOT NULL,
  "workspaceId" INTEGER,
  "threadId" INTEGER,
  "ownerUserId" INTEGER NOT NULL,
  "characterId" TEXT NOT NULL,
  "characterInstanceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'archived',
  "finalizationEpoch" INTEGER NOT NULL DEFAULT 0,
  "archivedThroughOrdinal" INTEGER NOT NULL DEFAULT 0,
  "finalizedThroughOrdinal" INTEGER NOT NULL DEFAULT 0,
  "summaryJson" TEXT,
  "finalStateSnapshotJson" TEXT NOT NULL,
  "finalStateHash" TEXT NOT NULL,
  "sourceStateRevision" INTEGER NOT NULL DEFAULT 0,
  "sourceTurnId" TEXT,
  "sourceResponseId" TEXT,
  "sourceContextRefJson" TEXT,
  "prefixSha256" TEXT,
  "cacheMode" TEXT,
  "providerCacheHitTokens" INTEGER,
  "providerCacheMissTokens" INTEGER,
  "providerCacheHitRate" DOUBLE PRECISION,
  "finalizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "athena_3d_character_memory_sessions_profile_created_idx" ON "athena_3d_character_memory_sessions"("profileId", "createdAt");
CREATE INDEX "athena_3d_character_memory_sessions_owner_instance_created_idx" ON "athena_3d_character_memory_sessions"("ownerUserId", "characterInstanceId", "createdAt");
CREATE INDEX "athena_3d_character_memory_sessions_status_updated_idx" ON "athena_3d_character_memory_sessions"("status", "lastUpdatedAt");

CREATE TABLE "athena_3d_character_memory_turns" (
  "id" TEXT PRIMARY KEY,
  "memorySessionId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "sourceTurnId" TEXT NOT NULL,
  "responseId" TEXT,
  "userJson" TEXT NOT NULL,
  "assistantJson" TEXT NOT NULL,
  "languageHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "athena_3d_character_memory_turns_conversation_ordinal_key" ON "athena_3d_character_memory_turns"("conversationId", "ordinal");
CREATE INDEX "athena_3d_character_memory_turns_session_ordinal_idx" ON "athena_3d_character_memory_turns"("memorySessionId", "ordinal");
CREATE INDEX "athena_3d_character_memory_turns_response_idx" ON "athena_3d_character_memory_turns"("responseId");

CREATE TABLE "athena_3d_character_memory_revisions" (
  "id" TEXT PRIMARY KEY,
  "profileId" TEXT NOT NULL,
  "memorySessionId" TEXT NOT NULL,
  "finalizationEpoch" INTEGER NOT NULL,
  "fromRevision" INTEGER NOT NULL,
  "toRevision" INTEGER NOT NULL,
  "relationshipBeforeJson" TEXT NOT NULL,
  "relationshipDeltaJson" TEXT NOT NULL,
  "relationshipAfterJson" TEXT NOT NULL,
  "narrative" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "athena_3d_character_memory_revisions_session_epoch_key" ON "athena_3d_character_memory_revisions"("memorySessionId", "finalizationEpoch");
CREATE INDEX "athena_3d_character_memory_revisions_profile_revision_idx" ON "athena_3d_character_memory_revisions"("profileId", "toRevision");

CREATE TABLE "athena_3d_character_memory_jobs" (
  "id" TEXT PRIMARY KEY,
  "memorySessionId" TEXT NOT NULL,
  "finalizationEpoch" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "sourceHash" TEXT NOT NULL,
  "expectedProfileRevision" INTEGER NOT NULL,
  "contextRefJson" TEXT,
  "cacheMode" TEXT,
  "prefixSha256" TEXT,
  "provider" TEXT,
  "model" TEXT,
  "providerCacheHitTokens" INTEGER,
  "providerCacheMissTokens" INTEGER,
  "providerCacheHitRate" DOUBLE PRECISION,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "athena_3d_character_memory_jobs_session_epoch_key" ON "athena_3d_character_memory_jobs"("memorySessionId", "finalizationEpoch");
CREATE INDEX "athena_3d_character_memory_jobs_status_lease_idx" ON "athena_3d_character_memory_jobs"("status", "leaseExpiresAt");
