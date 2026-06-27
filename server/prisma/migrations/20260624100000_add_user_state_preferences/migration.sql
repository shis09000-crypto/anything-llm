CREATE TABLE "user_state_preferences" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "namespace" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'global',
  "value" TEXT NOT NULL,
  "version" TEXT NOT NULL DEFAULT '1',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_state_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "user_state_preferences_userId_namespace_scope_key" ON "user_state_preferences"("userId", "namespace", "scope");
CREATE INDEX "user_state_preferences_userId_namespace_idx" ON "user_state_preferences"("userId", "namespace");
CREATE INDEX "user_state_preferences_updatedAt_idx" ON "user_state_preferences"("updatedAt");
