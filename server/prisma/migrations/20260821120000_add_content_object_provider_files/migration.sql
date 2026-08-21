CREATE TABLE "content_object_provider_files" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "assetId" TEXT NOT NULL,
  "derivativeAssetId" TEXT,
  "provider" TEXT NOT NULL,
  "credentialScopeHash" TEXT NOT NULL,
  "adaptationVersion" TEXT NOT NULL,
  "providerFileId" TEXT NOT NULL,
  "providerMimeType" TEXT NOT NULL,
  "providerByteSize" INTEGER NOT NULL,
  "providerSha256" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "providerCreatedAt" DATETIME,
  "expiresAt" DATETIME,
  "lastVerifiedAt" DATETIME,
  "lastUsedAt" DATETIME,
  "failureCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_object_provider_files_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "content_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "content_object_provider_files_derivativeAssetId_fkey"
    FOREIGN KEY ("derivativeAssetId") REFERENCES "content_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "content_object_provider_files_assetId_provider_credentialScopeHash_adaptationVersion_key"
  ON "content_object_provider_files"("assetId", "provider", "credentialScopeHash", "adaptationVersion");
CREATE INDEX "content_object_provider_files_provider_status_expiresAt_idx"
  ON "content_object_provider_files"("provider", "status", "expiresAt");
CREATE INDEX "content_object_provider_files_assetId_idx"
  ON "content_object_provider_files"("assetId");
CREATE INDEX "content_object_provider_files_derivativeAssetId_idx"
  ON "content_object_provider_files"("derivativeAssetId");
