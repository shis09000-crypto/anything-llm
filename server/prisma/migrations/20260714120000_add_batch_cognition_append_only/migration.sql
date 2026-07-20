-- Athena batch cognition and append-only ledger.
ALTER TABLE "workspace_threads" ADD COLUMN "archivedAt" DATETIME;
CREATE INDEX "workspace_threads_workspace_id_archivedAt_idx" ON "workspace_threads"("workspace_id", "archivedAt");

ALTER TABLE "workspace_cognitive_assertions" ADD COLUMN "canonicalItemId" INTEGER;
CREATE INDEX "workspace_cognitive_assertions_workspaceId_canonicalItemId_idx" ON "workspace_cognitive_assertions"("workspaceId", "canonicalItemId");
ALTER TABLE "workspace_cognitive_positions" ADD COLUMN "canonicalPositionVersionId" INTEGER;
CREATE INDEX "workspace_cognitive_positions_workspaceId_canonicalPositionVersionId_idx" ON "workspace_cognitive_positions"("workspaceId", "canonicalPositionVersionId");
ALTER TABLE "workspace_cognitive_evidence" ADD COLUMN "canonicalEvidenceId" INTEGER;
CREATE INDEX "workspace_cognitive_evidence_workspaceId_canonicalEvidenceId_idx" ON "workspace_cognitive_evidence"("workspaceId", "canonicalEvidenceId");
ALTER TABLE "workspace_cognitive_relations" ADD COLUMN "canonicalRelationId" INTEGER;
CREATE INDEX "workspace_cognitive_relations_workspaceId_canonicalRelationId_idx" ON "workspace_cognitive_relations"("workspaceId", "canonicalRelationId");

ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "scopeKey" TEXT;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "triggerReason" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "pipeline" TEXT NOT NULL DEFAULT 'direct_refine';
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "chatIdsJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "inputContentHash" TEXT;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "screeningOutputJson" TEXT;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "refiningOutputJson" TEXT;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "nextRetryAt" DATETIME;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "leaseExpiresAt" DATETIME;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "heartbeatAt" DATETIME;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "workspace_cognitive_extraction_jobs" ADD COLUMN "errorDetail" TEXT;
CREATE UNIQUE INDEX "workspace_cognitive_extraction_jobs_idempotencyKey_key" ON "workspace_cognitive_extraction_jobs"("idempotencyKey");
CREATE INDEX "workspace_cognitive_extraction_jobs_status_nextRetryAt_leaseExpiresAt_idx" ON "workspace_cognitive_extraction_jobs"("status", "nextRetryAt", "leaseExpiresAt");
CREATE INDEX "workspace_cognitive_extraction_jobs_workspaceId_scopeKey_status_idx" ON "workspace_cognitive_extraction_jobs"("workspaceId", "scopeKey", "status");

CREATE TABLE "workspace_cognitive_turn_buffer" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL, "threadId" INTEGER, "scopeKey" TEXT NOT NULL,
  "chatId" INTEGER NOT NULL, "contentHash" TEXT NOT NULL,
  "sourceChannel" TEXT NOT NULL DEFAULT 'web', "status" TEXT NOT NULL DEFAULT 'pending',
  "jobId" INTEGER, "claimedAt" DATETIME, "processedAt" DATETIME,
  "cancelledAt" DATETIME, "cancelReason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_turn_buffer_workspaceId_chatId_contentHash_key" ON "workspace_cognitive_turn_buffer"("workspaceId", "chatId", "contentHash");
CREATE INDEX "workspace_cognitive_turn_buffer_workspaceId_scopeKey_status_chatId_idx" ON "workspace_cognitive_turn_buffer"("workspaceId", "scopeKey", "status", "chatId");
CREATE INDEX "workspace_cognitive_turn_buffer_jobId_status_idx" ON "workspace_cognitive_turn_buffer"("jobId", "status");

CREATE TABLE "workspace_cognitive_thread_state" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL, "threadId" INTEGER, "scopeKey" TEXT NOT NULL,
  "lastEnqueuedChatId" INTEGER, "lastExtractedChatId" INTEGER,
  "pendingTurnCount" INTEGER NOT NULL DEFAULT 0, "lastActivityAt" DATETIME,
  "flushRequestedAt" DATETIME, "flushReason" TEXT, "pausedAt" DATETIME, "activeJobId" INTEGER,
  "lastErrorCode" TEXT, "lastErrorDetail" TEXT, "retryCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "workspace_cognitive_thread_state_workspaceId_scopeKey_key" ON "workspace_cognitive_thread_state"("workspaceId", "scopeKey");
