CREATE TABLE "chat_stream_runs" (
    "id" TEXT NOT NULL,
    "clientTurnId" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "threadId" INTEGER,
    "userId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'running',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "partialResponse" TEXT NOT NULL DEFAULT '',
    "finalChatId" INTEGER,
    "finalPublicChatId" TEXT,
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_stream_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_stream_runs_clientTurnId_key"
ON "chat_stream_runs"("clientTurnId");

CREATE INDEX "chat_stream_runs_scope_status_idx"
ON "chat_stream_runs"("workspaceId", "threadId", "userId", "status");

CREATE INDEX "chat_stream_runs_status_updated_idx"
ON "chat_stream_runs"("status", "lastUpdatedAt");

CREATE INDEX "chat_stream_runs_completed_idx"
ON "chat_stream_runs"("completedAt");
