ALTER TABLE "workspace_chats" ADD COLUMN "public_id" TEXT;

CREATE UNIQUE INDEX "workspace_chats_public_id_key" ON "workspace_chats"("public_id");
