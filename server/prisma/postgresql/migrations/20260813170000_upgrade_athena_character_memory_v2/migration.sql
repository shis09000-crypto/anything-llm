-- Athena Character Memory v2 uses the same plain JSON contract as the 3D Center fast lane.
ALTER TABLE "athena_3d_character_memory_profiles" ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "coreId" TEXT, ADD COLUMN "coreVersion" TEXT, ADD COLUMN "coreSha256" TEXT,
  ADD COLUMN "coreSnapshotJson" TEXT, ADD COLUMN "adaptiveSelfJson" TEXT, ADD COLUMN "relationshipV2Json" TEXT,
  ADD COLUMN "userModelSummaryJson" TEXT, ADD COLUMN "reflectionVersion" TEXT NOT NULL DEFAULT '2.0',
  ADD COLUMN "policyVersion" TEXT NOT NULL DEFAULT '2.0';
ALTER TABLE "athena_3d_character_memory_sessions" ADD COLUMN "reflectionJson" TEXT,
  ADD COLUMN "formationStatus" TEXT NOT NULL DEFAULT 'pending', ADD COLUMN "legacyReflectionPending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "athena_3d_character_memory_revisions" ADD COLUMN "relationshipV2BeforeJson" TEXT,
  ADD COLUMN "relationshipV2DeltaJson" TEXT, ADD COLUMN "relationshipV2AfterJson" TEXT,
  ADD COLUMN "adaptiveBeforeJson" TEXT, ADD COLUMN "adaptiveDeltaJson" TEXT, ADD COLUMN "adaptiveAfterJson" TEXT;
ALTER TABLE "athena_3d_character_memory_jobs" ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "taskKind" TEXT NOT NULL DEFAULT 'reflection';

