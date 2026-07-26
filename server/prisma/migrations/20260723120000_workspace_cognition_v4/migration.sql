ALTER TABLE "workspace_cognitive_rough_results" ADD COLUMN "selectionJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "workspace_cognitive_candidates" ADD COLUMN "qualityJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "workspace_cognitive_extraction_attempts" ADD COLUMN "finishReason" TEXT;
ALTER TABLE "workspace_cognitive_extraction_attempts" ADD COLUMN "thinkingMode" TEXT NOT NULL DEFAULT 'disabled';
ALTER TABLE "workspace_cognitive_extraction_attempts" ADD COLUMN "reasoningTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workspace_cognitive_extraction_attempts" ADD COLUMN "estimatedPromptTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workspace_cognitive_extraction_attempts" ADD COLUMN "budgetDecision" TEXT NOT NULL DEFAULT 'allowed';

UPDATE "workspace_cognitive_extraction_jobs"
SET "status" = 'legacy_frozen',
    "phase" = 'legacy_frozen',
    "leaseOwner" = NULL,
    "leaseExpiresAt" = NULL,
    "heartbeatAt" = NULL,
    "errorCode" = 'pipeline_v4_migrated'
WHERE "pipelineVersion" = 3
  AND "status" IN ('pending', 'running', 'retry_wait', 'failed', 'budget_blocked');

UPDATE "workspace_cognitive_candidates"
SET "legacyPipeline" = true
WHERE "pipelineVersion" = 3
  AND "extractionJobId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "workspace_cognitive_candidate_events" event
    WHERE event."candidateId" = "workspace_cognitive_candidates"."id"
      AND event."eventType" IN ('confirmed', 'temporary_confirmed', 'rejected', 'edited', 'split')
  );

UPDATE "workspace_cognitive_turn_buffer"
SET "status" = 'pending',
    "jobId" = NULL,
    "claimedAt" = NULL
WHERE "status" = 'claimed'
  AND "jobId" IN (
    SELECT "id" FROM "workspace_cognitive_extraction_jobs"
    WHERE "pipelineVersion" = 3 AND "status" = 'legacy_frozen'
  );

UPDATE "workspace_cognitive_turn_buffer"
SET "status" = 'pending',
    "jobId" = NULL,
    "claimedAt" = NULL,
    "screenedAt" = NULL,
    "roughResultId" = NULL
WHERE "status" = 'screened'
  AND "roughResultId" IN (
    SELECT rough."id" FROM "workspace_cognitive_rough_results" rough
    JOIN "workspace_cognitive_extraction_jobs" job ON job."id" = rough."roughJobId"
    WHERE job."pipelineVersion" = 3 AND rough."status" IN ('ready', 'claimed')
  );

UPDATE "workspace_cognitive_rough_results"
SET "status" = 'cancelled'
WHERE "id" IN (
  SELECT rough."id" FROM "workspace_cognitive_rough_results" rough
  JOIN "workspace_cognitive_extraction_jobs" job ON job."id" = rough."roughJobId"
  WHERE job."pipelineVersion" = 3 AND rough."status" IN ('ready', 'claimed')
);

UPDATE "workspace_cognitive_thread_state"
SET "activeJobId" = NULL,
    "lastErrorCode" = NULL,
    "lastErrorDetail" = NULL,
    "retryCount" = 0,
    "pendingTurnCount" = (
      SELECT COUNT(*) FROM "workspace_cognitive_turn_buffer" buffer
      WHERE buffer."workspaceId" = "workspace_cognitive_thread_state"."workspaceId"
        AND buffer."scopeKey" = "workspace_cognitive_thread_state"."scopeKey"
        AND buffer."status" IN ('pending', 'claimed', 'screened')
    );
