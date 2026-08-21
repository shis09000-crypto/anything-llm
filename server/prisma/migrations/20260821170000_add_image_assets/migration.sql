ALTER TABLE "content_object_provider_files" ADD COLUMN "imageAssetId" TEXT;
DROP INDEX IF EXISTS "content_object_provider_files_assetId_provider_credentialScopeHash_adaptationVersion_key";

CREATE UNIQUE INDEX "content_object_provider_files_imageAssetId_provider_credentialScopeHash_adaptationVersion_key"
  ON "content_object_provider_files"("imageAssetId", "provider", "credentialScopeHash", "adaptationVersion");
CREATE INDEX "content_object_provider_files_imageAssetId_idx"
  ON "content_object_provider_files"("imageAssetId");

CREATE TABLE "image_assets" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerUserId" INTEGER,
  "ownerScope" TEXT NOT NULL,
  "workspaceId" INTEGER NOT NULL,
  "originalContentObjectId" TEXT,
  "previewContentObjectId" TEXT,
  "displayName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "animated" BOOLEAN NOT NULL DEFAULT false,
  "previewWidth" INTEGER,
  "previewHeight" INTEGER,
  "title" TEXT,
  "summary" TEXT,
  "tagsJson" TEXT NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'local_ready',
  "providerSyncStatus" TEXT NOT NULL DEFAULT 'pending',
  "providerFailureCode" TEXT,
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "lastUsedAt" DATETIME,
  "deletedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "image_assets_ownerScope_workspaceId_originalContentObjectId_key"
  ON "image_assets"("ownerScope", "workspaceId", "originalContentObjectId");
CREATE INDEX "image_assets_ownerUserId_status_createdAt_idx"
  ON "image_assets"("ownerUserId", "status", "createdAt");
CREATE INDEX "image_assets_workspaceId_status_createdAt_idx"
  ON "image_assets"("workspaceId", "status", "createdAt");
CREATE INDEX "image_assets_originalContentObjectId_idx"
  ON "image_assets"("originalContentObjectId");
CREATE INDEX "image_assets_previewContentObjectId_idx"
  ON "image_assets"("previewContentObjectId");

CREATE TABLE "image_asset_sources" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "imageAssetId" TEXT NOT NULL,
  "workspaceId" INTEGER NOT NULL,
  "threadId" INTEGER,
  "chatId" INTEGER,
  "attachmentRefId" TEXT,
  "ordinal" INTEGER NOT NULL DEFAULT 0,
  "sourceType" TEXT NOT NULL DEFAULT 'chat_upload',
  "sourceText" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "image_asset_sources_imageAssetId_attachmentRefId_key"
  ON "image_asset_sources"("imageAssetId", "attachmentRefId");
CREATE INDEX "image_asset_sources_imageAssetId_createdAt_idx"
  ON "image_asset_sources"("imageAssetId", "createdAt");
CREATE INDEX "image_asset_sources_workspaceId_threadId_createdAt_idx"
  ON "image_asset_sources"("workspaceId", "threadId", "createdAt");
CREATE INDEX "image_asset_sources_chatId_idx" ON "image_asset_sources"("chatId");
CREATE INDEX "image_asset_sources_attachmentRefId_idx" ON "image_asset_sources"("attachmentRefId");

PRAGMA foreign_keys=OFF;
ALTER TABLE "workspace_chat_attachment_refs" RENAME TO "workspace_chat_attachment_refs_legacy";
CREATE TABLE "workspace_chat_attachment_refs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "chatId" INTEGER NOT NULL,
  "contentObjectId" TEXT,
  "imageAssetId" TEXT,
  "ordinal" INTEGER NOT NULL,
  "displayName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "metadataJson" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "deletedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "workspace_chat_attachment_refs" (
  "id", "chatId", "contentObjectId", "ordinal", "displayName", "mimeType", "byteSize", "metadataJson", "createdAt"
) SELECT "id", "chatId", "contentObjectId", "ordinal", "displayName", "mimeType", "byteSize", "metadataJson", "createdAt"
  FROM "workspace_chat_attachment_refs_legacy";
DROP TABLE "workspace_chat_attachment_refs_legacy";
CREATE UNIQUE INDEX "workspace_chat_attachment_refs_chatId_ordinal_key"
  ON "workspace_chat_attachment_refs"("chatId", "ordinal");
CREATE INDEX "workspace_chat_attachment_refs_contentObjectId_idx"
  ON "workspace_chat_attachment_refs"("contentObjectId");
CREATE INDEX "workspace_chat_attachment_refs_imageAssetId_idx"
  ON "workspace_chat_attachment_refs"("imageAssetId");
CREATE INDEX "workspace_chat_attachment_refs_status_deletedAt_idx"
  ON "workspace_chat_attachment_refs"("status", "deletedAt");
CREATE INDEX "workspace_chat_attachment_refs_chatId_idx"
  ON "workspace_chat_attachment_refs"("chatId");
PRAGMA foreign_keys=ON;
