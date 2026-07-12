CREATE TABLE "athena_mutation_receipts" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "sourceActionId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "workspaceId" INTEGER,
  "threadId" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "resourceJson" TEXT NOT NULL DEFAULT '{}',
  "errorCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "athena_mutation_receipts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "athena_mutation_receipts_userId_sourceActionId_key"
  ON "athena_mutation_receipts"("userId", "sourceActionId");
CREATE INDEX "athena_mutation_receipts_userId_status_idx"
  ON "athena_mutation_receipts"("userId", "status");
CREATE INDEX "athena_mutation_receipts_workspaceId_idx"
  ON "athena_mutation_receipts"("workspaceId");
CREATE INDEX "athena_mutation_receipts_threadId_idx"
  ON "athena_mutation_receipts"("threadId");
