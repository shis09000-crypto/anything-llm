CREATE TABLE "character_performance_sessions" (
    "id" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "threadId" INTEGER,
    "ownerUserId" INTEGER,
    "conversationId" TEXT,
    "characterId" TEXT NOT NULL,
    "characterInstanceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "adapter" TEXT NOT NULL,
    "runtimeVersion" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "packVersion" TEXT NOT NULL,
    "packSha256" TEXT NOT NULL,
    "clientCiphertext" TEXT NOT NULL,
    "clientHash" TEXT NOT NULL,
    "lastSequence" INTEGER NOT NULL DEFAULT -1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    CONSTRAINT "character_performance_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "character_performance_sessions_workspaceId_threadId_status_idx" ON "character_performance_sessions"("workspaceId", "threadId", "status");
CREATE INDEX "character_performance_sessions_ownerUserId_status_idx" ON "character_performance_sessions"("ownerUserId", "status");
CREATE INDEX "character_performance_sessions_conversationId_idx" ON "character_performance_sessions"("conversationId");

CREATE TABLE "character_performance_plans" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "planCiphertext" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "commandCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "character_performance_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "character_performance_plans_sessionId_responseId_key" ON "character_performance_plans"("sessionId", "responseId");
CREATE INDEX "character_performance_plans_sessionId_createdAt_idx" ON "character_performance_plans"("sessionId", "createdAt");
CREATE INDEX "character_performance_plans_status_createdAt_idx" ON "character_performance_plans"("status", "createdAt");

CREATE TABLE "character_performance_events" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "planId" TEXT,
    "commandId" TEXT,
    "payloadCiphertext" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "character_performance_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "character_performance_events_sessionId_sequence_key" ON "character_performance_events"("sessionId", "sequence");
CREATE INDEX "character_performance_events_sessionId_createdAt_idx" ON "character_performance_events"("sessionId", "createdAt");
CREATE INDEX "character_performance_events_planId_idx" ON "character_performance_events"("planId");
CREATE INDEX "character_performance_events_commandId_idx" ON "character_performance_events"("commandId");

CREATE TABLE "character_performance_feedback" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actualStartMs" INTEGER,
    "actualDurationMs" INTEGER,
    "errorCode" TEXT,
    "payloadCiphertext" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "character_performance_feedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "character_performance_feedback_sessionId_createdAt_idx" ON "character_performance_feedback"("sessionId", "createdAt");
CREATE INDEX "character_performance_feedback_planId_commandId_createdAt_idx" ON "character_performance_feedback"("planId", "commandId", "createdAt");
