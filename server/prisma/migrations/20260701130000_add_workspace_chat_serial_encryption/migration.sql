CREATE TABLE IF NOT EXISTS "workspace_chat_conversation_keys" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "key_id" TEXT NOT NULL,
  "scope_hash" TEXT NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "user_id" INTEGER,
  "thread_id" INTEGER,
  "api_session_id" TEXT,
  "wrapped_key" TEXT NOT NULL,
  "crypto_version" TEXT NOT NULL DEFAULT 'athena-chat-key:v1',
  "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_chat_conversation_keys_key_id_key"
  ON "workspace_chat_conversation_keys"("key_id");

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_chat_conversation_keys_scope_hash_key"
  ON "workspace_chat_conversation_keys"("scope_hash");

CREATE INDEX IF NOT EXISTS "workspace_chat_conversation_keys_scope_idx"
  ON "workspace_chat_conversation_keys"("workspace_id", "user_id", "thread_id", "api_session_id");

CREATE TABLE IF NOT EXISTS "workspace_chat_crypto_metadata" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "chat_id" INTEGER NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "user_id" INTEGER,
  "thread_id" INTEGER,
  "api_session_id" TEXT,
  "scope_hash" TEXT NOT NULL,
  "key_id" TEXT NOT NULL,
  "crypto_version" TEXT NOT NULL,
  "prompt_cipher_hash" TEXT NOT NULL,
  "response_cipher_hash" TEXT NOT NULL,
  "prev_chain_hash" TEXT,
  "chain_hash" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_chat_crypto_metadata_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "workspace_chats"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_chat_crypto_metadata_chat_id_key"
  ON "workspace_chat_crypto_metadata"("chat_id");

CREATE INDEX IF NOT EXISTS "workspace_chat_crypto_metadata_scope_chat_idx"
  ON "workspace_chat_crypto_metadata"("scope_hash", "chat_id");

CREATE INDEX IF NOT EXISTS "workspace_chat_crypto_metadata_key_id_idx"
  ON "workspace_chat_crypto_metadata"("key_id");
