CREATE INDEX IF NOT EXISTS "workspace_chats_scope_tail_idx"
  ON "workspace_chats"("workspaceId", "user_id", "thread_id", "api_session_id", "id");
