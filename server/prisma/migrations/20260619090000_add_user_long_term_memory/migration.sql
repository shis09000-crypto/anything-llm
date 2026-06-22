CREATE TABLE "memory_candidates" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_candidates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "memory_candidates_userId_category_idx" ON "memory_candidates"("userId", "category");
CREATE INDEX "memory_candidates_fingerprint_idx" ON "memory_candidates"("fingerprint");

CREATE TABLE "user_memory_blocks" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isSensitive" BOOLEAN NOT NULL DEFAULT false,
  "encryptedPayload" TEXT,
  CONSTRAINT "user_memory_blocks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "user_memory_blocks_userId_category_idx" ON "user_memory_blocks"("userId", "category");
CREATE INDEX "user_memory_blocks_userId_isSensitive_idx" ON "user_memory_blocks"("userId", "isSensitive");

CREATE TABLE "user_memory_archives" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "category" TEXT NOT NULL,
  "oldValue" TEXT NOT NULL,
  "replacedBy" INTEGER,
  "archivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_memory_archives_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "user_memory_archives_userId_category_idx" ON "user_memory_archives"("userId", "category");
CREATE INDEX "user_memory_archives_replacedBy_idx" ON "user_memory_archives"("replacedBy");

CREATE TABLE "user_profile_overviews" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "overview" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_profile_overviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "user_profile_overviews_userId_version_idx" ON "user_profile_overviews"("userId", "version");
