ALTER TABLE "chat_stream_runs" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "chat_stream_runs" ADD COLUMN "leaseExpiresAt" DATETIME;
ALTER TABLE "chat_stream_runs" ADD COLUMN "heartbeatAt" DATETIME;

CREATE TABLE "chat_run_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "chat_run_events_runId_sequence_key"
ON "chat_run_events"("runId", "sequence");
CREATE INDEX "chat_run_events_runId_createdAt_idx"
ON "chat_run_events"("runId", "createdAt");
CREATE INDEX "chat_stream_runs_status_leaseExpiresAt_idx"
ON "chat_stream_runs"("status", "leaseExpiresAt");

CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invocationId" TEXT NOT NULL,
    "clientTurnId" TEXT,
    "workspaceId" INTEGER NOT NULL,
    "threadId" INTEGER,
    "userId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'running',
    "latestSequence" INTEGER NOT NULL DEFAULT 0,
    "ownerId" TEXT,
    "leaseExpiresAt" DATETIME,
    "heartbeatAt" DATETIME,
    "finalChatId" INTEGER,
    "finalPublicChatId" TEXT,
    "errorCode" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "agent_runs_invocationId_key"
ON "agent_runs"("invocationId");
CREATE INDEX "agent_runs_scope_status_idx"
ON "agent_runs"("workspaceId", "threadId", "userId", "status");
CREATE INDEX "agent_runs_status_leaseExpiresAt_idx"
ON "agent_runs"("status", "leaseExpiresAt");

CREATE TABLE "agent_run_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL DEFAULT 'metadata-only',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "agent_run_events_runId_sequence_key"
ON "agent_run_events"("runId", "sequence");
CREATE INDEX "agent_run_events_runId_createdAt_idx"
ON "agent_run_events"("runId", "createdAt");
