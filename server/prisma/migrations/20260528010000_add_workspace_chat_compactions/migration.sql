CREATE TABLE IF NOT EXISTS "workspace_chat_compactions" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspace_id" INTEGER NOT NULL,
  "user_id" INTEGER,
  "thread_id" INTEGER,
  "api_session_id" TEXT,
  "summary" TEXT NOT NULL,
  "summary_format" TEXT NOT NULL DEFAULT 'thread-compact-markdown-v1',
  "covered_chat_ids" TEXT NOT NULL DEFAULT '[]',
  "covered_from_chat_id" INTEGER,
  "covered_to_chat_id" INTEGER,
  "covered_message_count" INTEGER NOT NULL DEFAULT 0,
  "token_before" INTEGER NOT NULL DEFAULT 0,
  "token_after" INTEGER NOT NULL DEFAULT 0,
  "metadata_json" TEXT NOT NULL DEFAULT '{}',
  "reason" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "workspace_chat_compactions_scope_created_idx"
  ON "workspace_chat_compactions"("workspace_id", "user_id", "thread_id", "api_session_id", "created_at");

CREATE INDEX IF NOT EXISTS "workspace_chat_compactions_thread_covered_idx"
  ON "workspace_chat_compactions"("workspace_id", "thread_id", "api_session_id", "covered_to_chat_id");