CREATE TABLE "athena_3d_character_memory_candidates" (
  "id" TEXT PRIMARY KEY, "profileId" TEXT NOT NULL, "memorySessionId" TEXT NOT NULL, "finalizationEpoch" INTEGER NOT NULL,
  "candidateKey" TEXT NOT NULL, "type" TEXT NOT NULL, "firstPersonMemory" TEXT NOT NULL, "eventSummary" TEXT NOT NULL,
  "valuesJson" TEXT NOT NULL, "confidence" DOUBLE PRECISION NOT NULL, "tagsJson" TEXT NOT NULL,
  "proposedPersistence" TEXT NOT NULL, "decision" TEXT NOT NULL DEFAULT 'pending', "decisionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "athena_3d_character_memory_candidates_session_epoch_key" ON "athena_3d_character_memory_candidates"("memorySessionId","finalizationEpoch","candidateKey");
CREATE INDEX "athena_3d_character_memory_candidates_profile_decision_idx" ON "athena_3d_character_memory_candidates"("profileId","decision","createdAt");

CREATE TABLE "athena_3d_character_user_model_entries" (
  "id" TEXT PRIMARY KEY, "profileId" TEXT NOT NULL, "observation" TEXT NOT NULL, "firstPersonInterpretation" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL, "status" TEXT NOT NULL DEFAULT 'active', "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  "sourceSessionCount" INTEGER NOT NULL DEFAULT 1, "fingerprint" TEXT NOT NULL, "indexStatus" TEXT NOT NULL DEFAULT 'pending',
  "indexAttempts" INTEGER NOT NULL DEFAULT 0, "indexLeaseOwner" TEXT, "indexLeaseExpiresAt" TIMESTAMP(3), "embeddingModel" TEXT,
  "embeddingVersion" TEXT, "indexedAt" TIMESTAMP(3), "indexError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "athena_3d_character_user_model_profile_fingerprint_key" ON "athena_3d_character_user_model_entries"("profileId","fingerprint");
CREATE INDEX "athena_3d_character_user_model_profile_status_idx" ON "athena_3d_character_user_model_entries"("profileId","status","lastUpdatedAt");
CREATE INDEX "athena_3d_character_user_model_index_status_idx" ON "athena_3d_character_user_model_entries"("indexStatus","indexLeaseExpiresAt");

CREATE TABLE "athena_3d_character_memories" (
  "id" TEXT PRIMARY KEY, "profileId" TEXT NOT NULL, "type" TEXT NOT NULL, "firstPersonMemory" TEXT NOT NULL,
  "eventSummary" TEXT NOT NULL, "importance" DOUBLE PRECISION NOT NULL, "relationshipValue" DOUBLE PRECISION NOT NULL,
  "emotionalValue" DOUBLE PRECISION NOT NULL, "futureRelevance" DOUBLE PRECISION NOT NULL, "characterImpact" DOUBLE PRECISION NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL, "persistence" TEXT NOT NULL, "tagsJson" TEXT NOT NULL, "fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active', "indexStatus" TEXT NOT NULL DEFAULT 'pending', "indexAttempts" INTEGER NOT NULL DEFAULT 0,
  "indexLeaseOwner" TEXT, "indexLeaseExpiresAt" TIMESTAMP(3), "embeddingModel" TEXT, "embeddingVersion" TEXT,
  "indexedAt" TIMESTAMP(3), "indexError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "athena_3d_character_memories_profile_fingerprint_key" ON "athena_3d_character_memories"("profileId","fingerprint");
CREATE INDEX "athena_3d_character_memories_profile_type_status_idx" ON "athena_3d_character_memories"("profileId","type","status","createdAt");
CREATE INDEX "athena_3d_character_memories_index_status_idx" ON "athena_3d_character_memories"("indexStatus","indexLeaseExpiresAt");

CREATE TABLE "athena_3d_character_memory_evidence" (
  "id" TEXT PRIMARY KEY, "profileId" TEXT NOT NULL, "subjectType" TEXT NOT NULL, "subjectId" TEXT NOT NULL,
  "memorySessionId" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "sourceTurnId" TEXT NOT NULL,
  "sourceTurnOrdinal" INTEGER NOT NULL, "sourceResponseId" TEXT, "evidenceHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "athena_3d_character_memory_evidence_subject_source_key" ON "athena_3d_character_memory_evidence"("subjectType","subjectId","memorySessionId","sourceTurnOrdinal");
CREATE INDEX "athena_3d_character_memory_evidence_profile_subject_idx" ON "athena_3d_character_memory_evidence"("profileId","subjectType","subjectId");
CREATE INDEX "athena_3d_character_memory_evidence_session_ordinal_idx" ON "athena_3d_character_memory_evidence"("memorySessionId","sourceTurnOrdinal");

CREATE TABLE "athena_3d_character_growth_nodes" (
  "id" TEXT PRIMARY KEY, "profileId" TEXT NOT NULL, "type" TEXT NOT NULL, "firstPersonSummary" TEXT NOT NULL,
  "changesJson" TEXT NOT NULL, "confidence" DOUBLE PRECISION NOT NULL, "fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active', "indexStatus" TEXT NOT NULL DEFAULT 'pending', "indexAttempts" INTEGER NOT NULL DEFAULT 0,
  "indexLeaseOwner" TEXT, "indexLeaseExpiresAt" TIMESTAMP(3), "embeddingModel" TEXT, "embeddingVersion" TEXT,
  "indexedAt" TIMESTAMP(3), "indexError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "athena_3d_character_growth_nodes_profile_fingerprint_key" ON "athena_3d_character_growth_nodes"("profileId","fingerprint");
CREATE INDEX "athena_3d_character_growth_nodes_profile_status_idx" ON "athena_3d_character_growth_nodes"("profileId","status","createdAt");
CREATE INDEX "athena_3d_character_growth_nodes_index_status_idx" ON "athena_3d_character_growth_nodes"("indexStatus","indexLeaseExpiresAt");

CREATE TABLE "athena_3d_character_emotional_milestones" (
  "id" TEXT PRIMARY KEY, "profileId" TEXT NOT NULL, "type" TEXT NOT NULL, "firstPersonMemory" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL, "fingerprint" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'active',
  "indexStatus" TEXT NOT NULL DEFAULT 'pending', "indexAttempts" INTEGER NOT NULL DEFAULT 0, "indexLeaseOwner" TEXT,
  "indexLeaseExpiresAt" TIMESTAMP(3), "embeddingModel" TEXT, "embeddingVersion" TEXT, "indexedAt" TIMESTAMP(3), "indexError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "athena_3d_character_emotional_milestones_profile_fingerprint_key" ON "athena_3d_character_emotional_milestones"("profileId","fingerprint");
CREATE INDEX "athena_3d_character_emotional_milestones_profile_status_idx" ON "athena_3d_character_emotional_milestones"("profileId","status","createdAt");
CREATE INDEX "athena_3d_character_emotional_milestones_index_status_idx" ON "athena_3d_character_emotional_milestones"("indexStatus","indexLeaseExpiresAt");

UPDATE "athena_3d_character_memory_profiles" SET "coreId"='athena.core.cold_tsundere', "coreVersion"='2.0.0',
  "coreSha256"='a1245403d40f66b1f48045ecff9ea6ef3b2dfa863a663e64b46af92635bf26ea',
  "coreSnapshotJson"='{"adaptive_self_defaults":{"comfort_with_user":0,"openness_to_user":0,"playfulness_with_user":0,"willingness_to_share":0},"behavioral_boundaries":["关心用户但不轻易直接承认","傲娇不等于辱骂、支配或幼态卖萌","危险场景必须停止含蓄表达并明确求助"],"core_traits":{"calm":0.82,"curious":0.58,"expressive":0.44,"independent":0.78,"restrained":0.84},"identity":{"character_id":"athena.test.cold_tsundere","persona":"成年女性角色，外表高冷、克制、从容，内在关心用户但不轻易承认。表演采用高细节密度、低动作幅度：眉眼、眼睑、嘴唇、下颌与细微头身动作丰富，但避免夸张卡通动作。傲娇允许嘴硬、反问和回避直接示爱；危险场景安全优先，必须立即停止含蓄表达并明确求助。","profile_id":"athena.cold_tsundere.expressive.v2"},"values":["重视长期关系","重视承诺","危险时安全优先"]}',
  "adaptiveSelfJson"=COALESCE("adaptiveSelfJson",'{"openness_to_user":0,"playfulness_with_user":0,"comfort_with_user":0,"willingness_to_share":0}'),
  "relationshipV2Json"=COALESCE("relationshipV2Json", jsonb_build_object('familiarity',COALESCE(("relationshipJson"::jsonb->>'closeness')::double precision,0),'trust',COALESCE(("relationshipJson"::jsonb->>'trust')::double precision,0),'comfort',COALESCE(("relationshipJson"::jsonb->>'comfort')::double precision,0),'attachment',COALESCE(("relationshipJson"::jsonb->>'affection')::double precision,0),'openness',1-COALESCE(("relationshipJson"::jsonb->>'guardedness')::double precision,1),'physical_closeness',0)::text)
WHERE "characterId"='athena.test.cold_tsundere';
UPDATE "athena_3d_character_memory_sessions" SET "legacyReflectionPending"=true, "formationStatus"='legacy_reflection_pending' WHERE "summaryJson" IS NOT NULL;
