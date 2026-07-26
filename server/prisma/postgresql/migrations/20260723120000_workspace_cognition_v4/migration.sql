ALTER TABLE "workspace_cognitive_rough_results" ADD COLUMN "selectionJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "workspace_cognitive_candidates" ADD COLUMN "qualityJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "workspace_cognitive_extraction_attempts" ADD COLUMN "finishReason" TEXT;
ALTER TABLE "workspace_cognitive_extraction_attempts" ADD COLUMN "thinkingMode" TEXT NOT NULL DEFAULT 'disabled';
ALTER TABLE "workspace_cognitive_extraction_attempts" ADD COLUMN "reasoningTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workspace_cognitive_extraction_attempts" ADD COLUMN "estimatedPromptTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workspace_cognitive_extraction_attempts" ADD COLUMN "budgetDecision" TEXT NOT NULL DEFAULT 'allowed';
ALTER TABLE "workspace_cognitive_extraction_jobs" ALTER COLUMN "pipelineVersion" SET DEFAULT 4;
ALTER TABLE "workspace_cognitive_candidates" ALTER COLUMN "pipelineVersion" SET DEFAULT 4;

UPDATE "workspace_cognitive_extraction_jobs"
SET "status" = 'legacy_frozen', "phase" = 'legacy_frozen',
    "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL,
    "errorCode" = 'pipeline_v4_migrated'
WHERE "pipelineVersion" = 3
  AND "status" IN ('pending', 'running', 'retry_wait', 'failed', 'budget_blocked');

UPDATE "workspace_cognitive_candidates" candidate
SET "legacyPipeline" = true
WHERE candidate."pipelineVersion" = 3
  AND candidate."extractionJobId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "workspace_cognitive_candidate_events" event
    WHERE event."candidateId" = candidate."id"
      AND event."eventType" IN ('confirmed', 'temporary_confirmed', 'rejected', 'edited', 'split')
  );

UPDATE "workspace_cognitive_turn_buffer" buffer
SET "status" = 'pending', "jobId" = NULL, "claimedAt" = NULL
WHERE buffer."status" = 'claimed'
  AND buffer."jobId" IN (
    SELECT "id" FROM "workspace_cognitive_extraction_jobs"
    WHERE "pipelineVersion" = 3 AND "status" = 'legacy_frozen'
  );

UPDATE "workspace_cognitive_turn_buffer" buffer
SET "status" = 'pending', "jobId" = NULL, "claimedAt" = NULL,
    "screenedAt" = NULL, "roughResultId" = NULL
WHERE buffer."status" = 'screened'
  AND buffer."roughResultId" IN (
    SELECT rough."id" FROM "workspace_cognitive_rough_results" rough
    JOIN "workspace_cognitive_extraction_jobs" job ON job."id" = rough."roughJobId"
    WHERE job."pipelineVersion" = 3 AND rough."status" IN ('ready', 'claimed')
  );

UPDATE "workspace_cognitive_rough_results" rough
SET "status" = 'cancelled'
FROM "workspace_cognitive_extraction_jobs" job
WHERE job."id" = rough."roughJobId"
  AND job."pipelineVersion" = 3
  AND rough."status" IN ('ready', 'claimed');

UPDATE "workspace_cognitive_thread_state" state
SET "activeJobId" = NULL, "lastErrorCode" = NULL, "lastErrorDetail" = NULL,
    "retryCount" = 0,
    "pendingTurnCount" = (
      SELECT COUNT(*) FROM "workspace_cognitive_turn_buffer" buffer
      WHERE buffer."workspaceId" = state."workspaceId"
        AND buffer."scopeKey" = state."scopeKey"
        AND buffer."status" IN ('pending', 'claimed', 'screened')
    );