CREATE INDEX "workspace_cognitive_thread_state_workspaceId_lastActivityAt_pendingTurnCount_idx" ON "workspace_cognitive_thread_state"("workspaceId", "lastActivityAt", "pendingTurnCount");
CREATE INDEX "workspace_cognitive_thread_state_activeJobId_idx" ON "workspace_cognitive_thread_state"("activeJobId");

CREATE TABLE "workspace_cognitive_candidates" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "candidateKey" TEXT NOT NULL,
  "workspaceId" INTEGER NOT NULL, "threadId" INTEGER, "extractionJobId" INTEGER,
  "assertionType" TEXT NOT NULL, "statement" TEXT NOT NULL, "origin" TEXT NOT NULL,
  "subjectUserId" INTEGER, "stance" TEXT, "rationale" TEXT,
  "conditionsJson" TEXT NOT NULL DEFAULT '{}', "confidence" REAL NOT NULL DEFAULT 0,
  "sourceChatIdsJson" TEXT NOT NULL DEFAULT '[]', "evidenceJson" TEXT NOT NULL DEFAULT '[]',
  "suggestedRelationJson" TEXT NOT NULL DEFAULT '{}', "normalizedHash" TEXT NOT NULL,
  "rawModelOutputJson" TEXT NOT NULL DEFAULT '{}', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_candidates_candidateKey_key" ON "workspace_cognitive_candidates"("candidateKey");
CREATE INDEX "workspace_cognitive_candidates_workspaceId_extractionJobId_normalizedHash_idx" ON "workspace_cognitive_candidates"("workspaceId", "extractionJobId", "normalizedHash");
CREATE INDEX "workspace_cognitive_candidates_workspaceId_createdAt_idx" ON "workspace_cognitive_candidates"("workspaceId", "createdAt");
CREATE INDEX "workspace_cognitive_candidates_workspaceId_subjectUserId_idx" ON "workspace_cognitive_candidates"("workspaceId", "subjectUserId");

CREATE TABLE "workspace_cognitive_candidate_events" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "workspaceId" INTEGER NOT NULL,
  "candidateId" INTEGER NOT NULL, "eventType" TEXT NOT NULL, "actorUserId" INTEGER,
  "payloadJson" TEXT NOT NULL DEFAULT '{}', "idempotencyKey" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_candidate_events_workspaceId_idempotencyKey_key" ON "workspace_cognitive_candidate_events"("workspaceId", "idempotencyKey");
CREATE INDEX "workspace_cognitive_candidate_events_workspaceId_candidateId_createdAt_idx" ON "workspace_cognitive_candidate_events"("workspaceId", "candidateId", "createdAt");

CREATE TABLE "workspace_cognitive_items" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "workspaceId" INTEGER NOT NULL,
  "itemKey" TEXT NOT NULL, "version" INTEGER NOT NULL, "candidateId" INTEGER,
  "assertionType" TEXT NOT NULL, "statement" TEXT NOT NULL, "createdByType" TEXT NOT NULL,
  "createdByUserId" INTEGER, "confidence" REAL NOT NULL DEFAULT 0,
  "disclosureLevel" TEXT NOT NULL DEFAULT 'workspace_only', "isTemporary" BOOLEAN NOT NULL DEFAULT false,
  "normalizedHash" TEXT NOT NULL, "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_items_workspaceId_itemKey_version_key" ON "workspace_cognitive_items"("workspaceId", "itemKey", "version");
CREATE INDEX "workspace_cognitive_items_workspaceId_assertionType_createdAt_idx" ON "workspace_cognitive_items"("workspaceId", "assertionType", "createdAt");
CREATE INDEX "workspace_cognitive_items_workspaceId_normalizedHash_idx" ON "workspace_cognitive_items"("workspaceId", "normalizedHash");
CREATE INDEX "workspace_cognitive_items_workspaceId_candidateId_idx" ON "workspace_cognitive_items"("workspaceId", "candidateId");

CREATE TABLE "workspace_cognitive_position_versions" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "workspaceId" INTEGER NOT NULL,
  "cognitiveItemId" INTEGER NOT NULL, "subjectUserId" INTEGER NOT NULL, "stance" TEXT NOT NULL,
  "rationale" TEXT, "conditionsJson" TEXT NOT NULL DEFAULT '{}',
  "meetingDisclosure" TEXT NOT NULL DEFAULT 'workspace_only', "isTemporary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "workspace_cognitive_position_versions_workspaceId_cognitiveItemId_idx" ON "workspace_cognitive_position_versions"("workspaceId", "cognitiveItemId");
CREATE INDEX "workspace_cognitive_position_versions_workspaceId_subjectUserId_createdAt_idx" ON "workspace_cognitive_position_versions"("workspaceId", "subjectUserId", "createdAt");

