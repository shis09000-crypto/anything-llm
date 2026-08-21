ALTER TABLE "content_object_provider_files" ADD COLUMN "imageAssetId" TEXT;
DROP INDEX IF EXISTS "content_object_provider_files_assetId_provider_credentialScopeHash_adaptationVersion_key";
CREATE UNIQUE INDEX "content_object_provider_files_imageAssetId_provider_credentialScopeHash_adaptationVersion_key"
  ON "content_object_provider_files"("imageAssetId", "provider", "credentialScopeHash", "adaptationVersion");
CREATE INDEX "content_object_provider_files_imageAssetId_idx"
  ON "content_object_provider_files"("imageAssetId");

CREATE TABLE "image_assets" (
  "id" TEXT NOT NULL,
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
  "lastUsedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "image_assets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "image_assets_ownerScope_workspaceId_originalContentObjectId_key"
  ON "image_assets"("ownerScope", "workspaceId", "originalContentObjectId");
CREATE INDEX "image_assets_ownerUserId_status_createdAt_idx"
  ON "image_assets"("ownerUserId", "status", "createdAt");
CREATE INDEX "image_assets_workspaceId_status_createdAt_idx"
  ON "image_assets"("workspaceId", "status", "createdAt");
CREATE INDEX "image_assets_originalContentObjectId_idx" ON "image_assets"("originalContentObjectId");
CREATE INDEX "image_assets_previewContentObjectId_idx" ON "image_assets"("previewContentObjectId");

CREATE TABLE "image_asset_sources" (
  "id" TEXT NOT NULL,
  "imageAssetId" TEXT NOT NULL,
  "workspaceId" INTEGER NOT NULL,
  "threadId" INTEGER,
  "chatId" INTEGER,
  "attachmentRefId" TEXT,
  "ordinal" INTEGER NOT NULL DEFAULT 0,
  "sourceType" TEXT NOT NULL DEFAULT 'chat_upload',
  "sourceText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "image_asset_sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "image_asset_sources_imageAssetId_attachmentRefId_key"
  ON "image_asset_sources"("imageAssetId", "attachmentRefId");
CREATE INDEX "image_asset_sources_imageAssetId_createdAt_idx" ON "image_asset_sources"("imageAssetId", "createdAt");
CREATE INDEX "image_asset_sources_workspaceId_threadId_createdAt_idx" ON "image_asset_sources"("workspaceId", "threadId", "createdAt");
CREATE INDEX "image_asset_sources_chatId_idx" ON "image_asset_sources"("chatId");
CREATE INDEX "image_asset_sources_attachmentRefId_idx" ON "image_asset_sources"("attachmentRefId");

ALTER TABLE "workspace_chat_attachment_refs" ALTER COLUMN "contentObjectId" DROP NOT NULL;
ALTER TABLE "workspace_chat_attachment_refs" ADD COLUMN "imageAssetId" TEXT;
ALTER TABLE "workspace_chat_attachment_refs" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "workspace_chat_attachment_refs" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "workspace_chat_attachment_refs_imageAssetId_idx" ON "workspace_chat_attachment_refs"("imageAssetId");
CREATE INDEX "workspace_chat_attachment_refs_status_deletedAt_idx" ON "workspace_chat_attachment_refs"("status", "deletedAt");
