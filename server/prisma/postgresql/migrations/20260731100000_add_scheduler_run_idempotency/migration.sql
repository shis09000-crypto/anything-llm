ALTER TABLE "scheduled_job_runs" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "scheduled_job_runs_idempotencyKey_key"
ON "scheduled_job_runs"("idempotencyKey");
