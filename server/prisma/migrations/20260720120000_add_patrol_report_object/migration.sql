ALTER TABLE "system_patrol_runs" ADD COLUMN "reportObjectId" TEXT;

CREATE INDEX "system_patrol_runs_reportObjectId_idx"
ON "system_patrol_runs"("reportObjectId");
