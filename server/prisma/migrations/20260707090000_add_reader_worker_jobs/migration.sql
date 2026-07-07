-- Athena Modular Architecture P3: durable Reader Worker queue
CREATE TABLE IF NOT EXISTS "reader_worker_jobs" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "jobId" TEXT NOT NULL,
  "queue" TEXT NOT NULL DEFAULT 'reader',
  "task" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "priority" TEXT NOT NULL DEFAULT 'P4',
  "intent" TEXT NOT NULL DEFAULT 'maintenance',
  "userId" INTEGER,
  "workspaceSlug" TEXT,
  "readerDocumentId" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL DEFAULT '{}',
  "resultJson" TEXT,
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "lockedBy" TEXT,
  "lockedAt" DATETIME,
  "runAfter" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "reader_worker_jobs_jobId_key"
  ON "reader_worker_jobs"("jobId");
CREATE INDEX IF NOT EXISTS "reader_worker_jobs_status_runAfter_idx"
  ON "reader_worker_jobs"("status", "runAfter");
CREATE INDEX IF NOT EXISTS "reader_worker_jobs_readerDocumentId_idx"
  ON "reader_worker_jobs"("readerDocumentId");
CREATE INDEX IF NOT EXISTS "reader_worker_jobs_workspaceSlug_idx"
  ON "reader_worker_jobs"("workspaceSlug");
CREATE INDEX IF NOT EXISTS "reader_worker_jobs_priority_idx"
  ON "reader_worker_jobs"("priority");
CREATE INDEX IF NOT EXISTS "reader_worker_jobs_lockedAt_idx"
  ON "reader_worker_jobs"("lockedAt");
