ALTER TABLE "workspace_threads" ADD COLUMN "historyRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "athena_sync_events" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "eventId" TEXT NOT NULL,
  "userId" INTEGER,
  "targetClientId" TEXT,
  "namespace" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "visibility" TEXT NOT NULL,
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "version" TEXT,
  "revision" TEXT,
  "scopeJson" TEXT NOT NULL DEFAULT '{}',
  "resourceJson" TEXT NOT NULL DEFAULT '{}',
  "payloadJson" TEXT NOT NULL DEFAULT '{}',
  "originJson" TEXT NOT NULL DEFAULT '{}',
  "sourceClientId" TEXT,
  "requiresAck" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  CONSTRAINT "athena_sync_events_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "athena_sync_events_eventId_key" ON "athena_sync_events"("eventId");
CREATE INDEX "athena_sync_events_userId_id_idx" ON "athena_sync_events"("userId", "id");
CREATE INDEX "athena_sync_events_targetClientId_id_idx" ON "athena_sync_events"("targetClientId", "id");
CREATE INDEX "athena_sync_events_expiresAt_idx" ON "athena_sync_events"("expiresAt");

CREATE TABLE "athena_ios_push_tokens" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "clientId" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "bundleId" TEXT NOT NULL,
  "tokenEncrypted" TEXT NOT NULL,
  "tokenFingerprint" TEXT NOT NULL,
  "appVersion" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" DATETIME,
  CONSTRAINT "athena_ios_push_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "athena_ios_push_tokens_userId_clientId_environment_bundleId_key"
  ON "athena_ios_push_tokens"("userId", "clientId", "environment", "bundleId");
CREATE INDEX "athena_ios_push_tokens_userId_revokedAt_idx"
  ON "athena_ios_push_tokens"("userId", "revokedAt");
CREATE INDEX "athena_ios_push_tokens_tokenFingerprint_idx"
  ON "athena_ios_push_tokens"("tokenFingerprint");

CREATE TRIGGER "workspace_chats_history_revision_insert"
AFTER INSERT ON "workspace_chats"
WHEN NEW."thread_id" IS NOT NULL AND NEW."api_session_id" IS NULL
BEGIN
  UPDATE "workspace_threads"
    SET "historyRevision" = "historyRevision" + 1
    WHERE "id" = NEW."thread_id";
END;

CREATE TRIGGER "workspace_chats_history_revision_update_same"
AFTER UPDATE OF "prompt", "response", "include" ON "workspace_chats"
WHEN NEW."thread_id" IS NOT NULL
  AND NEW."api_session_id" IS NULL
  AND OLD."thread_id" = NEW."thread_id"
BEGIN
  UPDATE "workspace_threads"
    SET "historyRevision" = "historyRevision" + 1
    WHERE "id" = NEW."thread_id";
END;

CREATE TRIGGER "workspace_chats_history_revision_update_old_scope"
AFTER UPDATE OF "thread_id", "workspaceId", "user_id", "api_session_id" ON "workspace_chats"
WHEN OLD."thread_id" IS NOT NULL
  AND OLD."api_session_id" IS NULL
  AND (NEW."thread_id" IS NOT OLD."thread_id"
    OR NEW."workspaceId" IS NOT OLD."workspaceId"
    OR NEW."user_id" IS NOT OLD."user_id"
    OR NEW."api_session_id" IS NOT OLD."api_session_id")
BEGIN
  UPDATE "workspace_threads"
    SET "historyRevision" = "historyRevision" + 1
    WHERE "id" = OLD."thread_id";
END;

CREATE TRIGGER "workspace_chats_history_revision_update_new_scope"
AFTER UPDATE OF "thread_id", "workspaceId", "user_id", "api_session_id" ON "workspace_chats"
WHEN NEW."thread_id" IS NOT NULL
  AND NEW."api_session_id" IS NULL
  AND (NEW."thread_id" IS NOT OLD."thread_id"
    OR NEW."workspaceId" IS NOT OLD."workspaceId"
    OR NEW."user_id" IS NOT OLD."user_id"
    OR NEW."api_session_id" IS NOT OLD."api_session_id")
BEGIN
  UPDATE "workspace_threads"
    SET "historyRevision" = "historyRevision" + 1
    WHERE "id" = NEW."thread_id";
END;

CREATE TRIGGER "workspace_chats_history_revision_delete"
AFTER DELETE ON "workspace_chats"
WHEN OLD."thread_id" IS NOT NULL AND OLD."api_session_id" IS NULL
BEGIN
  UPDATE "workspace_threads"
    SET "historyRevision" = "historyRevision" + 1
    WHERE "id" = OLD."thread_id";
END;