CREATE TABLE "workspace_cognitive_item_relations" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "workspaceId" INTEGER NOT NULL,
  "fromItemId" INTEGER NOT NULL, "toItemId" INTEGER NOT NULL, "relationType" TEXT NOT NULL,
  "confidence" REAL NOT NULL DEFAULT 0, "rationale" TEXT, "createdByType" TEXT NOT NULL DEFAULT 'user',
  "createdByUserId" INTEGER, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_item_relations_workspace_relation_key" ON "workspace_cognitive_item_relations"("workspaceId", "fromItemId", "toItemId", "relationType");
CREATE INDEX "workspace_cognitive_item_relations_workspaceId_relationType_idx" ON "workspace_cognitive_item_relations"("workspaceId", "relationType");
CREATE INDEX "workspace_cognitive_item_relations_workspaceId_toItemId_idx" ON "workspace_cognitive_item_relations"("workspaceId", "toItemId");

CREATE TABLE "workspace_cognitive_item_evidence" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "workspaceId" INTEGER NOT NULL,
  "cognitiveItemId" INTEGER NOT NULL, "evidenceKind" TEXT NOT NULL, "sourceType" TEXT NOT NULL,
  "sourceRef" TEXT NOT NULL, "documentId" TEXT, "chunkId" TEXT, "chatId" INTEGER,
  "threadId" INTEGER, "graphEdgeId" TEXT, "sourceWorkspaceId" INTEGER NOT NULL,
  "excerpt" TEXT, "confidence" REAL NOT NULL DEFAULT 0,
  "disclosureLevel" TEXT NOT NULL DEFAULT 'workspace_only', "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "workspace_cognitive_item_evidence_workspaceId_cognitiveItemId_idx" ON "workspace_cognitive_item_evidence"("workspaceId", "cognitiveItemId");
CREATE INDEX "workspace_cognitive_item_evidence_workspaceId_documentId_chunkId_idx" ON "workspace_cognitive_item_evidence"("workspaceId", "documentId", "chunkId");
CREATE INDEX "workspace_cognitive_item_evidence_workspaceId_chatId_idx" ON "workspace_cognitive_item_evidence"("workspaceId", "chatId");

CREATE TABLE "workspace_cognitive_evidence_events" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "workspaceId" INTEGER NOT NULL,
  "evidenceId" INTEGER NOT NULL, "eventType" TEXT NOT NULL, "reason" TEXT,
  "actorType" TEXT NOT NULL DEFAULT 'system', "actorUserId" INTEGER,
  "metadataJson" TEXT NOT NULL DEFAULT '{}', "idempotencyKey" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_evidence_events_workspaceId_idempotencyKey_key" ON "workspace_cognitive_evidence_events"("workspaceId", "idempotencyKey");
CREATE INDEX "workspace_cognitive_evidence_events_workspaceId_evidenceId_createdAt_idx" ON "workspace_cognitive_evidence_events"("workspaceId", "evidenceId", "createdAt");

CREATE TABLE "workspace_cognitive_profile_invalidations" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "workspaceId" INTEGER NOT NULL,
  "generation" INTEGER NOT NULL, "reason" TEXT NOT NULL, "sourceType" TEXT, "sourceId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_profile_invalidations_workspaceId_generation_key" ON "workspace_cognitive_profile_invalidations"("workspaceId", "generation");
CREATE INDEX "workspace_cognitive_profile_invalidations_workspaceId_createdAt_idx" ON "workspace_cognitive_profile_invalidations"("workspaceId", "createdAt");

CREATE TABLE "workspace_cognitive_profile_state" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "workspaceId" INTEGER NOT NULL,
  "dirtyGeneration" INTEGER NOT NULL DEFAULT 0, "rebuiltGeneration" INTEGER NOT NULL DEFAULT 0,
  "rebuildStatus" TEXT NOT NULL DEFAULT 'idle', "lastError" TEXT,
  "updatedAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_profile_state_workspaceId_key" ON "workspace_cognitive_profile_state"("workspaceId");

CREATE TABLE "workspace_cognitive_profile_items" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "workspaceId" INTEGER NOT NULL,
  "profileRevision" INTEGER NOT NULL, "cognitiveItemId" INTEGER NOT NULL,
  "itemKey" TEXT NOT NULL, "itemVersion" INTEGER NOT NULL,
  "membershipType" TEXT NOT NULL DEFAULT 'active', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_profile_items_workspace_revision_item_key" ON "workspace_cognitive_profile_items"("workspaceId", "profileRevision", "cognitiveItemId", "membershipType");
CREATE INDEX "workspace_cognitive_profile_items_workspaceId_profileRevision_idx" ON "workspace_cognitive_profile_items"("workspaceId", "profileRevision");
CREATE INDEX "workspace_cognitive_profile_items_workspaceId_itemKey_itemVersion_idx" ON "workspace_cognitive_profile_items"("workspaceId", "itemKey", "itemVersion");
