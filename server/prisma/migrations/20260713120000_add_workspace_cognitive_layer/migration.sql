CREATE TABLE "workspace_cognitive_assertions" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "assertionType" TEXT NOT NULL,
  "statement" TEXT NOT NULL,
  "verificationStatus" TEXT NOT NULL DEFAULT 'candidate',
  "confidence" REAL NOT NULL DEFAULT 0,
  "validFrom" DATETIME,
  "validUntil" DATETIME,
  "createdByType" TEXT NOT NULL,
  "createdByUserId" INTEGER,
  "normalizedHash" TEXT NOT NULL,
  "supersededById" INTEGER,
  "profileRevision" INTEGER,
  "disclosureLevel" TEXT NOT NULL DEFAULT 'workspace_only',
  "reviewReason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_assertions_workspaceId_normalizedHash_key" ON "workspace_cognitive_assertions"("workspaceId", "normalizedHash");
CREATE INDEX "workspace_cognitive_assertions_workspaceId_assertionType_verificationStatus_idx" ON "workspace_cognitive_assertions"("workspaceId", "assertionType", "verificationStatus");
CREATE INDEX "workspace_cognitive_assertions_workspaceId_updatedAt_idx" ON "workspace_cognitive_assertions"("workspaceId", "updatedAt");

CREATE TABLE "workspace_cognitive_positions" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "assertionId" INTEGER NOT NULL,
  "subjectUserId" INTEGER NOT NULL,
  "proposedByUserId" INTEGER,
  "stance" TEXT NOT NULL,
  "rationale" TEXT,
  "conditionsJson" TEXT NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'candidate',
  "meetingDisclosure" TEXT NOT NULL DEFAULT 'workspace_only',
  "confirmedAt" DATETIME,
  "sourceChatId" INTEGER,
  "supersededById" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "workspace_cognitive_positions_workspaceId_assertionId_idx" ON "workspace_cognitive_positions"("workspaceId", "assertionId");
CREATE INDEX "workspace_cognitive_positions_workspaceId_subjectUserId_status_idx" ON "workspace_cognitive_positions"("workspaceId", "subjectUserId", "status");

CREATE TABLE "workspace_cognitive_evidence" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "assertionId" INTEGER NOT NULL,
  "evidenceKind" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "documentId" TEXT,
  "chunkId" TEXT,
  "chatId" INTEGER,
  "threadId" INTEGER,
  "graphEdgeId" TEXT,
  "sourceWorkspaceId" INTEGER NOT NULL,
  "excerpt" TEXT,
  "confidence" REAL NOT NULL DEFAULT 0,
  "freshness" TEXT NOT NULL DEFAULT 'current',
  "disclosureLevel" TEXT NOT NULL DEFAULT 'workspace_only',
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_evidence_workspace_assertion_source_key" ON "workspace_cognitive_evidence"("workspaceId", "assertionId", "sourceType", "sourceRef", "evidenceKind");
CREATE INDEX "workspace_cognitive_evidence_workspaceId_assertionId_freshness_idx" ON "workspace_cognitive_evidence"("workspaceId", "assertionId", "freshness");
CREATE INDEX "workspace_cognitive_evidence_workspaceId_documentId_chunkId_idx" ON "workspace_cognitive_evidence"("workspaceId", "documentId", "chunkId");
CREATE INDEX "workspace_cognitive_evidence_workspaceId_chatId_idx" ON "workspace_cognitive_evidence"("workspaceId", "chatId");

CREATE TABLE "workspace_cognitive_relations" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "fromAssertionId" INTEGER NOT NULL,
  "toAssertionId" INTEGER NOT NULL,
  "relationType" TEXT NOT NULL,
  "confidence" REAL NOT NULL DEFAULT 0,
  "createdByType" TEXT NOT NULL DEFAULT 'system',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_relations_workspace_relation_key" ON "workspace_cognitive_relations"("workspaceId", "fromAssertionId", "toAssertionId", "relationType");
CREATE INDEX "workspace_cognitive_relations_workspaceId_relationType_idx" ON "workspace_cognitive_relations"("workspaceId", "relationType");

