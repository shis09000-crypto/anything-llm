PRAGMA foreign_keys=OFF;

CREATE TABLE "new_memory_candidates" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "new_memory_candidates" (
  "id",
  "userId",
  "category",
  "title",
  "detail",
  "source",
  "confidence",
  "fingerprint",
  "createdAt"
)
SELECT
  "memory_candidates"."id",
  COALESCE("users"."authUserId", -"memory_candidates"."userId"),
  "memory_candidates"."category",
  "memory_candidates"."title",
  "memory_candidates"."detail",
  "memory_candidates"."source",
  "memory_candidates"."confidence",
  "memory_candidates"."fingerprint",
  "memory_candidates"."createdAt"
FROM "memory_candidates"
LEFT JOIN "users" ON "users"."id" = "memory_candidates"."userId";

DROP TABLE "memory_candidates";
ALTER TABLE "new_memory_candidates" RENAME TO "memory_candidates";
CREATE INDEX "memory_candidates_userId_category_idx" ON "memory_candidates"("userId", "category");
CREATE INDEX "memory_candidates_fingerprint_idx" ON "memory_candidates"("fingerprint");

CREATE TABLE "new_user_memory_blocks" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isSensitive" BOOLEAN NOT NULL DEFAULT false,
  "encryptedPayload" TEXT
);

INSERT INTO "new_user_memory_blocks" (
  "id",
  "userId",
  "category",
  "title",
  "detail",
  "source",
  "confidence",
  "updatedAt",
  "isSensitive",
  "encryptedPayload"
)
SELECT
  "user_memory_blocks"."id",
  COALESCE("users"."authUserId", -"user_memory_blocks"."userId"),
  "user_memory_blocks"."category",
  "user_memory_blocks"."title",
  "user_memory_blocks"."detail",
  "user_memory_blocks"."source",
  "user_memory_blocks"."confidence",
  "user_memory_blocks"."updatedAt",
  "user_memory_blocks"."isSensitive",
  "user_memory_blocks"."encryptedPayload"
FROM "user_memory_blocks"
LEFT JOIN "users" ON "users"."id" = "user_memory_blocks"."userId";

DROP TABLE "user_memory_blocks";
ALTER TABLE "new_user_memory_blocks" RENAME TO "user_memory_blocks";
CREATE INDEX "user_memory_blocks_userId_category_idx" ON "user_memory_blocks"("userId", "category");
CREATE INDEX "user_memory_blocks_userId_isSensitive_idx" ON "user_memory_blocks"("userId", "isSensitive");

CREATE TABLE "new_user_memory_archives" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "category" TEXT NOT NULL,
  "oldValue" TEXT NOT NULL,
  "replacedBy" INTEGER,
  "archivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "new_user_memory_archives" (
  "id",
  "userId",
  "category",
  "oldValue",
  "replacedBy",
  "archivedAt"
)
SELECT
  "user_memory_archives"."id",
  COALESCE("users"."authUserId", -"user_memory_archives"."userId"),
  "user_memory_archives"."category",
  "user_memory_archives"."oldValue",
  "user_memory_archives"."replacedBy",
  "user_memory_archives"."archivedAt"
FROM "user_memory_archives"
LEFT JOIN "users" ON "users"."id" = "user_memory_archives"."userId";

DROP TABLE "user_memory_archives";
ALTER TABLE "new_user_memory_archives" RENAME TO "user_memory_archives";
CREATE INDEX "user_memory_archives_userId_category_idx" ON "user_memory_archives"("userId", "category");
CREATE INDEX "user_memory_archives_replacedBy_idx" ON "user_memory_archives"("replacedBy");

CREATE TABLE "new_user_profile_overviews" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "overview" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "new_user_profile_overviews" (
  "id",
  "userId",
  "overview",
  "version",
  "generatedAt"
)
SELECT
  "user_profile_overviews"."id",
  COALESCE("users"."authUserId", -"user_profile_overviews"."userId"),
  "user_profile_overviews"."overview",
  "user_profile_overviews"."version",
  "user_profile_overviews"."generatedAt"
FROM "user_profile_overviews"
LEFT JOIN "users" ON "users"."id" = "user_profile_overviews"."userId";

DROP TABLE "user_profile_overviews";
ALTER TABLE "new_user_profile_overviews" RENAME TO "user_profile_overviews";
CREATE INDEX "user_profile_overviews_userId_version_idx" ON "user_profile_overviews"("userId", "version");

PRAGMA foreign_keys=ON;
