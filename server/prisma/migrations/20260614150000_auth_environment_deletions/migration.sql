CREATE TABLE "AuthEnvironmentDeletion" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "authUserId" INTEGER NOT NULL,
  "env" TEXT NOT NULL,
  "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedByAuthUserId" INTEGER
);

CREATE UNIQUE INDEX "AuthEnvironmentDeletion_authUserId_env_key"
  ON "AuthEnvironmentDeletion"("authUserId", "env");
CREATE INDEX "AuthEnvironmentDeletion_authUserId_idx"
  ON "AuthEnvironmentDeletion"("authUserId");
CREATE INDEX "AuthEnvironmentDeletion_env_idx"
  ON "AuthEnvironmentDeletion"("env");
CREATE INDEX "AuthEnvironmentDeletion_deletedAt_idx"
  ON "AuthEnvironmentDeletion"("deletedAt");
