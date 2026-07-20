ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "pipelineVersion" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "jobType" TEXT NOT NULL DEFAULT 'rough_screen';
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "partialGroup" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "modelMaxTokens" INTEGER;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "protocolRepairAttempted" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "workspace_cognitive_turn_buffer" ADD COLUMN "screenedAt" DATETIME;
ALTER TABLE "workspace_cognitive_turn_buffer" ADD COLUMN "roughResultId" INTEGER;

ALTER TABLE "workspace_cognitive_candidates" ADD COLUMN "pipelineVersion" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "workspace_cognitive_candidates" ADD COLUMN "legacyPipeline" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "workspace_cognitive_rough_results" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "roughJobId" INTEGER NOT NULL,
  "threadId" INTEGER,
  "scopeKey" TEXT NOT NULL,
  "chatIdsJson" TEXT NOT NULL DEFAULT '[]',
  "inputContentHash" TEXT NOT NULL,
  "segmentRefsJson" TEXT NOT NULL DEFAULT '[]',
  "outputHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "readyAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "refineJobId" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "workspace_cognitive_refine_inputs" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "refineJobId" INTEGER NOT NULL,
  "roughResultId" INTEGER NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "workspace_cognitive_extraction_attempts" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "jobId" INTEGER NOT NULL,
  "stage" TEXT NOT NULL,
  "attemptNo" INTEGER NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheHitTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheMissTokens" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER NOT NULL DEFAULT 0,
  "inputHash" TEXT,
  "outputHash" TEXT,
  "outcome" TEXT NOT NULL,
  "errorCode" TEXT,
  "metricsJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "workspace_cognitive_rough_results_roughJobId_key" ON "workspace_cognitive_rough_results"("roughJobId");
CREATE INDEX "workspace_cognitive_rough_results_workspaceId_status_readyAt_id_idx" ON "workspace_cognitive_rough_results"("workspaceId", "status", "readyAt", "id");
CREATE INDEX "workspace_cognitive_rough_results_refineJobId_status_idx" ON "workspace_cognitive_rough_results"("refineJobId", "status");
CREATE UNIQUE INDEX "workspace_cognitive_refine_inputs_roughResultId_key" ON "workspace_cognitive_refine_inputs"("roughResultId");
CREATE UNIQUE INDEX "workspace_cognitive_refine_inputs_refineJobId_ordinal_key" ON "workspace_cognitive_refine_inputs"("refineJobId", "ordinal");
CREATE INDEX "workspace_cognitive_refine_inputs_workspaceId_refineJobId_idx" ON "workspace_cognitive_refine_inputs"("workspaceId", "refineJobId");
CREATE UNIQUE INDEX "workspace_cognitive_extraction_attempts_jobId_stage_attemptNo_key" ON "workspace_cognitive_extraction_attempts"("jobId", "stage", "attemptNo");
CREATE INDEX "workspace_cognitive_extraction_attempts_workspaceId_createdAt_idx" ON "workspace_cognitive_extraction_attempts"("workspaceId", "createdAt");
CREATE INDEX "workspace_cognitive_extraction_attempts_jobId_stage_idx" ON "workspace_cognitive_extraction_attempts"("jobId", "stage");
CREATE INDEX "workspace_cognitive_extraction_jobs_status_priority_nextRetryAt_leaseExpiresAt_idx" ON "workspace_cognitive_extraction_jobs"("status", "priority", "nextRetryAt", "leaseExpiresAt");
CREATE INDEX "workspace_cognitive_extraction_jobs_workspaceId_pipelineVersion_jobType_status_idx" ON "workspace_cognitive_extraction_jobs"("workspaceId", "pipelineVersion", "jobType", "status");
CREATE INDEX "workspace_cognitive_turn_buffer_roughResultId_status_idx" ON "workspace_cognitive_turn_buffer"("roughResultId", "status");
CREATE INDEX "workspace_cognitive_candidates_workspaceId_legacyPipeline_createdAt_idx" ON "workspace_cognitive_candidates"("workspaceId", "legacyPipeline", "createdAt");

UPDATE "workspace_cognitive_extraction_jobs"
SET "pipelineVersion" = 2,
    "jobType" = 'legacy_v2',
    "priority" = 100,
    "status" = CASE
      WHEN "status" IN ('pending', 'running', 'retry_wait', 'failed') THEN 'legacy_frozen'
      ELSE "status"
    END,
    "phase" = CASE
      WHEN "status" IN ('pending', 'running', 'retry_wait', 'failed') THEN 'legacy_frozen'
      ELSE "phase"
    END,
    "leaseOwner" = NULL,
    "leaseExpiresAt" = NULL,
    "heartbeatAt" = NULL,
    "errorCode" = CASE
      WHEN "status" IN ('pending', 'running', 'retry_wait', 'failed') THEN 'pipeline_v3_migrated'
      ELSE "errorCode"
    END;

UPDATE "workspace_cognitive_candidates"
SET "pipelineVersion" = 2, "legacyPipeline" = true
WHERE "extractionJobId" IS NOT NULL;

UPDATE "workspace_cognitive_turn_buffer"
SET "status" = 'pending', "jobId" = NULL, "claimedAt" = NULL
WHERE "status" = 'claimed'
  AND "jobId" IN (
    SELECT "id" FROM "workspace_cognitive_extraction_jobs"
    WHERE "pipelineVersion" = 2 AND "status" = 'legacy_frozen'
  );

UPDATE "workspace_cognitive_thread_state"
SET "activeJobId" = NULL,
    "lastErrorCode" = NULL,
    "lastErrorDetail" = NULL,
    "retryCount" = 0
WHERE "activeJobId" IN (
  SELECT "id" FROM "workspace_cognitive_extraction_jobs"
  WHERE "pipelineVersion" = 2 AND "status" = 'legacy_frozen'
);
