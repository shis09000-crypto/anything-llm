ALTER TABLE "workspace_threads" ADD COLUMN "parent_thread_id" INTEGER;
ALTER TABLE "workspace_threads" ADD COLUMN "thread_type" TEXT;
ALTER TABLE "workspace_threads" ADD COLUMN "created_from" TEXT;
ALTER TABLE "workspace_threads" ADD COLUMN "forked_at_message_id" INTEGER;
ALTER TABLE "workspace_threads" ADD COLUMN "forked_at" DATETIME;

ALTER TABLE "workspace_chats" ADD COLUMN "original_thread_id" INTEGER;
ALTER TABLE "workspace_chats" ADD COLUMN "original_message_id" INTEGER;
ALTER TABLE "workspace_chats" ADD COLUMN "created_from" TEXT;
