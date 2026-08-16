ALTER TABLE "athena_3d_session_memories" ADD COLUMN "checkpointRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "athena_3d_session_memories" ADD COLUMN "contextCursorId" TEXT;
ALTER TABLE "athena_3d_session_memories" ADD COLUMN "contextUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "athena_3d_session_memories"
SET "contextCursorId" = 'chr_ctx_' || md5(random()::text || clock_timestamp()::text)
WHERE "contextCursorId" IS NULL;
ALTER TABLE "athena_3d_session_memories" ALTER COLUMN "contextCursorId" SET NOT NULL;

ALTER TABLE "athena_3d_session_memory_turns" ADD COLUMN "previousContextCursorId" TEXT;
ALTER TABLE "athena_3d_session_memory_turns" ADD COLUMN "contextCursorId" TEXT;

ALTER TABLE "character_conversation_turns" ADD COLUMN "previousContextJson" TEXT;
ALTER TABLE "character_conversation_turns" ADD COLUMN "contextJson" TEXT;
ALTER TABLE "character_conversation_turns" ADD COLUMN "contextMode" TEXT;
ALTER TABLE "character_conversation_turns" ADD COLUMN "gatewaySlotHit" BOOLEAN;
ALTER TABLE "character_conversation_turns" ADD COLUMN "contextRebuildReason" TEXT;
ALTER TABLE "character_conversation_turns" ADD COLUMN "providerCacheHitTokens" INTEGER;
ALTER TABLE "character_conversation_turns" ADD COLUMN "providerCacheMissTokens" INTEGER;
ALTER TABLE "character_conversation_turns" ADD COLUMN "providerCacheHitRate" DOUBLE PRECISION;

CREATE INDEX "athena_3d_session_memories_contextCursorId_idx"
ON "athena_3d_session_memories"("contextCursorId");