CREATE TABLE "workspace_cognitive_profiles" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL,
  "profileJson" TEXT NOT NULL DEFAULT '{}',
  "sourceWatermark" TEXT,
  "contentHash" TEXT NOT NULL,
  "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_cognitive_profiles_workspaceId_revision_key" ON "workspace_cognitive_profiles"("workspaceId", "revision");
CREATE INDEX "workspace_cognitive_profiles_workspaceId_generatedAt_idx" ON "workspace_cognitive_profiles"("workspaceId", "generatedAt");

CREATE TABLE "workspace_cognitive_extraction_jobs" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "threadId" INTEGER,
  "requestedById" INTEGER,
  "mode" TEXT NOT NULL DEFAULT 'incremental',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "fromChatId" INTEGER,
  "toChatId" INTEGER,
  "lastScannedChatId" INTEGER,
  "extractedCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "workspace_cognitive_extraction_jobs_workspaceId_threadId_status_idx" ON "workspace_cognitive_extraction_jobs"("workspaceId", "threadId", "status");
CREATE INDEX "workspace_cognitive_extraction_jobs_workspaceId_lastScannedChatId_idx" ON "workspace_cognitive_extraction_jobs"("workspaceId", "lastScannedChatId");

CREATE TABLE "workspace_meeting_packets" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "packetKey" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdByUserId" INTEGER,
  "delegateUserId" INTEGER,
  "title" TEXT NOT NULL,
  "objective" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "profileRevision" INTEGER,
  "selectionJson" TEXT NOT NULL DEFAULT '{}',
  "sourceWhitelistJson" TEXT NOT NULL DEFAULT '{}',
  "disclosureRulesJson" TEXT NOT NULL DEFAULT '{}',
  "redactionRulesJson" TEXT NOT NULL DEFAULT '[]',
  "contentHash" TEXT,
  "frozenAt" DATETIME,
  "revokedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "workspace_meeting_packets_workspaceId_packetKey_revision_key" ON "workspace_meeting_packets"("workspaceId", "packetKey", "revision");
CREATE INDEX "workspace_meeting_packets_workspaceId_status_updatedAt_idx" ON "workspace_meeting_packets"("workspaceId", "status", "updatedAt");

CREATE TABLE "workspace_meeting_authorizations" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "meetingPacketId" INTEGER NOT NULL,
  "actionType" TEXT NOT NULL,
  "targetScopeJson" TEXT NOT NULL DEFAULT '{}',
  "limitsJson" TEXT NOT NULL DEFAULT '{}',
  "conditionsJson" TEXT NOT NULL DEFAULT '{}',
  "validFrom" DATETIME,
  "validUntil" DATETIME,
  "allowConditional" BOOLEAN NOT NULL DEFAULT false,
  "requiresSecondApproval" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdByUserId" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "workspace_meeting_authorizations_workspace_packet_action_idx" ON "workspace_meeting_authorizations"("workspaceId", "meetingPacketId", "actionType");

CREATE TABLE "workspace_meeting_sessions" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "meetingPacketId" INTEGER NOT NULL,
  "threadId" INTEGER NOT NULL,
  "delegateUserId" INTEGER,
  "createdByUserId" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'active',
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "workspace_meeting_sessions_workspace_packet_status_idx" ON "workspace_meeting_sessions"("workspaceId", "meetingPacketId", "status");
CREATE INDEX "workspace_meeting_sessions_workspace_thread_idx" ON "workspace_meeting_sessions"("workspaceId", "threadId");

CREATE TABLE "workspace_meeting_audit_events" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspaceId" INTEGER NOT NULL,
  "meetingSessionId" INTEGER NOT NULL,
  "actorUserId" INTEGER,
  "eventType" TEXT NOT NULL,
  "decision" TEXT,
  "requestJson" TEXT NOT NULL DEFAULT '{}',
  "resultJson" TEXT NOT NULL DEFAULT '{}',
  "evidenceRefsJson" TEXT NOT NULL DEFAULT '[]',
  "authorizationId" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "workspace_meeting_audit_events_workspace_session_createdAt_idx" ON "workspace_meeting_audit_events"("workspaceId", "meetingSessionId", "createdAt");
CREATE INDEX "workspace_meeting_audit_events_workspace_eventType_idx" ON "workspace_meeting_audit_events"("workspaceId", "eventType");
