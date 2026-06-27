CREATE INDEX IF NOT EXISTS "workspace_chats_thread_history_idx"
  ON "workspace_chats"("workspaceId", "user_id", "thread_id", "api_session_id", "include", "id");

CREATE INDEX IF NOT EXISTS "workspace_chats_thread_activity_idx"
  ON "workspace_chats"("workspaceId", "user_id", "api_session_id", "include", "thread_id", "createdAt", "id");
