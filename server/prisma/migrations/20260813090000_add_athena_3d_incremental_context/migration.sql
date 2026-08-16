ALTER TABLE "athena_3d_session_memories" ADD COLUMN "checkpointRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "athena_3d_session_memories" ADD COLUMN "contextCursorId" TEXT;
-- SQLite rejects non-constant defaults when a column is added to an existing
-- table. The repository always writes the real timestamp for new rows; use a
-- constant only for the ALTER, then backfill existing rows from their latest
-- known update time.
ALTER TABLE "athena_3d_session_memories" ADD COLUMN "contextUpdatedAt" DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00';
UPDATE "athena_3d_session_memories"
SET "contextUpdatedAt" = COALESCE("lastUpdatedAt", CURRENT_TIMESTAMP);
UPDATE "athena_3d_session_memories"
SET "contextCursorId" = 'chr_ctx_' || lower(hex(randomblob(16)))
WHERE "contextCursorId" IS NULL;

ALTER TABLE "athena_3d_session_memory_turns" ADD COLUMN "previousContextCursorId" TEXT;
ALTER TABLE "athena_3d_session_memory_turns" ADD COLUMN "contextCursorId" TEXT;

ALTER TABLE "character_conversation_turns" ADD COLUMN "previousContextJson" TEXT;
ALTER TABLE "character_conversation_turns" ADD COLUMN "contextJson" TEXT;
ALTER TABLE "character_conversation_turns" ADD COLUMN "contextMode" TEXT;
ALTER TABLE "character_conversation_turns" ADD COLUMN "gatewaySlotHit" BOOLEAN;
ALTER TABLE "character_conversation_turns" ADD COLUMN "contextRebuildReason" TEXT;
ALTER TABLE "character_conversation_turns" ADD COLUMN "providerCacheHitTokens" INTEGER;
ALTER TABLE "character_conversation_turns" ADD COLUMN "providerCacheMissTokens" INTEGER;
ALTER TABLE "character_conversation_turns" ADD COLUMN "providerCacheHitRate" REAL;

CREATE INDEX "athena_3d_session_memories_contextCursorId_idx"
ON "athena_3d_session_memories"("contextCursorId");

CREATE TRIGGER "athena_3d_context_cursor_insert_required"
BEFORE INSERT ON "athena_3d_session_memories"
WHEN NEW."contextCursorId" IS NULL OR NEW."contextCursorId" = ''
BEGIN
  SELECT RAISE(ABORT, 'athena_3d_context_cursor_required');
END;

CREATE TRIGGER "athena_3d_context_cursor_update_required"
BEFORE UPDATE OF "contextCursorId" ON "athena_3d_session_memories"
WHEN NEW."contextCursorId" IS NULL OR NEW."contextCursorId" = ''
BEGIN
  SELECT RAISE(ABORT, 'athena_3d_context_cursor_required');
END;
