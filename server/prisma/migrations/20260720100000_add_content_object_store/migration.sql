ALTER TABLE "workspace_chats" ADD COLUMN "payloadVersion" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "content_objects" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerType" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "scopeHash" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "plaintextSha256" TEXT NOT NULL,
  "plaintextSize" INTEGER NOT NULL,
  "mimeType" TEXT,
  "provider" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "ciphertextSha256" TEXT NOT NULL,
  "encryptionVersion" TEXT NOT NULL,
  "wrappedDek" TEXT NOT NULL,
  "encryptionMetadataJson" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'staging',
  "refCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt" DATETIME,
  "lastVerifiedAt" DATETIME,
  "deleteAfter" DATETIME,
  "deletedAt" DATETIME
);

CREATE UNIQUE INDEX "content_objects_objectKey_key" ON "content_objects"("objectKey");
CREATE UNIQUE INDEX "content_objects_ownerType_ownerId_domain_dedupeKey_key"
  ON "content_objects"("ownerType", "ownerId", "domain", "dedupeKey");
CREATE INDEX "content_objects_state_createdAt_idx" ON "content_objects"("state", "createdAt");
CREATE INDEX "content_objects_state_deleteAfter_idx" ON "content_objects"("state", "deleteAfter");
CREATE INDEX "content_objects_ownerType_ownerId_domain_idx"
  ON "content_objects"("ownerType", "ownerId", "domain");

CREATE TABLE "workspace_chat_attachment_refs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "chatId" INTEGER NOT NULL,
  "contentObjectId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "displayName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "metadataJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_chat_attachment_refs_chatId_fkey"
    FOREIGN KEY ("chatId") REFERENCES "workspace_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workspace_chat_attachment_refs_contentObjectId_fkey"
    FOREIGN KEY ("contentObjectId") REFERENCES "content_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "workspace_chat_attachment_refs_chatId_ordinal_key"
  ON "workspace_chat_attachment_refs"("chatId", "ordinal");
CREATE INDEX "workspace_chat_attachment_refs_contentObjectId_idx"
  ON "workspace_chat_attachment_refs"("contentObjectId");
CREATE INDEX "workspace_chat_attachment_refs_chatId_idx"
  ON "workspace_chat_attachment_refs"("chatId");

CREATE TABLE "workspace_chat_content_refs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "chatId" INTEGER NOT NULL,
  "contentObjectId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "jsonPath" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_chat_content_refs_chatId_fkey"
    FOREIGN KEY ("chatId") REFERENCES "workspace_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workspace_chat_content_refs_contentObjectId_fkey"
    FOREIGN KEY ("contentObjectId") REFERENCES "content_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "workspace_chat_content_refs_chatId_jsonPath_key"
  ON "workspace_chat_content_refs"("chatId", "jsonPath");
CREATE INDEX "workspace_chat_content_refs_contentObjectId_idx"
  ON "workspace_chat_content_refs"("contentObjectId");
CREATE INDEX "workspace_chat_content_refs_chatId_idx"
  ON "workspace_chat_content_refs"("chatId");

CREATE TABLE "chat_attachment_uploads" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" INTEGER NOT NULL,
  "userId" INTEGER,
  "contentObjectId" TEXT,
  "displayName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "expectedSize" INTEGER,
  "expectedSha256" TEXT,
  "receivedBytes" INTEGER NOT NULL DEFAULT 0,
  "partsJson" TEXT NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "completedAt" DATETIME,
  CONSTRAINT "chat_attachment_uploads_contentObjectId_fkey"
    FOREIGN KEY ("contentObjectId") REFERENCES "content_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "chat_attachment_uploads_workspaceId_userId_status_idx"
  ON "chat_attachment_uploads"("workspaceId", "userId", "status");
CREATE INDEX "chat_attachment_uploads_status_expiresAt_idx"
  ON "chat_attachment_uploads"("status", "expiresAt");
CREATE INDEX "chat_attachment_uploads_contentObjectId_idx"
  ON "chat_attachment_uploads"("contentObjectId");

CREATE TABLE "chat_attachment_upload_parts" (
  "uploadId" TEXT NOT NULL,
  "partNumber" INTEGER NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("uploadId", "partNumber"),
  CONSTRAINT "chat_attachment_upload_parts_uploadId_fkey"
    FOREIGN KEY ("uploadId") REFERENCES "chat_attachment_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "chat_attachment_upload_parts_uploadId_idx"
  ON "chat_attachment_upload_parts"("uploadId");
