-- Reader Data Authority Center V1
CREATE TABLE IF NOT EXISTS "reader_book_catalog" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "catalogKey" TEXT NOT NULL,
  "readerDocumentId" TEXT NOT NULL,
  "workspaceSlug" TEXT,
  "title" TEXT,
  "documentType" TEXT,
  "mimeType" TEXT,
  "fingerprint" TEXT,
  "previewStatus" TEXT,
  "thumbnailStatus" TEXT,
  "classificationStatus" TEXT,
  "availability" TEXT NOT NULL DEFAULT 'available',
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "reader_book_catalog_catalogKey_key"
  ON "reader_book_catalog"("catalogKey");
CREATE INDEX IF NOT EXISTS "reader_book_catalog_readerDocumentId_idx"
  ON "reader_book_catalog"("readerDocumentId");
CREATE INDEX IF NOT EXISTS "reader_book_catalog_workspaceSlug_idx"
  ON "reader_book_catalog"("workspaceSlug");
CREATE INDEX IF NOT EXISTS "reader_book_catalog_availability_idx"
  ON "reader_book_catalog"("availability");

CREATE TABLE IF NOT EXISTS "reader_library_items" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "itemId" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "catalogKey" TEXT NOT NULL,
  "readerDocumentId" TEXT NOT NULL,
  "workspaceSlug" TEXT,
  "itemKey" TEXT NOT NULL,
  "title" TEXT,
  "categoryId" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "progressJson" TEXT NOT NULL DEFAULT '{}',
  "stateJson" TEXT NOT NULL DEFAULT '{}',
  "visible" BOOLEAN NOT NULL DEFAULT true,
  "hiddenAt" DATETIME,
  "deletedAt" DATETIME,
  "tombstone" BOOLEAN NOT NULL DEFAULT false,
  "availability" TEXT NOT NULL DEFAULT 'available',
  "mutationVersion" INTEGER NOT NULL DEFAULT 1,
  "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastOpenedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reader_library_items_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "reader_library_items_itemId_key"
  ON "reader_library_items"("itemId");
CREATE UNIQUE INDEX IF NOT EXISTS "reader_library_items_userId_catalogKey_key"
  ON "reader_library_items"("userId", "catalogKey");
CREATE UNIQUE INDEX IF NOT EXISTS "reader_library_items_userId_itemKey_key"
  ON "reader_library_items"("userId", "itemKey");
CREATE INDEX IF NOT EXISTS "reader_library_items_userId_idx"
  ON "reader_library_items"("userId");
CREATE INDEX IF NOT EXISTS "reader_library_items_userId_deletedAt_tombstone_idx"
  ON "reader_library_items"("userId", "deletedAt", "tombstone");
CREATE INDEX IF NOT EXISTS "reader_library_items_catalogKey_idx"
  ON "reader_library_items"("catalogKey");

CREATE TABLE IF NOT EXISTS "reader_library_categories" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "categoryId" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "hiddenAt" DATETIME,
  "deletedAt" DATETIME,
  "mutationVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reader_library_categories_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "reader_library_categories_userId_categoryId_key"
  ON "reader_library_categories"("userId", "categoryId");
CREATE INDEX IF NOT EXISTS "reader_library_categories_userId_idx"
  ON "reader_library_categories"("userId");
CREATE INDEX IF NOT EXISTS "reader_library_categories_userId_deletedAt_idx"
  ON "reader_library_categories"("userId", "deletedAt");
