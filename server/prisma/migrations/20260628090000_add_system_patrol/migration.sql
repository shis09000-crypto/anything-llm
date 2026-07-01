CREATE TABLE IF NOT EXISTS "system_patrol_runs" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "mode" TEXT NOT NULL DEFAULT 'light',
  "status" TEXT NOT NULL DEFAULT 'running',
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "triggeredBy" INTEGER,
  "summaryScore" INTEGER NOT NULL DEFAULT 0,
  "summaryStatus" TEXT NOT NULL DEFAULT 'unknown',
  "countsJson" TEXT NOT NULL DEFAULT '{}',
  "reportJson" TEXT NOT NULL DEFAULT '{}',
  "error" TEXT,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME
);

CREATE INDEX IF NOT EXISTS "system_patrol_runs_startedAt_idx" ON "system_patrol_runs"("startedAt");
CREATE INDEX IF NOT EXISTS "system_patrol_runs_status_idx" ON "system_patrol_runs"("status");
CREATE INDEX IF NOT EXISTS "system_patrol_runs_summaryStatus_idx" ON "system_patrol_runs"("summaryStatus");

CREATE TABLE IF NOT EXISTS "system_patrol_repairs" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "repairId" TEXT NOT NULL,
  "runId" INTEGER,
  "checkId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'previewed',
  "previewJson" TEXT NOT NULL DEFAULT '{}',
  "backupPath" TEXT,
  "confirmedBy" INTEGER,
  "resultJson" TEXT NOT NULL DEFAULT '{}',
  "error" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "system_patrol_repairs_repairId_key" ON "system_patrol_repairs"("repairId");
CREATE INDEX IF NOT EXISTS "system_patrol_repairs_runId_idx" ON "system_patrol_repairs"("runId");
CREATE INDEX IF NOT EXISTS "system_patrol_repairs_repairId_idx" ON "system_patrol_repairs"("repairId");
CREATE INDEX IF NOT EXISTS "system_patrol_repairs_status_idx" ON "system_patrol_repairs"("status");
CREATE INDEX IF NOT EXISTS "system_patrol_repairs_action_idx" ON "system_patrol_repairs"("action");
