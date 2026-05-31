ALTER TABLE "workspace_threads" ADD COLUMN "title" TEXT;
ALTER TABLE "workspace_threads" ADD COLUMN "titleSource" TEXT;
ALTER TABLE "workspace_threads" ADD COLUMN "titleGeneratedAt" DATETIME;
ALTER TABLE "workspace_threads" ADD COLUMN "titleHash" TEXT;
ALTER TABLE "workspace_threads" ADD COLUMN "titleVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workspace_threads" ADD COLUMN "titleMessageScope" TEXT;
ALTER TABLE "workspace_threads" ADD COLUMN "titleGenerationStatus" TEXT NOT NULL DEFAULT 'idle';

CREATE INDEX IF NOT EXISTS "workspace_threads_titleSource_idx"
  ON "workspace_threads"("titleSource");

CREATE INDEX IF NOT EXISTS "workspace_threads_titleGenerationStatus_idx"
  ON "workspace_threads"("titleGenerationStatus");
