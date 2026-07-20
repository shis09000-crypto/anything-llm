-- CreateTable
CREATE TABLE "api_keys" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "secret" TEXT,
    "createdBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_documents" (
    "id" SERIAL NOT NULL,
    "docId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "docpath" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "metadata" TEXT,
    "pinned" BOOLEAN DEFAULT false,
    "watched" BOOLEAN DEFAULT false,
    "embeddingStatus" TEXT NOT NULL DEFAULT 'completed',
    "embeddingError" TEXT,
    "embeddingBatchJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceVisualAsset" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "scopeType" TEXT NOT NULL DEFAULT 'workspace',
    "nodeKey" TEXT,
    "nodeLabel" TEXT,
    "nodeType" TEXT,
    "role" TEXT NOT NULL DEFAULT 'hero_background',
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceVisualAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceOverviewNarrative" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "tagline" TEXT,
    "sourceHash" TEXT NOT NULL DEFAULT '',
    "model" TEXT,
    "promptVersion" TEXT NOT NULL DEFAULT 'workspace-overview-tagline-v2',
    "status" TEXT NOT NULL DEFAULT 'empty',
    "errorType" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "lastGeneratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceOverviewNarrative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeSupplement" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "nodeId" INTEGER,
    "nodeKey" TEXT NOT NULL,
    "nodeLabel" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL DEFAULT 'concept',
    "documentId" TEXT NOT NULL,
    "documentName" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeSupplement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceSupplement" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "scopeType" TEXT NOT NULL DEFAULT 'workspace',
    "primaryDocumentId" TEXT NOT NULL DEFAULT '__workspace__',
    "documentId" TEXT NOT NULL,
    "documentName" TEXT NOT NULL,
    "supplementKind" TEXT NOT NULL DEFAULT 'other',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSupplement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceKnowledgeProfile" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "profileType" TEXT NOT NULL DEFAULT 'mixed',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "primaryDocumentIdsJson" TEXT NOT NULL DEFAULT '[]',
    "mainTopic" TEXT,
    "detectedStructureJson" TEXT NOT NULL DEFAULT '{}',
    "suggestedGraphStrategy" TEXT,
    "profileVersion" TEXT NOT NULL DEFAULT 'workspace-profile-v1',
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideSource" TEXT,
    "overrideReason" TEXT,
    "originalProfileType" TEXT,
    "originalConfidence" DOUBLE PRECISION,
    "userDescription" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "lastAnalyzedAt" TIMESTAMP(3),
    "nextRefreshAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceKnowledgeProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookStructureAnalysis" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "structureType" TEXT NOT NULL DEFAULT 'mixed_structure',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "primaryAxis" TEXT,
    "secondaryAxesJson" TEXT NOT NULL DEFAULT '[]',
    "recommendedNodeTypesJson" TEXT NOT NULL DEFAULT '[]',
    "recommendedPathTypesJson" TEXT NOT NULL DEFAULT '[]',
    "extractionFocusJson" TEXT NOT NULL DEFAULT '[]',
    "recommendationFocusJson" TEXT NOT NULL DEFAULT '[]',
    "structureVersion" TEXT NOT NULL DEFAULT 'book-structure-v1',
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideSource" TEXT,
    "overrideReason" TEXT,
    "originalStructureType" TEXT,
    "originalConfidence" DOUBLE PRECISION,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "lastAnalyzedAt" TIMESTAMP(3),
    "nextRefreshAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookStructureAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeChunkBinding" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "relevanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "evidenceType" TEXT NOT NULL DEFAULT 'original',
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeChunkBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeLearningState" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL DEFAULT 0,
    "nodeKey" TEXT NOT NULL,
    "viewedCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "quizAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "wrongCount" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "masteryScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confusionScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "supplementCount" INTEGER NOT NULL DEFAULT 0,
    "hasUserSupplement" BOOLEAN NOT NULL DEFAULT false,
    "recommendedCount" INTEGER NOT NULL DEFAULT 0,
    "dismissedCount" INTEGER NOT NULL DEFAULT 0,
    "lastRecommendedAt" TIMESTAMP(3),
    "userMarkedImportant" BOOLEAN NOT NULL DEFAULT false,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeLearningState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "tokenHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimedBy" INTEGER,
    "workspaceIds" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" INTEGER NOT NULL,
    "createdByAdminId" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "usedByUserId" INTEGER,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_deletion_runs" (
    "runId" TEXT NOT NULL,
    "targetUserId" INTEGER NOT NULL,
    "targetAuthUserId" INTEGER,
    "actorUserId" INTEGER,
    "env" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "currentStep" TEXT,
    "completedStepsJson" TEXT NOT NULL DEFAULT '[]',
    "contextJson" TEXT NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "errorJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "account_deletion_runs_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "system_patrol_runs" (
    "id" SERIAL NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'light',
    "status" TEXT NOT NULL DEFAULT 'running',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "triggeredBy" INTEGER,
    "summaryScore" INTEGER NOT NULL DEFAULT 0,
    "summaryStatus" TEXT NOT NULL DEFAULT 'unknown',
    "countsJson" TEXT NOT NULL DEFAULT '{}',
    "reportJson" TEXT NOT NULL DEFAULT '{}',
    "reportObjectId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "system_patrol_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_patrol_repairs" (
    "id" SERIAL NOT NULL,
    "repairId" TEXT NOT NULL,
    "runId" INTEGER,
    "checkId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'previewed',
    "previewJson" TEXT NOT NULL DEFAULT '{}',
    "backupPath" TEXT,
    "confirmedBy" INTEGER,
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_patrol_repairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "authUserId" INTEGER,
    "originEnv" TEXT,
    "username" TEXT,
    "displayName" TEXT,
    "password" TEXT NOT NULL,
    "pfpFilename" TEXT,
    "role" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'active',
    "allowedEnvs" TEXT NOT NULL DEFAULT '[]',
    "ownerType" TEXT,
    "suspended" INTEGER NOT NULL DEFAULT 0,
    "previousRole" TEXT,
    "previousAllowedEnvs" TEXT,
    "previousOwnerType" TEXT,
    "banActorRole" TEXT,
    "banActorOwnerType" TEXT,
    "banActorAuthUserId" INTEGER,
    "bannedAt" TIMESTAMP(3),
    "seen_recovery_codes" BOOLEAN DEFAULT false,
    "email" TEXT,
    "email_verified_at" TIMESTAMP(3),
    "phone" TEXT,
    "phone_verified_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dailyMessageLimit" INTEGER,
    "bio" TEXT DEFAULT '',
    "web_push_subscription_config" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "sessionId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "authUserId" INTEGER,
    "clientId" TEXT,
    "authMode" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "vault_items" (
    "id" SERIAL NOT NULL,
    "itemId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "itemType" TEXT NOT NULL DEFAULT 'secret',
    "label" TEXT,
    "keyId" TEXT NOT NULL,
    "cryptoVersion" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "vault_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_candidates" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_memory_blocks" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isSensitive" BOOLEAN NOT NULL DEFAULT false,
    "encryptedPayload" TEXT,

    CONSTRAINT "user_memory_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_memory_archives" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "oldValue" TEXT NOT NULL,
    "replacedBy" INTEGER,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_memory_archives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profile_overviews" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "overview" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_profile_overviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthEnvironmentDeletion" (
    "id" SERIAL NOT NULL,
    "authUserId" INTEGER NOT NULL,
    "env" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedByAuthUserId" INTEGER,

    CONSTRAINT "AuthEnvironmentDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_quiz_attempts" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER,
    "cacheUserKey" TEXT NOT NULL DEFAULT 'anonymous',
    "quizId" TEXT NOT NULL,
    "quizChatId" INTEGER NOT NULL,
    "topic" TEXT,
    "keywordsJson" TEXT NOT NULL DEFAULT '[]',
    "difficulty" TEXT,
    "totalQuestions" INTEGER NOT NULL DEFAULT 0,
    "completedQuestions" INTEGER NOT NULL DEFAULT 0,
    "score" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "analysis" TEXT,
    "questionResultsReliable" INTEGER NOT NULL DEFAULT 1,
    "questionResultsParseError" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_quiz_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_quiz_question_results" (
    "id" SERIAL NOT NULL,
    "attemptId" INTEGER NOT NULL,
    "questionId" TEXT NOT NULL,
    "questionType" TEXT NOT NULL,
    "difficulty" TEXT,
    "question" TEXT NOT NULL,
    "optionsJson" TEXT NOT NULL DEFAULT '[]',
    "userAnswerJson" TEXT,
    "correctAnswerJson" TEXT,
    "isCorrect" INTEGER,
    "score" DOUBLE PRECISION,
    "analysis" TEXT,
    "mistakeReason" TEXT,
    "weakConceptsJson" TEXT NOT NULL DEFAULT '[]',
    "sourceRefsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_quiz_question_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_quiz_wrong_questions" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER,
    "cacheUserKey" TEXT NOT NULL DEFAULT 'anonymous',
    "attemptId" INTEGER NOT NULL,
    "questionResultId" INTEGER NOT NULL,
    "questionId" TEXT NOT NULL,
    "questionType" TEXT NOT NULL,
    "topic" TEXT,
    "question" TEXT NOT NULL,
    "optionsJson" TEXT NOT NULL DEFAULT '[]',
    "userAnswerJson" TEXT,
    "correctAnswerJson" TEXT,
    "analysis" TEXT,
    "mistakeReason" TEXT,
    "weakConceptsJson" TEXT NOT NULL DEFAULT '[]',
    "sourceRefsJson" TEXT NOT NULL DEFAULT '[]',
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_quiz_wrong_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_quiz_favorite_questions" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER,
    "cacheUserKey" TEXT NOT NULL DEFAULT 'anonymous',
    "quizId" TEXT NOT NULL,
    "quizChatId" INTEGER NOT NULL,
    "attemptId" INTEGER,
    "questionResultId" INTEGER,
    "questionId" TEXT NOT NULL,
    "questionType" TEXT NOT NULL,
    "topic" TEXT,
    "difficulty" TEXT,
    "question" TEXT NOT NULL,
    "optionsJson" TEXT NOT NULL DEFAULT '[]',
    "correctAnswerJson" TEXT,
    "userAnswerJson" TEXT,
    "analysis" TEXT,
    "sourceRefsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_quiz_favorite_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "code_hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_codes" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "challenge_id" TEXT,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "request_ip" TEXT,
    "client_id" TEXT,
    "device_id" TEXT,
    "session_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_grants" (
    "id" SERIAL NOT NULL,
    "grant_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "grant_hash" TEXT NOT NULL,
    "challenge_id" TEXT,
    "email" TEXT NOT NULL,
    "client_id" TEXT,
    "device_id" TEXT,
    "session_id" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_rate_limits" (
    "id" SERIAL NOT NULL,
    "bucket_hash" TEXT NOT NULL,
    "bucket_type" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "blockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_rate_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasskeyCredential" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT NOT NULL DEFAULT '[]',
    "deviceType" TEXT NOT NULL DEFAULT 'platform',
    "deviceName" TEXT NOT NULL DEFAULT 'This Device',
    "browserName" TEXT,
    "platformName" TEXT,
    "aaguid" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'unknown',
    "providerName" TEXT NOT NULL DEFAULT '来源待确认',
    "backedUp" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasskeyChallenge" (
    "id" SERIAL NOT NULL,
    "challenge" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "userId" INTEGER,
    "requestIp" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasskeyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedLoginDevice" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL DEFAULT 'This Device',
    "verifier" TEXT NOT NULL,
    "publicCommitment" TEXT NOT NULL,
    "opaqueRegistrationRecord" TEXT,
    "deviceSalt" TEXT,
    "lastChallengeAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TrustedLoginDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "athena_clients" (
    "id" SERIAL NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "platform" TEXT NOT NULL,
    "deviceName" TEXT,
    "appVersion" TEXT,
    "trustLevel" TEXT NOT NULL DEFAULT 'low',
    "capabilities" TEXT,
    "capabilitySource" TEXT NOT NULL DEFAULT 'unknown',
    "publicKey" TEXT,
    "deviceFingerprintVersion" TEXT,
    "signingSecretEncrypted" TEXT,
    "signingSecretVersion" TEXT,
    "signingSecretIssuedAt" TIMESTAMP(3),
    "signingSecretRotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "athena_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "athena_request_nonces" (
    "id" SERIAL NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" INTEGER,
    "nonce" TEXT NOT NULL,
    "requestId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "athena_request_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_state_preferences" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "namespace" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "value" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_state_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reader_book_catalog" (
    "id" SERIAL NOT NULL,
    "catalogKey" TEXT NOT NULL,
    "readerDocumentId" TEXT NOT NULL,
    "workspaceSlug" TEXT,
    "title" TEXT,
    "documentType" TEXT,
    "mimeType" TEXT,
    "fingerprint" TEXT,
    "previewStatus" TEXT,
    "thumbnailStatus" TEXT,
    "classificationStatus" TEXT,
    "availability" TEXT NOT NULL DEFAULT 'available',
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reader_book_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reader_library_items" (
    "id" SERIAL NOT NULL,
    "itemId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "catalogKey" TEXT NOT NULL,
    "readerDocumentId" TEXT NOT NULL,
    "workspaceSlug" TEXT,
    "itemKey" TEXT NOT NULL,
    "title" TEXT,
    "categoryId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "progressJson" TEXT NOT NULL DEFAULT '{}',
    "stateJson" TEXT NOT NULL DEFAULT '{}',
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "hiddenAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "tombstone" BOOLEAN NOT NULL DEFAULT false,
    "availability" TEXT NOT NULL DEFAULT 'available',
    "mutationVersion" INTEGER NOT NULL DEFAULT 1,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reader_library_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reader_library_categories" (
    "id" SERIAL NOT NULL,
    "categoryId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "hiddenAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "mutationVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reader_library_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reader_worker_jobs" (
    "id" SERIAL NOT NULL,
    "jobId" TEXT NOT NULL,
    "queue" TEXT NOT NULL DEFAULT 'reader',
    "task" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" TEXT NOT NULL DEFAULT 'P4',
    "intent" TEXT NOT NULL DEFAULT 'maintenance',
    "userId" INTEGER,
    "workspaceSlug" TEXT,
    "readerDocumentId" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "resultJson" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reader_worker_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZkLoginAttempt" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "serverLoginState" TEXT NOT NULL,
    "requestIp" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZkLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_vectors" (
    "id" SERIAL NOT NULL,
    "docId" TEXT NOT NULL,
    "vectorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_vectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentIndexStatus" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "docId" TEXT,
    "filePath" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL DEFAULT '',
    "indexStatus" TEXT NOT NULL DEFAULT 'pending',
    "indexedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "embeddingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentIndexStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeNode" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "canonicalKey" TEXT NOT NULL,
    "aliases" TEXT NOT NULL DEFAULT '[]',
    "displayNameZh" TEXT,
    "displayNameEn" TEXT,
    "entityType" TEXT NOT NULL DEFAULT 'concept',
    "summary" TEXT,
    "globalImportanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "workspaceImportanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recentImportanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "recentUsageCount" INTEGER NOT NULL DEFAULT 0,
    "lastReferencedAt" TIMESTAMP(3),
    "embedding" TEXT,
    "embeddingModel" TEXT,
    "embeddingVersion" TEXT,
    "mergeLogicVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeEdge" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "sourceNodeId" INTEGER NOT NULL,
    "targetNodeId" INTEGER NOT NULL,
    "relationType" TEXT NOT NULL,
    "relationLabel" TEXT,
    "relationLabelZh" TEXT,
    "relationLabelEn" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastReferencedAt" TIMESTAMP(3),
    "extractionPromptVersion" TEXT NOT NULL,
    "mergeLogicVersion" TEXT NOT NULL,
    "relationOntologyVersion" TEXT NOT NULL,
    "graphVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeEvidence" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "edgeId" INTEGER NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "snippet" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "extractionJobId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EdgeEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptChunkMap" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "relevanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mentionCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConceptChunkMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphExtractionJob" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "chunkId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "graphVersion" TEXT NOT NULL,
    "extractionPromptVersion" TEXT NOT NULL,
    "promptDomain" TEXT NOT NULL,
    "mergeLogicVersion" TEXT NOT NULL,
    "relationOntologyVersion" TEXT NOT NULL,
    "extractedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphExtractionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphRetrievalCache" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "conceptKey" TEXT NOT NULL,
    "paramsHash" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphRetrievalCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphLabelTranslationCache" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'node',
    "displayNameZh" TEXT,
    "displayNameEn" TEXT,
    "aliasesJson" TEXT NOT NULL DEFAULT '[]',
    "model" TEXT,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphLabelTranslationCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeGraphRepairIssue" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "documentId" TEXT NOT NULL DEFAULT '',
    "chunkId" TEXT NOT NULL DEFAULT '',
    "issueType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priorityReason" TEXT,
    "rootConceptHit" BOOLEAN NOT NULL DEFAULT false,
    "workspaceImportanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "traversalUsageCount" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "repairMethod" TEXT,
    "repairConfidence" TEXT,
    "lastError" TEXT,
    "explainReason" TEXT,
    "quarantineReason" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeGraphRepairIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeGraphRepairRun" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'auto',
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "repaired" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "budgetExhausted" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "tokenBudgetUsed" INTEGER NOT NULL DEFAULT 0,
    "providerBudgetUsed" INTEGER NOT NULL DEFAULT 0,
    "successRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgRepairLatencyMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "providerFailureRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "needsReembedCount" INTEGER NOT NULL DEFAULT 0,
    "quarantinedCount" INTEGER NOT NULL DEFAULT 0,
    "lowConfidenceRelationRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "relatedToRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "malformedExtractionRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "abnormalFanoutCount" INTEGER NOT NULL DEFAULT 0,
    "timeoutRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "malformedJsonRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgExtractionLatencyMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "providerFailureTrend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "metricsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeGraphRepairRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeGraphEvidenceUsage" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeGraphEvidenceUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeNodeMetrics" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "evidenceStrength" INTEGER NOT NULL DEFAULT 0,
    "bridgeValue" INTEGER NOT NULL DEFAULT 0,
    "knowledgeConnectivity" INTEGER NOT NULL DEFAULT 0,
    "traversalImportance" INTEGER NOT NULL DEFAULT 0,
    "crossDocumentPresence" INTEGER NOT NULL DEFAULT 0,
    "freshness" INTEGER NOT NULL DEFAULT 0,
    "relationDiversity" INTEGER NOT NULL DEFAULT 0,
    "sourceAuthority" INTEGER NOT NULL DEFAULT 0,
    "stability" INTEGER NOT NULL DEFAULT 0,
    "conflictSafety" INTEGER NOT NULL DEFAULT 0,
    "reasonsJson" TEXT NOT NULL DEFAULT '{}',
    "normalizedInputsJson" TEXT NOT NULL DEFAULT '{}',
    "formulaVersion" TEXT NOT NULL DEFAULT 'metrics-v1',
    "stale" BOOLEAN NOT NULL DEFAULT true,
    "warning" TEXT,
    "lastError" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeNodeMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeNodeMetricsSnapshot" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "formulaVersion" TEXT NOT NULL,
    "scoresJson" TEXT NOT NULL,
    "normalizedInputsJson" TEXT NOT NULL DEFAULT '{}',
    "snapshotPeriod" TEXT NOT NULL DEFAULT 'daily',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeNodeMetricsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeNodeMetricsRecomputeRun" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER,
    "trigger" TEXT NOT NULL DEFAULT 'worker',
    "formulaVersion" TEXT NOT NULL DEFAULT 'metrics-v1',
    "batchSize" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "lockedCount" INTEGER NOT NULL DEFAULT 0,
    "errorJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeNodeMetricsRecomputeRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceOverviewRecommendationUsage" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL DEFAULT 0,
    "recommendationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "formulaVersion" TEXT NOT NULL,
    "impressionCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "dismissCount" INTEGER NOT NULL DEFAULT 0,
    "continueCount" INTEGER NOT NULL DEFAULT 0,
    "lastShownAt" TIMESTAMP(3),
    "lastInteractedAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceOverviewRecommendationUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" SERIAL NOT NULL,
    "sourceActionId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "vectorTag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openAiTemp" DOUBLE PRECISION,
    "openAiHistory" INTEGER NOT NULL DEFAULT 20,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openAiPrompt" TEXT,
    "similarityThreshold" DOUBLE PRECISION DEFAULT 0.25,
    "chatProvider" TEXT,
    "chatModel" TEXT,
    "topN" INTEGER DEFAULT 4,
    "chatMode" TEXT DEFAULT 'chat',
    "pfpFilename" TEXT,
    "agentProvider" TEXT,
    "agentModel" TEXT,
    "queryRefusalResponse" TEXT,
    "vectorSearchMode" TEXT DEFAULT 'default',

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_threads" (
    "id" SERIAL NOT NULL,
    "sourceActionId" TEXT,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "titleSource" TEXT,
    "titleGeneratedAt" TIMESTAMP(3),
    "titleHash" TEXT,
    "titleVersion" INTEGER NOT NULL DEFAULT 0,
    "titleMessageScope" TEXT,
    "titleGenerationStatus" TEXT NOT NULL DEFAULT 'idle',
    "slug" TEXT NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "parent_thread_id" INTEGER,
    "thread_type" TEXT,
    "chatModel" TEXT,
    "historyRevision" INTEGER NOT NULL DEFAULT 0,
    "created_from" TEXT,
    "forked_at_message_id" INTEGER,
    "forked_at" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "athena_sync_events" (
    "id" SERIAL NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" INTEGER,
    "targetClientId" TEXT,
    "namespace" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "version" TEXT,
    "revision" TEXT,
    "scopeJson" TEXT NOT NULL DEFAULT '{}',
    "resourceJson" TEXT NOT NULL DEFAULT '{}',
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "originJson" TEXT NOT NULL DEFAULT '{}',
    "sourceClientId" TEXT,
    "requiresAck" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "athena_sync_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "athena_ios_push_tokens" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "clientId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "tokenEncrypted" TEXT NOT NULL,
    "tokenFingerprint" TEXT NOT NULL,
    "appVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "athena_ios_push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "athena_mutation_receipts" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "sourceActionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "workspaceId" INTEGER,
    "threadId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resourceJson" TEXT NOT NULL DEFAULT '{}',
    "errorCode" TEXT,
    "baseVersion" INTEGER,
    "resultVersion" INTEGER,
    "requestHash" TEXT,
    "nodeKey" TEXT,
    "mutationId" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "recoveredAt" TIMESTAMP(3),
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "athena_mutation_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_nodes" (
    "id" SERIAL NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "parentKey" TEXT,
    "ownerType" TEXT NOT NULL,
    "ownerId" INTEGER,
    "visibility" TEXT NOT NULL DEFAULT 'user',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "stateVersion" INTEGER NOT NULL DEFAULT 1,
    "contentHash" TEXT,
    "hashAlgorithm" TEXT NOT NULL DEFAULT 'sha256',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "sync_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_outbox" (
    "seq" SERIAL NOT NULL,
    "eventId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" INTEGER,
    "visibility" TEXT NOT NULL DEFAULT 'user',
    "stateVersion" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "changedPathsJson" TEXT NOT NULL DEFAULT '[]',
    "payloadHintJson" TEXT NOT NULL DEFAULT '{}',
    "audienceJson" TEXT NOT NULL DEFAULT '[]',
    "originClientId" TEXT,
    "mutationId" TEXT,
    "requestId" TEXT,
    "traceId" TEXT,
    "traceparent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorDetail" TEXT,
    "deadLetteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "sync_outbox_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "security_audit_ledger" (
    "id" SERIAL NOT NULL,
    "chainId" TEXT NOT NULL DEFAULT 'security-v1',
    "sequence" INTEGER NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "userId" INTEGER,
    "requestId" TEXT,
    "traceId" TEXT,
    "previousHash" TEXT NOT NULL,
    "entryHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_audit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_audit_checkpoints" (
    "id" SERIAL NOT NULL,
    "chainId" TEXT NOT NULL DEFAULT 'security-v1',
    "throughSequence" INTEGER NOT NULL,
    "throughHash" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'ed25519',
    "keyId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_audit_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_client_cursors" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" TEXT,
    "lastAppliedSeq" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_client_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_suggested_messages" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "heading" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_suggested_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_chats" (
    "id" SERIAL NOT NULL,
    "public_id" TEXT,
    "clientTurnId" TEXT,
    "workspaceId" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "include" BOOLEAN NOT NULL DEFAULT true,
    "user_id" INTEGER,
    "thread_id" INTEGER,
    "original_thread_id" INTEGER,
    "original_message_id" INTEGER,
    "created_from" TEXT,
    "api_session_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageVersion" INTEGER NOT NULL DEFAULT 1,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "feedbackScore" BOOLEAN,

    CONSTRAINT "workspace_chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_objects" (
    "id" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "scopeHash" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "plaintextSha256" TEXT NOT NULL,
    "plaintextSize" INTEGER NOT NULL,
    "mimeType" TEXT,
    "provider" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "ciphertextSha256" TEXT NOT NULL,
    "encryptionVersion" TEXT NOT NULL,
    "wrappedDek" TEXT NOT NULL,
    "encryptionMetadataJson" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "refCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "deleteAfter" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "content_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_chat_attachment_refs" (
    "id" TEXT NOT NULL,
    "chatId" INTEGER NOT NULL,
    "contentObjectId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_chat_attachment_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_chat_content_refs" (
    "id" TEXT NOT NULL,
    "chatId" INTEGER NOT NULL,
    "contentObjectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "jsonPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_chat_content_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_attachment_uploads" (
    "id" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER,
    "contentObjectId" TEXT,
    "displayName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "expectedSize" INTEGER,
    "expectedSha256" TEXT,
    "receivedBytes" INTEGER NOT NULL DEFAULT 0,
    "partsJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "chat_attachment_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_attachment_upload_parts" (
    "uploadId" TEXT NOT NULL,
    "partNumber" INTEGER NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_attachment_upload_parts_pkey" PRIMARY KEY ("uploadId","partNumber")
);

-- CreateTable
CREATE TABLE "workspace_chat_conversation_keys" (
    "id" SERIAL NOT NULL,
    "key_id" TEXT NOT NULL,
    "scope_hash" TEXT NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "thread_id" INTEGER,
    "api_session_id" TEXT,
    "wrapped_key" TEXT NOT NULL,
    "crypto_version" TEXT NOT NULL DEFAULT 'athena-chat-key:v1',
    "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_chat_conversation_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_chat_crypto_metadata" (
    "id" SERIAL NOT NULL,
    "chat_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "thread_id" INTEGER,
    "api_session_id" TEXT,
    "scope_hash" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "crypto_version" TEXT NOT NULL,
    "prompt_cipher_hash" TEXT NOT NULL,
    "response_cipher_hash" TEXT NOT NULL,
    "prev_chain_hash" TEXT,
    "chain_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_chat_crypto_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_chat_compactions" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "thread_id" INTEGER,
    "api_session_id" TEXT,
    "summary" TEXT NOT NULL,
    "summary_format" TEXT NOT NULL DEFAULT 'thread-compact-markdown-v1',
    "capsule_json" TEXT,
    "covered_chat_ids" TEXT NOT NULL DEFAULT '[]',
    "covered_from_chat_id" INTEGER,
    "covered_to_chat_id" INTEGER,
    "covered_message_count" INTEGER NOT NULL DEFAULT 0,
    "token_before" INTEGER NOT NULL DEFAULT 0,
    "token_after" INTEGER NOT NULL DEFAULT 0,
    "metadata_json" TEXT NOT NULL DEFAULT '{}',
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_chat_compactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_assertions" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "assertionType" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'candidate',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "createdByType" TEXT NOT NULL,
    "createdByUserId" INTEGER,
    "normalizedHash" TEXT NOT NULL,
    "supersededById" INTEGER,
    "profileRevision" INTEGER,
    "disclosureLevel" TEXT NOT NULL DEFAULT 'workspace_only',
    "reviewReason" TEXT,
    "canonicalItemId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_cognitive_assertions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_positions" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "assertionId" INTEGER NOT NULL,
    "subjectUserId" INTEGER NOT NULL,
    "proposedByUserId" INTEGER,
    "stance" TEXT NOT NULL,
    "rationale" TEXT,
    "conditionsJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "meetingDisclosure" TEXT NOT NULL DEFAULT 'workspace_only',
    "confirmedAt" TIMESTAMP(3),
    "sourceChatId" INTEGER,
    "supersededById" INTEGER,
    "canonicalPositionVersionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_cognitive_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_evidence" (
    "id" SERIAL NOT NULL,
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
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "freshness" TEXT NOT NULL DEFAULT 'current',
    "disclosureLevel" TEXT NOT NULL DEFAULT 'workspace_only',
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "canonicalEvidenceId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_cognitive_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_relations" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "fromAssertionId" INTEGER NOT NULL,
    "toAssertionId" INTEGER NOT NULL,
    "relationType" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdByType" TEXT NOT NULL DEFAULT 'system',
    "canonicalRelationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_cognitive_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_profiles" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "profileJson" TEXT NOT NULL DEFAULT '{}',
    "sourceWatermark" TEXT,
    "contentHash" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_extraction_jobs" (
    "id" SERIAL NOT NULL,
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
    "idempotencyKey" TEXT,
    "scopeKey" TEXT,
    "triggerReason" TEXT NOT NULL DEFAULT 'manual',
    "pipeline" TEXT NOT NULL DEFAULT 'direct_refine',
    "phase" TEXT NOT NULL DEFAULT 'pending',
    "chatIdsJson" TEXT NOT NULL DEFAULT '[]',
    "inputContentHash" TEXT,
    "screeningOutputJson" TEXT,
    "refiningOutputJson" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextRetryAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "pipelineVersion" INTEGER NOT NULL DEFAULT 3,
    "jobType" TEXT NOT NULL DEFAULT 'rough_screen',
    "priority" INTEGER NOT NULL DEFAULT 10,
    "partialGroup" BOOLEAN NOT NULL DEFAULT false,
    "modelMaxTokens" INTEGER,
    "protocolRepairAttempted" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_cognitive_extraction_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_turn_buffer" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "threadId" INTEGER,
    "scopeKey" TEXT NOT NULL,
    "chatId" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceChannel" TEXT NOT NULL DEFAULT 'web',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "jobId" INTEGER,
    "claimedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "screenedAt" TIMESTAMP(3),
    "roughResultId" INTEGER,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_turn_buffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_rough_results" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "roughJobId" INTEGER NOT NULL,
    "threadId" INTEGER,
    "scopeKey" TEXT NOT NULL,
    "chatIdsJson" TEXT NOT NULL DEFAULT '[]',
    "inputContentHash" TEXT NOT NULL,
    "segmentRefsJson" TEXT NOT NULL DEFAULT '[]',
    "outputHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "readyAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refineJobId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_cognitive_rough_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_refine_inputs" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "refineJobId" INTEGER NOT NULL,
    "roughResultId" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_refine_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_extraction_attempts" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "jobId" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheHitTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheMissTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "inputHash" TEXT,
    "outputHash" TEXT,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "metricsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_extraction_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_thread_state" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "threadId" INTEGER,
    "scopeKey" TEXT NOT NULL,
    "lastEnqueuedChatId" INTEGER,
    "lastExtractedChatId" INTEGER,
    "pendingTurnCount" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3),
    "flushRequestedAt" TIMESTAMP(3),
    "flushReason" TEXT,
    "pausedAt" TIMESTAMP(3),
    "activeJobId" INTEGER,
    "lastErrorCode" TEXT,
    "lastErrorDetail" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_cognitive_thread_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_candidates" (
    "id" SERIAL NOT NULL,
    "candidateKey" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "threadId" INTEGER,
    "extractionJobId" INTEGER,
    "assertionType" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "subjectUserId" INTEGER,
    "stance" TEXT,
    "rationale" TEXT,
    "conditionsJson" TEXT NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sourceChatIdsJson" TEXT NOT NULL DEFAULT '[]',
    "evidenceJson" TEXT NOT NULL DEFAULT '[]',
    "suggestedRelationJson" TEXT NOT NULL DEFAULT '{}',
    "normalizedHash" TEXT NOT NULL,
    "rawModelOutputJson" TEXT NOT NULL DEFAULT '{}',
    "pipelineVersion" INTEGER NOT NULL DEFAULT 3,
    "legacyPipeline" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_candidate_events" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorUserId" INTEGER,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_candidate_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_items" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "itemKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "candidateId" INTEGER,
    "assertionType" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "createdByType" TEXT NOT NULL,
    "createdByUserId" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "disclosureLevel" TEXT NOT NULL DEFAULT 'workspace_only',
    "isTemporary" BOOLEAN NOT NULL DEFAULT false,
    "normalizedHash" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_position_versions" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "cognitiveItemId" INTEGER NOT NULL,
    "subjectUserId" INTEGER NOT NULL,
    "stance" TEXT NOT NULL,
    "rationale" TEXT,
    "conditionsJson" TEXT NOT NULL DEFAULT '{}',
    "meetingDisclosure" TEXT NOT NULL DEFAULT 'workspace_only',
    "isTemporary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_position_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_item_relations" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "fromItemId" INTEGER NOT NULL,
    "toItemId" INTEGER NOT NULL,
    "relationType" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rationale" TEXT,
    "createdByType" TEXT NOT NULL DEFAULT 'user',
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_item_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_item_evidence" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "cognitiveItemId" INTEGER NOT NULL,
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
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "disclosureLevel" TEXT NOT NULL DEFAULT 'workspace_only',
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_item_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_evidence_events" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "evidenceId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "reason" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'system',
    "actorUserId" INTEGER,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_evidence_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_profile_invalidations" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_profile_invalidations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_profile_state" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "dirtyGeneration" INTEGER NOT NULL DEFAULT 0,
    "rebuiltGeneration" INTEGER NOT NULL DEFAULT 0,
    "rebuildStatus" TEXT NOT NULL DEFAULT 'idle',
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_profile_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_cognitive_profile_items" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "profileRevision" INTEGER NOT NULL,
    "cognitiveItemId" INTEGER NOT NULL,
    "itemKey" TEXT NOT NULL,
    "itemVersion" INTEGER NOT NULL,
    "membershipType" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cognitive_profile_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_meeting_packets" (
    "id" SERIAL NOT NULL,
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
    "frozenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_meeting_packets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_meeting_authorizations" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "meetingPacketId" INTEGER NOT NULL,
    "actionType" TEXT NOT NULL,
    "targetScopeJson" TEXT NOT NULL DEFAULT '{}',
    "limitsJson" TEXT NOT NULL DEFAULT '{}',
    "conditionsJson" TEXT NOT NULL DEFAULT '{}',
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "allowConditional" BOOLEAN NOT NULL DEFAULT false,
    "requiresSecondApproval" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_meeting_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_meeting_sessions" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "meetingPacketId" INTEGER NOT NULL,
    "threadId" INTEGER NOT NULL,
    "delegateUserId" INTEGER,
    "createdByUserId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_meeting_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_meeting_audit_events" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "meetingSessionId" INTEGER NOT NULL,
    "actorUserId" INTEGER,
    "eventType" TEXT NOT NULL,
    "decision" TEXT,
    "requestJson" TEXT NOT NULL DEFAULT '{}',
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "evidenceRefsJson" TEXT NOT NULL DEFAULT '[]',
    "authorizationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_meeting_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_mind_maps" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "user_id" INTEGER,
    "thread_id" INTEGER,
    "cacheUserKey" TEXT NOT NULL DEFAULT 'anonymous',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceTitle" TEXT,
    "sourceHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "layout" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "schema" TEXT NOT NULL,
    "markdown" TEXT,
    "viewport" TEXT,
    "promptVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "generationModel" TEXT,
    "suitability" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_mind_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_agent_invocations" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "clientTurnId" TEXT,
    "prompt" TEXT NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "user_id" INTEGER,
    "thread_id" INTEGER,
    "workspace_id" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_agent_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_users" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cache_data" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "belongsTo" TEXT,
    "byId" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cache_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embed_configs" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "chat_mode" TEXT NOT NULL DEFAULT 'query',
    "allowlist_domains" TEXT,
    "allow_model_override" BOOLEAN NOT NULL DEFAULT false,
    "allow_temperature_override" BOOLEAN NOT NULL DEFAULT false,
    "allow_prompt_override" BOOLEAN NOT NULL DEFAULT false,
    "max_chats_per_day" INTEGER,
    "max_chats_per_session" INTEGER,
    "message_limit" INTEGER DEFAULT 20,
    "workspace_id" INTEGER NOT NULL,
    "createdBy" INTEGER,
    "usersId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embed_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embed_chats" (
    "id" SERIAL NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "include" BOOLEAN NOT NULL DEFAULT true,
    "connection_information" TEXT,
    "embed_id" INTEGER NOT NULL,
    "usersId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embed_chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_logs" (
    "id" SERIAL NOT NULL,
    "event" TEXT NOT NULL,
    "metadata" TEXT,
    "userId" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embedding_batch_jobs" (
    "id" SERIAL NOT NULL,
    "jobId" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "documentIds" TEXT NOT NULL,
    "documentPaths" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputFileId" TEXT,
    "batchId" TEXT,
    "outputFileId" TEXT,
    "errorFileId" TEXT,
    "createdBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lastTransientError" TEXT,

    CONSTRAINT "embedding_batch_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embedding_batch_job_events" (
    "id" SERIAL NOT NULL,
    "jobId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "metadata" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embedding_batch_job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slash_command_presets" (
    "id" SERIAL NOT NULL,
    "command" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "uid" INTEGER NOT NULL DEFAULT 0,
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slash_command_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sync_queues" (
    "id" SERIAL NOT NULL,
    "staleAfterMs" INTEGER NOT NULL DEFAULT 604800000,
    "nextSyncAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceDocId" INTEGER NOT NULL,

    CONSTRAINT "document_sync_queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sync_executions" (
    "id" SERIAL NOT NULL,
    "queueId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_sync_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_extension_api_keys" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "browser_extension_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temporary_auth_tokens" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temporary_auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_prompt_variables" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'system',
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_prompt_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_history" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "modifiedBy" INTEGER,
    "modifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "desktop_mobile_devices" (
    "id" SERIAL NOT NULL,
    "deviceOs" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_mobile_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_parsed_files" (
    "id" SERIAL NOT NULL,
    "filename" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER,
    "threadId" INTEGER,
    "metadata" TEXT,
    "tokenCountEstimate" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_parsed_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_communication_connectors" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_communication_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wechat_gateway_threads" (
    "id" SERIAL NOT NULL,
    "wxid" TEXT NOT NULL,
    "nickname" TEXT,
    "workspace_slug" TEXT NOT NULL,
    "thread_slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wechat_gateway_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "tools" TEXT,
    "capabilityManifest" TEXT NOT NULL DEFAULT '{}',
    "schedule" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_job_runs" (
    "id" SERIAL NOT NULL,
    "jobId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),

    CONSTRAINT "scheduled_job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_key_registry" (
    "id" SERIAL NOT NULL,
    "keyId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "canaryEnvelope" TEXT,
    "sourceDescriptor" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),

    CONSTRAINT "security_key_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_key_domain_bindings" (
    "id" SERIAL NOT NULL,
    "domain" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "activeKeyId" TEXT NOT NULL,
    "envelopeVersion" TEXT NOT NULL DEFAULT 'enc:v1',
    "coverageState" TEXT NOT NULL DEFAULT 'unknown',
    "coverage" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_key_domain_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_key_rotation_jobs" (
    "id" SERIAL NOT NULL,
    "jobId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "sourceKeyId" TEXT,
    "targetKeyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT NOT NULL DEFAULT 'prepare',
    "progress" TEXT,
    "failure" TEXT,
    "createdBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "security_key_rotation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_key_events" (
    "id" SERIAL NOT NULL,
    "event" TEXT NOT NULL,
    "keyId" TEXT,
    "purpose" TEXT,
    "jobId" TEXT,
    "metadata" TEXT,
    "createdBy" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_key_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_price_catalog" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelPattern" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "inputMicrosPerMillion" INTEGER,
    "outputMicrosPerMillion" INTEGER,
    "source" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_price_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_budget_policies" (
    "id" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL DEFAULT '*',
    "maxInputTokens" INTEGER,
    "maxOutputTokens" INTEGER,
    "maxToolCalls" INTEGER,
    "maxDurationMs" INTEGER,
    "maxCostMicros" INTEGER,
    "unknownPriceAction" TEXT NOT NULL DEFAULT 'limit',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_budget_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_budget_reservations" (
    "id" TEXT NOT NULL,
    "policyId" TEXT,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "userId" INTEGER,
    "workspaceId" INTEGER,
    "taskType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "reservedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "reservedOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "reservedToolCalls" INTEGER NOT NULL DEFAULT 0,
    "reservedDurationMs" INTEGER NOT NULL DEFAULT 0,
    "reservedCostMicros" INTEGER,
    "actualInputTokens" INTEGER,
    "actualOutputTokens" INTEGER,
    "actualToolCalls" INTEGER,
    "actualDurationMs" INTEGER,
    "actualCostMicros" INTEGER,
    "failureCode" TEXT,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "ai_budget_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_events" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT,
    "invocationId" TEXT,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "userId" INTEGER,
    "workspaceId" INTEGER,
    "taskType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER,
    "priceCatalogId" TEXT,
    "status" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "traceId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_eval_cases" (
    "id" TEXT NOT NULL,
    "suite" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "dataClass" TEXT NOT NULL DEFAULT 'synthetic',
    "authorizationRef" TEXT,
    "inputRef" TEXT,
    "expectedJson" TEXT NOT NULL DEFAULT '{}',
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_eval_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_eval_results" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "qualityScore" DOUBLE PRECISION,
    "safetyScore" DOUBLE PRECISION,
    "toolScore" DOUBLE PRECISION,
    "latencyMs" INTEGER,
    "costMicros" INTEGER,
    "resultRef" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_eval_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_secret_key" ON "api_keys"("secret");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_documents_docId_key" ON "workspace_documents"("docId");

-- CreateIndex
CREATE INDEX "WorkspaceVisualAsset_workspaceId_scopeType_role_idx" ON "WorkspaceVisualAsset"("workspaceId", "scopeType", "role");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceOverviewNarrative_workspaceId_key" ON "WorkspaceOverviewNarrative"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceOverviewNarrative_workspaceId_idx" ON "WorkspaceOverviewNarrative"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceOverviewNarrative_status_idx" ON "WorkspaceOverviewNarrative"("status");

-- CreateIndex
CREATE INDEX "NodeSupplement_workspaceId_nodeKey_idx" ON "NodeSupplement"("workspaceId", "nodeKey");

-- CreateIndex
CREATE INDEX "NodeSupplement_workspaceId_documentId_idx" ON "NodeSupplement"("workspaceId", "documentId");

-- CreateIndex
CREATE INDEX "NodeSupplement_workspaceId_nodeId_idx" ON "NodeSupplement"("workspaceId", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeSupplement_workspaceId_nodeKey_documentId_key" ON "NodeSupplement"("workspaceId", "nodeKey", "documentId");

-- CreateIndex
CREATE INDEX "WorkspaceSupplement_workspaceId_scopeType_supplementKind_idx" ON "WorkspaceSupplement"("workspaceId", "scopeType", "supplementKind");

-- CreateIndex
CREATE INDEX "WorkspaceSupplement_workspaceId_documentId_idx" ON "WorkspaceSupplement"("workspaceId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceSupplement_workspaceId_scopeType_primaryDocumentId_key" ON "WorkspaceSupplement"("workspaceId", "scopeType", "primaryDocumentId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceKnowledgeProfile_workspaceId_key" ON "WorkspaceKnowledgeProfile"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceKnowledgeProfile_workspaceId_idx" ON "WorkspaceKnowledgeProfile"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceKnowledgeProfile_profileType_idx" ON "WorkspaceKnowledgeProfile"("profileType");

-- CreateIndex
CREATE INDEX "WorkspaceKnowledgeProfile_nextRefreshAfter_idx" ON "WorkspaceKnowledgeProfile"("nextRefreshAfter");

-- CreateIndex
CREATE UNIQUE INDEX "BookStructureAnalysis_workspaceId_key" ON "BookStructureAnalysis"("workspaceId");

-- CreateIndex
CREATE INDEX "BookStructureAnalysis_workspaceId_idx" ON "BookStructureAnalysis"("workspaceId");

-- CreateIndex
CREATE INDEX "BookStructureAnalysis_structureType_idx" ON "BookStructureAnalysis"("structureType");

-- CreateIndex
CREATE INDEX "BookStructureAnalysis_nextRefreshAfter_idx" ON "BookStructureAnalysis"("nextRefreshAfter");

-- CreateIndex
CREATE INDEX "NodeChunkBinding_workspaceId_nodeKey_idx" ON "NodeChunkBinding"("workspaceId", "nodeKey");

-- CreateIndex
CREATE INDEX "NodeChunkBinding_workspaceId_documentId_idx" ON "NodeChunkBinding"("workspaceId", "documentId");

-- CreateIndex
CREATE INDEX "NodeChunkBinding_workspaceId_chunkId_idx" ON "NodeChunkBinding"("workspaceId", "chunkId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeChunkBinding_workspaceId_nodeKey_documentId_chunkId_evi_key" ON "NodeChunkBinding"("workspaceId", "nodeKey", "documentId", "chunkId", "evidenceType");

-- CreateIndex
CREATE INDEX "NodeLearningState_workspaceId_nodeKey_idx" ON "NodeLearningState"("workspaceId", "nodeKey");

-- CreateIndex
CREATE INDEX "NodeLearningState_workspaceId_userId_idx" ON "NodeLearningState"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeLearningState_workspaceId_userId_nodeKey_key" ON "NodeLearningState"("workspaceId", "userId", "nodeKey");

-- CreateIndex
CREATE UNIQUE INDEX "invites_code_key" ON "invites"("code");

-- CreateIndex
CREATE UNIQUE INDEX "invites_tokenHash_key" ON "invites"("tokenHash");

-- CreateIndex
CREATE INDEX "invites_tokenHash_idx" ON "invites"("tokenHash");

-- CreateIndex
CREATE INDEX "invites_role_idx" ON "invites"("role");

-- CreateIndex
CREATE INDEX "invites_expiresAt_idx" ON "invites"("expiresAt");

-- CreateIndex
CREATE INDEX "invites_consumedAt_idx" ON "invites"("consumedAt");

-- CreateIndex
CREATE INDEX "invites_revokedAt_idx" ON "invites"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_label_key" ON "system_settings"("label");

-- CreateIndex
CREATE INDEX "account_deletion_runs_targetUserId_status_idx" ON "account_deletion_runs"("targetUserId", "status");

-- CreateIndex
CREATE INDEX "account_deletion_runs_targetAuthUserId_status_idx" ON "account_deletion_runs"("targetAuthUserId", "status");

-- CreateIndex
CREATE INDEX "account_deletion_runs_createdAt_idx" ON "account_deletion_runs"("createdAt");

-- CreateIndex
CREATE INDEX "system_patrol_runs_startedAt_idx" ON "system_patrol_runs"("startedAt");

-- CreateIndex
CREATE INDEX "system_patrol_runs_status_idx" ON "system_patrol_runs"("status");

-- CreateIndex
CREATE INDEX "system_patrol_runs_summaryStatus_idx" ON "system_patrol_runs"("summaryStatus");

CREATE INDEX "system_patrol_runs_reportObjectId_idx" ON "system_patrol_runs"("reportObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "system_patrol_repairs_repairId_key" ON "system_patrol_repairs"("repairId");

-- CreateIndex
CREATE INDEX "system_patrol_repairs_runId_idx" ON "system_patrol_repairs"("runId");

-- CreateIndex
CREATE INDEX "system_patrol_repairs_repairId_idx" ON "system_patrol_repairs"("repairId");

-- CreateIndex
CREATE INDEX "system_patrol_repairs_status_idx" ON "system_patrol_repairs"("status");

-- CreateIndex
CREATE INDEX "system_patrol_repairs_action_idx" ON "system_patrol_repairs"("action");

-- CreateIndex
CREATE UNIQUE INDEX "users_authUserId_key" ON "users"("authUserId");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_originEnv_idx" ON "users"("originEnv");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_ownerType_idx" ON "users"("ownerType");

-- CreateIndex
CREATE INDEX "auth_sessions_authUserId_revokedAt_idx" ON "auth_sessions"("authUserId", "revokedAt");

-- CreateIndex
CREATE INDEX "auth_sessions_clientId_revokedAt_idx" ON "auth_sessions"("clientId", "revokedAt");

-- CreateIndex
CREATE INDEX "auth_sessions_idleExpiresAt_idx" ON "auth_sessions"("idleExpiresAt");

-- CreateIndex
CREATE INDEX "auth_sessions_absoluteExpiresAt_idx" ON "auth_sessions"("absoluteExpiresAt");

-- CreateIndex
CREATE INDEX "vault_items_userId_deletedAt_idx" ON "vault_items"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "vault_items_userId_itemType_idx" ON "vault_items"("userId", "itemType");

-- CreateIndex
CREATE INDEX "vault_items_updatedAt_idx" ON "vault_items"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "vault_items_userId_itemId_key" ON "vault_items"("userId", "itemId");

-- CreateIndex
CREATE INDEX "memory_candidates_userId_category_idx" ON "memory_candidates"("userId", "category");

-- CreateIndex
CREATE INDEX "memory_candidates_fingerprint_idx" ON "memory_candidates"("fingerprint");

-- CreateIndex
CREATE INDEX "user_memory_blocks_userId_category_idx" ON "user_memory_blocks"("userId", "category");

-- CreateIndex
CREATE INDEX "user_memory_blocks_userId_isSensitive_idx" ON "user_memory_blocks"("userId", "isSensitive");

-- CreateIndex
CREATE INDEX "user_memory_archives_userId_category_idx" ON "user_memory_archives"("userId", "category");

-- CreateIndex
CREATE INDEX "user_memory_archives_replacedBy_idx" ON "user_memory_archives"("replacedBy");

-- CreateIndex
CREATE INDEX "user_profile_overviews_userId_version_idx" ON "user_profile_overviews"("userId", "version");

-- CreateIndex
CREATE INDEX "AuthEnvironmentDeletion_authUserId_idx" ON "AuthEnvironmentDeletion"("authUserId");

-- CreateIndex
CREATE INDEX "AuthEnvironmentDeletion_env_idx" ON "AuthEnvironmentDeletion"("env");

-- CreateIndex
CREATE INDEX "AuthEnvironmentDeletion_deletedAt_idx" ON "AuthEnvironmentDeletion"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthEnvironmentDeletion_authUserId_env_key" ON "AuthEnvironmentDeletion"("authUserId", "env");

-- CreateIndex
CREATE INDEX "workspace_quiz_attempts_workspaceId_idx" ON "workspace_quiz_attempts"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_quiz_attempts_userId_idx" ON "workspace_quiz_attempts"("userId");

-- CreateIndex
CREATE INDEX "workspace_quiz_attempts_quizChatId_idx" ON "workspace_quiz_attempts"("quizChatId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_quiz_attempts_workspaceId_cacheUserKey_quizChatId_key" ON "workspace_quiz_attempts"("workspaceId", "cacheUserKey", "quizChatId");

-- CreateIndex
CREATE INDEX "workspace_quiz_question_results_attemptId_idx" ON "workspace_quiz_question_results"("attemptId");

-- CreateIndex
CREATE INDEX "workspace_quiz_question_results_questionId_idx" ON "workspace_quiz_question_results"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_quiz_question_results_attemptId_questionId_key" ON "workspace_quiz_question_results"("attemptId", "questionId");

-- CreateIndex
CREATE INDEX "workspace_quiz_wrong_questions_workspaceId_idx" ON "workspace_quiz_wrong_questions"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_quiz_wrong_questions_attemptId_idx" ON "workspace_quiz_wrong_questions"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_quiz_wrong_questions_workspaceId_cacheUserKey_que_key" ON "workspace_quiz_wrong_questions"("workspaceId", "cacheUserKey", "questionResultId");

-- CreateIndex
CREATE INDEX "workspace_quiz_favorite_questions_workspaceId_idx" ON "workspace_quiz_favorite_questions"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_quiz_favorite_questions_questionResultId_idx" ON "workspace_quiz_favorite_questions"("questionResultId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_quiz_favorite_questions_workspaceId_cacheUserKey__key" ON "workspace_quiz_favorite_questions"("workspaceId", "cacheUserKey", "quizId", "questionId");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_key" ON "password_reset_tokens"("token");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_codes_challenge_id_key" ON "email_verification_codes"("challenge_id");

-- CreateIndex
CREATE INDEX "email_verification_codes_user_id_idx" ON "email_verification_codes"("user_id");

-- CreateIndex
CREATE INDEX "email_verification_codes_user_id_purpose_idx" ON "email_verification_codes"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "email_verification_codes_email_purpose_idx" ON "email_verification_codes"("email", "purpose");

-- CreateIndex
CREATE INDEX "email_verification_codes_request_ip_createdAt_idx" ON "email_verification_codes"("request_ip", "createdAt");

-- CreateIndex
CREATE INDEX "email_verification_codes_client_id_purpose_idx" ON "email_verification_codes"("client_id", "purpose");

-- CreateIndex
CREATE INDEX "email_verification_codes_device_id_purpose_idx" ON "email_verification_codes"("device_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_grants_grant_id_key" ON "email_verification_grants"("grant_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_grants_grant_hash_key" ON "email_verification_grants"("grant_hash");

-- CreateIndex
CREATE INDEX "email_verification_grants_user_id_scope_idx" ON "email_verification_grants"("user_id", "scope");

-- CreateIndex
CREATE INDEX "email_verification_grants_challenge_id_idx" ON "email_verification_grants"("challenge_id");

-- CreateIndex
CREATE INDEX "email_verification_grants_client_id_scope_idx" ON "email_verification_grants"("client_id", "scope");

-- CreateIndex
CREATE INDEX "email_verification_grants_expiresAt_idx" ON "email_verification_grants"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_rate_limits_bucket_hash_key" ON "email_verification_rate_limits"("bucket_hash");

-- CreateIndex
CREATE INDEX "email_verification_rate_limits_bucket_type_purpose_idx" ON "email_verification_rate_limits"("bucket_type", "purpose");

-- CreateIndex
CREATE INDEX "email_verification_rate_limits_blockedUntil_idx" ON "email_verification_rate_limits"("blockedUntil");

-- CreateIndex
CREATE INDEX "email_verification_rate_limits_window_start_idx" ON "email_verification_rate_limits"("window_start");

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyCredential_credentialId_key" ON "PasskeyCredential"("credentialId");

-- CreateIndex
CREATE INDEX "PasskeyCredential_userId_idx" ON "PasskeyCredential"("userId");

-- CreateIndex
CREATE INDEX "PasskeyCredential_userId_createdAt_idx" ON "PasskeyCredential"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyChallenge_challenge_key" ON "PasskeyChallenge"("challenge");

-- CreateIndex
CREATE INDEX "PasskeyChallenge_type_userId_idx" ON "PasskeyChallenge"("type", "userId");

-- CreateIndex
CREATE INDEX "PasskeyChallenge_requestIp_createdAt_idx" ON "PasskeyChallenge"("requestIp", "createdAt");

-- CreateIndex
CREATE INDEX "PasskeyChallenge_expiresAt_idx" ON "PasskeyChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "TrustedLoginDevice_userId_idx" ON "TrustedLoginDevice"("userId");

-- CreateIndex
CREATE INDEX "TrustedLoginDevice_userId_revokedAt_idx" ON "TrustedLoginDevice"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedLoginDevice_userId_deviceId_key" ON "TrustedLoginDevice"("userId", "deviceId");

-- CreateIndex
CREATE INDEX "athena_clients_clientId_idx" ON "athena_clients"("clientId");

-- CreateIndex
CREATE INDEX "athena_clients_userId_revokedAt_idx" ON "athena_clients"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "athena_clients_userId_clientId_key" ON "athena_clients"("userId", "clientId");

-- CreateIndex
CREATE INDEX "athena_request_nonces_expiresAt_idx" ON "athena_request_nonces"("expiresAt");

-- CreateIndex
CREATE INDEX "athena_request_nonces_clientId_createdAt_idx" ON "athena_request_nonces"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "athena_request_nonces_clientId_nonce_key" ON "athena_request_nonces"("clientId", "nonce");

-- CreateIndex
CREATE INDEX "user_state_preferences_userId_namespace_idx" ON "user_state_preferences"("userId", "namespace");

-- CreateIndex
CREATE INDEX "user_state_preferences_updatedAt_idx" ON "user_state_preferences"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_state_preferences_userId_namespace_scope_key" ON "user_state_preferences"("userId", "namespace", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "reader_book_catalog_catalogKey_key" ON "reader_book_catalog"("catalogKey");

-- CreateIndex
CREATE INDEX "reader_book_catalog_readerDocumentId_idx" ON "reader_book_catalog"("readerDocumentId");

-- CreateIndex
CREATE INDEX "reader_book_catalog_workspaceSlug_idx" ON "reader_book_catalog"("workspaceSlug");

-- CreateIndex
CREATE INDEX "reader_book_catalog_availability_idx" ON "reader_book_catalog"("availability");

-- CreateIndex
CREATE UNIQUE INDEX "reader_library_items_itemId_key" ON "reader_library_items"("itemId");

-- CreateIndex
CREATE INDEX "reader_library_items_userId_idx" ON "reader_library_items"("userId");

-- CreateIndex
CREATE INDEX "reader_library_items_userId_deletedAt_tombstone_idx" ON "reader_library_items"("userId", "deletedAt", "tombstone");

-- CreateIndex
CREATE INDEX "reader_library_items_catalogKey_idx" ON "reader_library_items"("catalogKey");

-- CreateIndex
CREATE UNIQUE INDEX "reader_library_items_userId_catalogKey_key" ON "reader_library_items"("userId", "catalogKey");

-- CreateIndex
CREATE UNIQUE INDEX "reader_library_items_userId_itemKey_key" ON "reader_library_items"("userId", "itemKey");

-- CreateIndex
CREATE INDEX "reader_library_categories_userId_idx" ON "reader_library_categories"("userId");

-- CreateIndex
CREATE INDEX "reader_library_categories_userId_deletedAt_idx" ON "reader_library_categories"("userId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "reader_library_categories_userId_categoryId_key" ON "reader_library_categories"("userId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "reader_worker_jobs_jobId_key" ON "reader_worker_jobs"("jobId");

-- CreateIndex
CREATE INDEX "reader_worker_jobs_status_runAfter_idx" ON "reader_worker_jobs"("status", "runAfter");

-- CreateIndex
CREATE INDEX "reader_worker_jobs_readerDocumentId_idx" ON "reader_worker_jobs"("readerDocumentId");

-- CreateIndex
CREATE INDEX "reader_worker_jobs_workspaceSlug_idx" ON "reader_worker_jobs"("workspaceSlug");

-- CreateIndex
CREATE INDEX "reader_worker_jobs_priority_idx" ON "reader_worker_jobs"("priority");

-- CreateIndex
CREATE INDEX "reader_worker_jobs_lockedAt_idx" ON "reader_worker_jobs"("lockedAt");

-- CreateIndex
CREATE INDEX "ZkLoginAttempt_userId_deviceId_idx" ON "ZkLoginAttempt"("userId", "deviceId");

-- CreateIndex
CREATE INDEX "ZkLoginAttempt_expiresAt_idx" ON "ZkLoginAttempt"("expiresAt");

-- CreateIndex
CREATE INDEX "DocumentIndexStatus_workspaceId_idx" ON "DocumentIndexStatus"("workspaceId");

-- CreateIndex
CREATE INDEX "DocumentIndexStatus_docId_idx" ON "DocumentIndexStatus"("docId");

-- CreateIndex
CREATE INDEX "DocumentIndexStatus_filePath_idx" ON "DocumentIndexStatus"("filePath");

-- CreateIndex
CREATE INDEX "DocumentIndexStatus_fileHash_idx" ON "DocumentIndexStatus"("fileHash");

-- CreateIndex
CREATE INDEX "DocumentIndexStatus_indexStatus_idx" ON "DocumentIndexStatus"("indexStatus");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIndexStatus_workspaceId_filePath_key" ON "DocumentIndexStatus"("workspaceId", "filePath");

-- CreateIndex
CREATE INDEX "KnowledgeNode_workspaceId_entityType_idx" ON "KnowledgeNode"("workspaceId", "entityType");

-- CreateIndex
CREATE INDEX "KnowledgeNode_workspaceId_canonicalKey_idx" ON "KnowledgeNode"("workspaceId", "canonicalKey");

-- CreateIndex
CREATE INDEX "KnowledgeNode_workspaceId_globalImportanceScore_idx" ON "KnowledgeNode"("workspaceId", "globalImportanceScore");

-- CreateIndex
CREATE INDEX "KnowledgeNode_workspaceId_workspaceImportanceScore_idx" ON "KnowledgeNode"("workspaceId", "workspaceImportanceScore");

-- CreateIndex
CREATE INDEX "KnowledgeNode_workspaceId_recentImportanceScore_idx" ON "KnowledgeNode"("workspaceId", "recentImportanceScore");

-- CreateIndex
CREATE INDEX "KnowledgeNode_workspaceId_lastReferencedAt_idx" ON "KnowledgeNode"("workspaceId", "lastReferencedAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeNode_workspaceId_canonicalKey_key" ON "KnowledgeNode"("workspaceId", "canonicalKey");

-- CreateIndex
CREATE INDEX "KnowledgeEdge_workspaceId_sourceNodeId_idx" ON "KnowledgeEdge"("workspaceId", "sourceNodeId");

-- CreateIndex
CREATE INDEX "KnowledgeEdge_workspaceId_targetNodeId_idx" ON "KnowledgeEdge"("workspaceId", "targetNodeId");

-- CreateIndex
CREATE INDEX "KnowledgeEdge_workspaceId_relationType_idx" ON "KnowledgeEdge"("workspaceId", "relationType");

-- CreateIndex
CREATE INDEX "KnowledgeEdge_workspaceId_confidence_idx" ON "KnowledgeEdge"("workspaceId", "confidence");

-- CreateIndex
CREATE INDEX "KnowledgeEdge_workspaceId_weight_idx" ON "KnowledgeEdge"("workspaceId", "weight");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeEdge_workspaceId_sourceNodeId_targetNodeId_relatio_key" ON "KnowledgeEdge"("workspaceId", "sourceNodeId", "targetNodeId", "relationType");

-- CreateIndex
CREATE INDEX "EdgeEvidence_workspaceId_edgeId_idx" ON "EdgeEvidence"("workspaceId", "edgeId");

-- CreateIndex
CREATE INDEX "EdgeEvidence_workspaceId_documentId_idx" ON "EdgeEvidence"("workspaceId", "documentId");

-- CreateIndex
CREATE INDEX "EdgeEvidence_workspaceId_chunkId_idx" ON "EdgeEvidence"("workspaceId", "chunkId");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeEvidence_edgeId_chunkId_key" ON "EdgeEvidence"("edgeId", "chunkId");

-- CreateIndex
CREATE INDEX "ConceptChunkMap_workspaceId_nodeId_idx" ON "ConceptChunkMap"("workspaceId", "nodeId");

-- CreateIndex
CREATE INDEX "ConceptChunkMap_workspaceId_chunkId_idx" ON "ConceptChunkMap"("workspaceId", "chunkId");

-- CreateIndex
CREATE INDEX "ConceptChunkMap_workspaceId_documentId_idx" ON "ConceptChunkMap"("workspaceId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "ConceptChunkMap_workspaceId_nodeId_chunkId_key" ON "ConceptChunkMap"("workspaceId", "nodeId", "chunkId");

-- CreateIndex
CREATE INDEX "GraphExtractionJob_status_idx" ON "GraphExtractionJob"("status");

-- CreateIndex
CREATE INDEX "GraphExtractionJob_workspaceId_chunkId_idx" ON "GraphExtractionJob"("workspaceId", "chunkId");

-- CreateIndex
CREATE INDEX "GraphExtractionJob_workspaceId_documentId_idx" ON "GraphExtractionJob"("workspaceId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphExtractionJob_workspaceId_chunkId_key" ON "GraphExtractionJob"("workspaceId", "chunkId");

-- CreateIndex
CREATE INDEX "GraphRetrievalCache_workspaceId_conceptKey_idx" ON "GraphRetrievalCache"("workspaceId", "conceptKey");

-- CreateIndex
CREATE INDEX "GraphRetrievalCache_workspaceId_expiresAt_idx" ON "GraphRetrievalCache"("workspaceId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GraphRetrievalCache_workspaceId_conceptKey_paramsHash_key" ON "GraphRetrievalCache"("workspaceId", "conceptKey", "paramsHash");

-- CreateIndex
CREATE UNIQUE INDEX "GraphLabelTranslationCache_workspaceId_cacheKey_key" ON "GraphLabelTranslationCache"("workspaceId", "cacheKey");

-- CreateIndex
CREATE INDEX "KnowledgeGraphRepairIssue_workspaceId_status_idx" ON "KnowledgeGraphRepairIssue"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeGraphRepairIssue_workspaceId_priorityScore_idx" ON "KnowledgeGraphRepairIssue"("workspaceId", "priorityScore");

-- CreateIndex
CREATE INDEX "KnowledgeGraphRepairIssue_workspaceId_nextRetryAt_idx" ON "KnowledgeGraphRepairIssue"("workspaceId", "nextRetryAt");

-- CreateIndex
CREATE INDEX "KnowledgeGraphRepairIssue_workspaceId_cooldownUntil_idx" ON "KnowledgeGraphRepairIssue"("workspaceId", "cooldownUntil");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeGraphRepairIssue_workspaceId_issueType_documentId__key" ON "KnowledgeGraphRepairIssue"("workspaceId", "issueType", "documentId", "chunkId");

-- CreateIndex
CREATE INDEX "KnowledgeGraphRepairRun_workspaceId_createdAt_idx" ON "KnowledgeGraphRepairRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeGraphRepairRun_workspaceId_trigger_idx" ON "KnowledgeGraphRepairRun"("workspaceId", "trigger");

-- CreateIndex
CREATE INDEX "KnowledgeGraphEvidenceUsage_workspaceId_targetType_targetId_idx" ON "KnowledgeGraphEvidenceUsage"("workspaceId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "KnowledgeGraphEvidenceUsage_workspaceId_action_idx" ON "KnowledgeGraphEvidenceUsage"("workspaceId", "action");

-- CreateIndex
CREATE INDEX "KnowledgeGraphEvidenceUsage_workspaceId_lastUsedAt_idx" ON "KnowledgeGraphEvidenceUsage"("workspaceId", "lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeGraphEvidenceUsage_workspaceId_targetType_targetId_key" ON "KnowledgeGraphEvidenceUsage"("workspaceId", "targetType", "targetId", "action");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetrics_workspaceId_idx" ON "KnowledgeNodeMetrics"("workspaceId");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetrics_nodeId_idx" ON "KnowledgeNodeMetrics"("nodeId");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetrics_formulaVersion_idx" ON "KnowledgeNodeMetrics"("formulaVersion");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetrics_stale_idx" ON "KnowledgeNodeMetrics"("stale");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetrics_lockedAt_idx" ON "KnowledgeNodeMetrics"("lockedAt");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetrics_updatedAt_idx" ON "KnowledgeNodeMetrics"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeNodeMetrics_workspaceId_nodeId_key" ON "KnowledgeNodeMetrics"("workspaceId", "nodeId");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetricsSnapshot_workspaceId_nodeId_idx" ON "KnowledgeNodeMetricsSnapshot"("workspaceId", "nodeId");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetricsSnapshot_formulaVersion_idx" ON "KnowledgeNodeMetricsSnapshot"("formulaVersion");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetricsSnapshot_snapshotPeriod_idx" ON "KnowledgeNodeMetricsSnapshot"("snapshotPeriod");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetricsSnapshot_createdAt_idx" ON "KnowledgeNodeMetricsSnapshot"("createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetricsRecomputeRun_workspaceId_idx" ON "KnowledgeNodeMetricsRecomputeRun"("workspaceId");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetricsRecomputeRun_trigger_idx" ON "KnowledgeNodeMetricsRecomputeRun"("trigger");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetricsRecomputeRun_formulaVersion_idx" ON "KnowledgeNodeMetricsRecomputeRun"("formulaVersion");

-- CreateIndex
CREATE INDEX "KnowledgeNodeMetricsRecomputeRun_createdAt_idx" ON "KnowledgeNodeMetricsRecomputeRun"("createdAt");

-- CreateIndex
CREATE INDEX "WorkspaceOverviewRecommendationUsage_workspaceId_idx" ON "WorkspaceOverviewRecommendationUsage"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceOverviewRecommendationUsage_userId_idx" ON "WorkspaceOverviewRecommendationUsage"("userId");

-- CreateIndex
CREATE INDEX "WorkspaceOverviewRecommendationUsage_recommendationId_idx" ON "WorkspaceOverviewRecommendationUsage"("recommendationId");

-- CreateIndex
CREATE INDEX "WorkspaceOverviewRecommendationUsage_workspaceId_cooldownUn_idx" ON "WorkspaceOverviewRecommendationUsage"("workspaceId", "cooldownUntil");

-- CreateIndex
CREATE INDEX "WorkspaceOverviewRecommendationUsage_workspaceId_type_idx" ON "WorkspaceOverviewRecommendationUsage"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "WorkspaceOverviewRecommendationUsage_workspaceId_targetType_idx" ON "WorkspaceOverviewRecommendationUsage"("workspaceId", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceOverviewRecommendationUsage_workspaceId_userId_rec_key" ON "WorkspaceOverviewRecommendationUsage"("workspaceId", "userId", "recommendationId");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_sourceActionId_key" ON "workspaces"("sourceActionId");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_threads_sourceActionId_key" ON "workspace_threads"("sourceActionId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_threads_slug_key" ON "workspace_threads"("slug");

-- CreateIndex
CREATE INDEX "workspace_threads_workspace_id_idx" ON "workspace_threads"("workspace_id");

-- CreateIndex
CREATE INDEX "workspace_threads_user_id_idx" ON "workspace_threads"("user_id");

-- CreateIndex
CREATE INDEX "workspace_threads_workspace_id_archivedAt_idx" ON "workspace_threads"("workspace_id", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "athena_sync_events_eventId_key" ON "athena_sync_events"("eventId");

-- CreateIndex
CREATE INDEX "athena_sync_events_userId_id_idx" ON "athena_sync_events"("userId", "id");

-- CreateIndex
CREATE INDEX "athena_sync_events_targetClientId_id_idx" ON "athena_sync_events"("targetClientId", "id");

-- CreateIndex
CREATE INDEX "athena_sync_events_expiresAt_idx" ON "athena_sync_events"("expiresAt");

-- CreateIndex
CREATE INDEX "athena_ios_push_tokens_userId_revokedAt_idx" ON "athena_ios_push_tokens"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "athena_ios_push_tokens_tokenFingerprint_idx" ON "athena_ios_push_tokens"("tokenFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "athena_ios_push_tokens_userId_clientId_environment_bundleId_key" ON "athena_ios_push_tokens"("userId", "clientId", "environment", "bundleId");

-- CreateIndex
CREATE INDEX "athena_mutation_receipts_userId_status_idx" ON "athena_mutation_receipts"("userId", "status");

-- CreateIndex
CREATE INDEX "athena_mutation_receipts_workspaceId_idx" ON "athena_mutation_receipts"("workspaceId");

-- CreateIndex
CREATE INDEX "athena_mutation_receipts_threadId_idx" ON "athena_mutation_receipts"("threadId");

-- CreateIndex
CREATE INDEX "athena_mutation_receipts_status_leaseExpiresAt_idx" ON "athena_mutation_receipts"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "athena_mutation_receipts_nodeKey_status_idx" ON "athena_mutation_receipts"("nodeKey", "status");

-- CreateIndex
CREATE INDEX "athena_mutation_receipts_mutationId_idx" ON "athena_mutation_receipts"("mutationId");

-- CreateIndex
CREATE UNIQUE INDEX "athena_mutation_receipts_userId_sourceActionId_key" ON "athena_mutation_receipts"("userId", "sourceActionId");

-- CreateIndex
CREATE UNIQUE INDEX "sync_nodes_nodeKey_key" ON "sync_nodes"("nodeKey");

-- CreateIndex
CREATE INDEX "sync_nodes_ownerType_ownerId_idx" ON "sync_nodes"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "sync_nodes_parentKey_idx" ON "sync_nodes"("parentKey");

-- CreateIndex
CREATE INDEX "sync_nodes_updatedAt_idx" ON "sync_nodes"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sync_outbox_eventId_key" ON "sync_outbox"("eventId");

-- CreateIndex
CREATE INDEX "sync_outbox_nodeKey_stateVersion_idx" ON "sync_outbox"("nodeKey", "stateVersion");

-- CreateIndex
CREATE INDEX "sync_outbox_ownerType_ownerId_seq_idx" ON "sync_outbox"("ownerType", "ownerId", "seq");

-- CreateIndex
CREATE INDEX "sync_outbox_expiresAt_idx" ON "sync_outbox"("expiresAt");

-- CreateIndex
CREATE INDEX "sync_outbox_dispatchedAt_seq_idx" ON "sync_outbox"("dispatchedAt", "seq");

-- CreateIndex
CREATE INDEX "sync_outbox_status_nextAttemptAt_seq_idx" ON "sync_outbox"("status", "nextAttemptAt", "seq");

-- CreateIndex
CREATE INDEX "sync_outbox_leaseOwner_leaseExpiresAt_idx" ON "sync_outbox"("leaseOwner", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "sync_outbox_deadLetteredAt_seq_idx" ON "sync_outbox"("deadLetteredAt", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "sync_outbox_nodeKey_mutationId_key" ON "sync_outbox"("nodeKey", "mutationId");

-- CreateIndex
CREATE UNIQUE INDEX "security_audit_ledger_eventId_key" ON "security_audit_ledger"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "security_audit_ledger_entryHash_key" ON "security_audit_ledger"("entryHash");

-- CreateIndex
CREATE INDEX "security_audit_ledger_chainId_createdAt_idx" ON "security_audit_ledger"("chainId", "createdAt");

-- CreateIndex
CREATE INDEX "security_audit_ledger_userId_createdAt_idx" ON "security_audit_ledger"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "security_audit_ledger_chainId_sequence_key" ON "security_audit_ledger"("chainId", "sequence");

-- CreateIndex
CREATE INDEX "security_audit_checkpoints_keyId_createdAt_idx" ON "security_audit_checkpoints"("keyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "security_audit_checkpoints_chainId_throughSequence_key" ON "security_audit_checkpoints"("chainId", "throughSequence");

-- CreateIndex
CREATE INDEX "sync_client_cursors_userId_lastAppliedSeq_idx" ON "sync_client_cursors"("userId", "lastAppliedSeq");

-- CreateIndex
CREATE INDEX "sync_client_cursors_lastSeenAt_idx" ON "sync_client_cursors"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "sync_client_cursors_userId_clientId_key" ON "sync_client_cursors"("userId", "clientId");

-- CreateIndex
CREATE INDEX "workspace_suggested_messages_workspaceId_idx" ON "workspace_suggested_messages"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_chats_public_id_key" ON "workspace_chats"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_chats_clientTurnId_key" ON "workspace_chats"("clientTurnId");

-- CreateIndex
CREATE INDEX "workspace_chats_thread_history_idx" ON "workspace_chats"("workspaceId", "user_id", "thread_id", "api_session_id", "include", "id");

-- CreateIndex
CREATE INDEX "workspace_chats_scope_tail_idx" ON "workspace_chats"("workspaceId", "user_id", "thread_id", "api_session_id", "id");

-- CreateIndex
CREATE INDEX "workspace_chats_thread_activity_idx" ON "workspace_chats"("workspaceId", "user_id", "api_session_id", "include", "thread_id", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "content_objects_objectKey_key" ON "content_objects"("objectKey");

-- CreateIndex
CREATE INDEX "content_objects_state_createdAt_idx" ON "content_objects"("state", "createdAt");

-- CreateIndex
CREATE INDEX "content_objects_state_deleteAfter_idx" ON "content_objects"("state", "deleteAfter");

-- CreateIndex
CREATE INDEX "content_objects_ownerType_ownerId_domain_idx" ON "content_objects"("ownerType", "ownerId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "content_objects_ownerType_ownerId_domain_dedupeKey_key" ON "content_objects"("ownerType", "ownerId", "domain", "dedupeKey");

-- CreateIndex
CREATE INDEX "workspace_chat_attachment_refs_contentObjectId_idx" ON "workspace_chat_attachment_refs"("contentObjectId");

-- CreateIndex
CREATE INDEX "workspace_chat_attachment_refs_chatId_idx" ON "workspace_chat_attachment_refs"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_chat_attachment_refs_chatId_ordinal_key" ON "workspace_chat_attachment_refs"("chatId", "ordinal");

-- CreateIndex
CREATE INDEX "workspace_chat_content_refs_contentObjectId_idx" ON "workspace_chat_content_refs"("contentObjectId");

-- CreateIndex
CREATE INDEX "workspace_chat_content_refs_chatId_idx" ON "workspace_chat_content_refs"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_chat_content_refs_chatId_jsonPath_key" ON "workspace_chat_content_refs"("chatId", "jsonPath");

-- CreateIndex
CREATE INDEX "chat_attachment_uploads_workspaceId_userId_status_idx" ON "chat_attachment_uploads"("workspaceId", "userId", "status");

-- CreateIndex
CREATE INDEX "chat_attachment_uploads_status_expiresAt_idx" ON "chat_attachment_uploads"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "chat_attachment_uploads_contentObjectId_idx" ON "chat_attachment_uploads"("contentObjectId");

-- CreateIndex
CREATE INDEX "chat_attachment_upload_parts_uploadId_idx" ON "chat_attachment_upload_parts"("uploadId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_chat_conversation_keys_key_id_key" ON "workspace_chat_conversation_keys"("key_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_chat_conversation_keys_scope_hash_key" ON "workspace_chat_conversation_keys"("scope_hash");

-- CreateIndex
CREATE INDEX "workspace_chat_conversation_keys_workspace_id_user_id_threa_idx" ON "workspace_chat_conversation_keys"("workspace_id", "user_id", "thread_id", "api_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_chat_crypto_metadata_chat_id_key" ON "workspace_chat_crypto_metadata"("chat_id");

-- CreateIndex
CREATE INDEX "workspace_chat_crypto_metadata_scope_hash_chat_id_idx" ON "workspace_chat_crypto_metadata"("scope_hash", "chat_id");

-- CreateIndex
CREATE INDEX "workspace_chat_crypto_metadata_key_id_idx" ON "workspace_chat_crypto_metadata"("key_id");

-- CreateIndex
CREATE INDEX "workspace_chat_compactions_workspace_id_user_id_thread_id_a_idx" ON "workspace_chat_compactions"("workspace_id", "user_id", "thread_id", "api_session_id", "created_at");

-- CreateIndex
CREATE INDEX "workspace_chat_compactions_workspace_id_thread_id_api_sessi_idx" ON "workspace_chat_compactions"("workspace_id", "thread_id", "api_session_id", "covered_to_chat_id");

-- CreateIndex
CREATE INDEX "workspace_cognitive_assertions_workspaceId_assertionType_ve_idx" ON "workspace_cognitive_assertions"("workspaceId", "assertionType", "verificationStatus");

-- CreateIndex
CREATE INDEX "workspace_cognitive_assertions_workspaceId_updatedAt_idx" ON "workspace_cognitive_assertions"("workspaceId", "updatedAt");

-- CreateIndex
CREATE INDEX "workspace_cognitive_assertions_workspaceId_canonicalItemId_idx" ON "workspace_cognitive_assertions"("workspaceId", "canonicalItemId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_assertions_workspaceId_normalizedHash_key" ON "workspace_cognitive_assertions"("workspaceId", "normalizedHash");

-- CreateIndex
CREATE INDEX "workspace_cognitive_positions_workspaceId_assertionId_idx" ON "workspace_cognitive_positions"("workspaceId", "assertionId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_positions_workspaceId_subjectUserId_sta_idx" ON "workspace_cognitive_positions"("workspaceId", "subjectUserId", "status");

-- CreateIndex
CREATE INDEX "workspace_cognitive_positions_workspaceId_canonicalPosition_idx" ON "workspace_cognitive_positions"("workspaceId", "canonicalPositionVersionId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_evidence_workspaceId_assertionId_freshn_idx" ON "workspace_cognitive_evidence"("workspaceId", "assertionId", "freshness");

-- CreateIndex
CREATE INDEX "workspace_cognitive_evidence_workspaceId_documentId_chunkId_idx" ON "workspace_cognitive_evidence"("workspaceId", "documentId", "chunkId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_evidence_workspaceId_chatId_idx" ON "workspace_cognitive_evidence"("workspaceId", "chatId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_evidence_workspaceId_canonicalEvidenceI_idx" ON "workspace_cognitive_evidence"("workspaceId", "canonicalEvidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_evidence_workspaceId_assertionId_source_key" ON "workspace_cognitive_evidence"("workspaceId", "assertionId", "sourceType", "sourceRef", "evidenceKind");

-- CreateIndex
CREATE INDEX "workspace_cognitive_relations_workspaceId_relationType_idx" ON "workspace_cognitive_relations"("workspaceId", "relationType");

-- CreateIndex
CREATE INDEX "workspace_cognitive_relations_workspaceId_canonicalRelation_idx" ON "workspace_cognitive_relations"("workspaceId", "canonicalRelationId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_relations_workspaceId_fromAssertionId_t_key" ON "workspace_cognitive_relations"("workspaceId", "fromAssertionId", "toAssertionId", "relationType");

-- CreateIndex
CREATE INDEX "workspace_cognitive_profiles_workspaceId_generatedAt_idx" ON "workspace_cognitive_profiles"("workspaceId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_profiles_workspaceId_revision_key" ON "workspace_cognitive_profiles"("workspaceId", "revision");

-- CreateIndex
CREATE INDEX "workspace_cognitive_extraction_jobs_workspaceId_threadId_st_idx" ON "workspace_cognitive_extraction_jobs"("workspaceId", "threadId", "status");

-- CreateIndex
CREATE INDEX "workspace_cognitive_extraction_jobs_workspaceId_lastScanned_idx" ON "workspace_cognitive_extraction_jobs"("workspaceId", "lastScannedChatId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_extraction_jobs_status_nextRetryAt_leas_idx" ON "workspace_cognitive_extraction_jobs"("status", "nextRetryAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "workspace_cognitive_extraction_jobs_workspaceId_scopeKey_st_idx" ON "workspace_cognitive_extraction_jobs"("workspaceId", "scopeKey", "status");

-- CreateIndex
CREATE INDEX "workspace_cognitive_extraction_jobs_status_priority_nextRet_idx" ON "workspace_cognitive_extraction_jobs"("status", "priority", "nextRetryAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "workspace_cognitive_extraction_jobs_workspaceId_pipelineVer_idx" ON "workspace_cognitive_extraction_jobs"("workspaceId", "pipelineVersion", "jobType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_extraction_jobs_idempotencyKey_key" ON "workspace_cognitive_extraction_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "workspace_cognitive_turn_buffer_workspaceId_scopeKey_status_idx" ON "workspace_cognitive_turn_buffer"("workspaceId", "scopeKey", "status", "chatId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_turn_buffer_jobId_status_idx" ON "workspace_cognitive_turn_buffer"("jobId", "status");

-- CreateIndex
CREATE INDEX "workspace_cognitive_turn_buffer_roughResultId_status_idx" ON "workspace_cognitive_turn_buffer"("roughResultId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_turn_buffer_workspaceId_chatId_contentH_key" ON "workspace_cognitive_turn_buffer"("workspaceId", "chatId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_rough_results_roughJobId_key" ON "workspace_cognitive_rough_results"("roughJobId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_rough_results_workspaceId_status_readyA_idx" ON "workspace_cognitive_rough_results"("workspaceId", "status", "readyAt", "id");

-- CreateIndex
CREATE INDEX "workspace_cognitive_rough_results_refineJobId_status_idx" ON "workspace_cognitive_rough_results"("refineJobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_refine_inputs_roughResultId_key" ON "workspace_cognitive_refine_inputs"("roughResultId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_refine_inputs_workspaceId_refineJobId_idx" ON "workspace_cognitive_refine_inputs"("workspaceId", "refineJobId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_refine_inputs_refineJobId_ordinal_key" ON "workspace_cognitive_refine_inputs"("refineJobId", "ordinal");

-- CreateIndex
CREATE INDEX "workspace_cognitive_extraction_attempts_workspaceId_created_idx" ON "workspace_cognitive_extraction_attempts"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_cognitive_extraction_attempts_jobId_stage_idx" ON "workspace_cognitive_extraction_attempts"("jobId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_extraction_attempts_jobId_stage_attempt_key" ON "workspace_cognitive_extraction_attempts"("jobId", "stage", "attemptNo");

-- CreateIndex
CREATE INDEX "workspace_cognitive_thread_state_workspaceId_lastActivityAt_idx" ON "workspace_cognitive_thread_state"("workspaceId", "lastActivityAt", "pendingTurnCount");

-- CreateIndex
CREATE INDEX "workspace_cognitive_thread_state_activeJobId_idx" ON "workspace_cognitive_thread_state"("activeJobId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_thread_state_workspaceId_scopeKey_key" ON "workspace_cognitive_thread_state"("workspaceId", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_candidates_candidateKey_key" ON "workspace_cognitive_candidates"("candidateKey");

-- CreateIndex
CREATE INDEX "workspace_cognitive_candidates_workspaceId_extractionJobId__idx" ON "workspace_cognitive_candidates"("workspaceId", "extractionJobId", "normalizedHash");

-- CreateIndex
CREATE INDEX "workspace_cognitive_candidates_workspaceId_createdAt_idx" ON "workspace_cognitive_candidates"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_cognitive_candidates_workspaceId_subjectUserId_idx" ON "workspace_cognitive_candidates"("workspaceId", "subjectUserId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_candidates_workspaceId_legacyPipeline_c_idx" ON "workspace_cognitive_candidates"("workspaceId", "legacyPipeline", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_cognitive_candidate_events_workspaceId_candidateI_idx" ON "workspace_cognitive_candidate_events"("workspaceId", "candidateId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_candidate_events_workspaceId_idempotenc_key" ON "workspace_cognitive_candidate_events"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "workspace_cognitive_items_workspaceId_assertionType_created_idx" ON "workspace_cognitive_items"("workspaceId", "assertionType", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_cognitive_items_workspaceId_normalizedHash_idx" ON "workspace_cognitive_items"("workspaceId", "normalizedHash");

-- CreateIndex
CREATE INDEX "workspace_cognitive_items_workspaceId_candidateId_idx" ON "workspace_cognitive_items"("workspaceId", "candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_items_workspaceId_itemKey_version_key" ON "workspace_cognitive_items"("workspaceId", "itemKey", "version");

-- CreateIndex
CREATE INDEX "workspace_cognitive_position_versions_workspaceId_cognitive_idx" ON "workspace_cognitive_position_versions"("workspaceId", "cognitiveItemId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_position_versions_workspaceId_subjectUs_idx" ON "workspace_cognitive_position_versions"("workspaceId", "subjectUserId", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_cognitive_item_relations_workspaceId_relationType_idx" ON "workspace_cognitive_item_relations"("workspaceId", "relationType");

-- CreateIndex
CREATE INDEX "workspace_cognitive_item_relations_workspaceId_toItemId_idx" ON "workspace_cognitive_item_relations"("workspaceId", "toItemId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_item_relations_workspaceId_fromItemId_t_key" ON "workspace_cognitive_item_relations"("workspaceId", "fromItemId", "toItemId", "relationType");

-- CreateIndex
CREATE INDEX "workspace_cognitive_item_evidence_workspaceId_cognitiveItem_idx" ON "workspace_cognitive_item_evidence"("workspaceId", "cognitiveItemId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_item_evidence_workspaceId_documentId_ch_idx" ON "workspace_cognitive_item_evidence"("workspaceId", "documentId", "chunkId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_item_evidence_workspaceId_chatId_idx" ON "workspace_cognitive_item_evidence"("workspaceId", "chatId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_evidence_events_workspaceId_evidenceId__idx" ON "workspace_cognitive_evidence_events"("workspaceId", "evidenceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_evidence_events_workspaceId_idempotency_key" ON "workspace_cognitive_evidence_events"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "workspace_cognitive_profile_invalidations_workspaceId_creat_idx" ON "workspace_cognitive_profile_invalidations"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_profile_invalidations_workspaceId_gener_key" ON "workspace_cognitive_profile_invalidations"("workspaceId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_profile_state_workspaceId_key" ON "workspace_cognitive_profile_state"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_cognitive_profile_items_workspaceId_profileRevisi_idx" ON "workspace_cognitive_profile_items"("workspaceId", "profileRevision");

-- CreateIndex
CREATE INDEX "workspace_cognitive_profile_items_workspaceId_itemKey_itemV_idx" ON "workspace_cognitive_profile_items"("workspaceId", "itemKey", "itemVersion");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_cognitive_profile_items_workspaceId_profileRevisi_key" ON "workspace_cognitive_profile_items"("workspaceId", "profileRevision", "cognitiveItemId", "membershipType");

-- CreateIndex
CREATE INDEX "workspace_meeting_packets_workspaceId_status_updatedAt_idx" ON "workspace_meeting_packets"("workspaceId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_meeting_packets_workspaceId_packetKey_revision_key" ON "workspace_meeting_packets"("workspaceId", "packetKey", "revision");

-- CreateIndex
CREATE INDEX "workspace_meeting_authorizations_workspaceId_meetingPacketI_idx" ON "workspace_meeting_authorizations"("workspaceId", "meetingPacketId", "actionType");

-- CreateIndex
CREATE INDEX "workspace_meeting_sessions_workspaceId_meetingPacketId_stat_idx" ON "workspace_meeting_sessions"("workspaceId", "meetingPacketId", "status");

-- CreateIndex
CREATE INDEX "workspace_meeting_sessions_workspaceId_threadId_idx" ON "workspace_meeting_sessions"("workspaceId", "threadId");

-- CreateIndex
CREATE INDEX "workspace_meeting_audit_events_workspaceId_meetingSessionId_idx" ON "workspace_meeting_audit_events"("workspaceId", "meetingSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_meeting_audit_events_workspaceId_eventType_idx" ON "workspace_meeting_audit_events"("workspaceId", "eventType");

-- CreateIndex
CREATE INDEX "workspace_mind_maps_workspaceId_idx" ON "workspace_mind_maps"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_mind_maps_user_id_idx" ON "workspace_mind_maps"("user_id");

-- CreateIndex
CREATE INDEX "workspace_mind_maps_thread_id_idx" ON "workspace_mind_maps"("thread_id");

-- CreateIndex
CREATE INDEX "workspace_mind_maps_sourceHash_idx" ON "workspace_mind_maps"("sourceHash");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_mind_maps_workspaceId_cacheUserKey_sourceHash_key" ON "workspace_mind_maps"("workspaceId", "cacheUserKey", "sourceHash");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_agent_invocations_uuid_key" ON "workspace_agent_invocations"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_agent_invocations_clientTurnId_key" ON "workspace_agent_invocations"("clientTurnId");

-- CreateIndex
CREATE INDEX "workspace_agent_invocations_uuid_idx" ON "workspace_agent_invocations"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "embed_configs_uuid_key" ON "embed_configs"("uuid");

-- CreateIndex
CREATE INDEX "event_logs_event_idx" ON "event_logs"("event");

-- CreateIndex
CREATE UNIQUE INDEX "embedding_batch_jobs_jobId_key" ON "embedding_batch_jobs"("jobId");

-- CreateIndex
CREATE INDEX "embedding_batch_jobs_status_idx" ON "embedding_batch_jobs"("status");

-- CreateIndex
CREATE INDEX "embedding_batch_jobs_workspaceId_idx" ON "embedding_batch_jobs"("workspaceId");

-- CreateIndex
CREATE INDEX "embedding_batch_jobs_jobId_idx" ON "embedding_batch_jobs"("jobId");

-- CreateIndex
CREATE INDEX "embedding_batch_job_events_jobId_idx" ON "embedding_batch_job_events"("jobId");

-- CreateIndex
CREATE INDEX "embedding_batch_job_events_event_idx" ON "embedding_batch_job_events"("event");

-- CreateIndex
CREATE UNIQUE INDEX "slash_command_presets_uid_command_key" ON "slash_command_presets"("uid", "command");

-- CreateIndex
CREATE UNIQUE INDEX "document_sync_queues_workspaceDocId_key" ON "document_sync_queues"("workspaceDocId");

-- CreateIndex
CREATE UNIQUE INDEX "browser_extension_api_keys_key_key" ON "browser_extension_api_keys"("key");

-- CreateIndex
CREATE INDEX "browser_extension_api_keys_user_id_idx" ON "browser_extension_api_keys"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "temporary_auth_tokens_token_key" ON "temporary_auth_tokens"("token");

-- CreateIndex
CREATE INDEX "temporary_auth_tokens_token_idx" ON "temporary_auth_tokens"("token");

-- CreateIndex
CREATE INDEX "temporary_auth_tokens_userId_idx" ON "temporary_auth_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "system_prompt_variables_key_key" ON "system_prompt_variables"("key");

-- CreateIndex
CREATE INDEX "system_prompt_variables_userId_idx" ON "system_prompt_variables"("userId");

-- CreateIndex
CREATE INDEX "prompt_history_workspaceId_idx" ON "prompt_history"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "desktop_mobile_devices_token_key" ON "desktop_mobile_devices"("token");

-- CreateIndex
CREATE INDEX "desktop_mobile_devices_userId_idx" ON "desktop_mobile_devices"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_parsed_files_filename_key" ON "workspace_parsed_files"("filename");

-- CreateIndex
CREATE INDEX "workspace_parsed_files_workspaceId_idx" ON "workspace_parsed_files"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_parsed_files_userId_idx" ON "workspace_parsed_files"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "external_communication_connectors_type_key" ON "external_communication_connectors"("type");

-- CreateIndex
CREATE UNIQUE INDEX "wechat_gateway_threads_wxid_key" ON "wechat_gateway_threads"("wxid");

-- CreateIndex
CREATE INDEX "wechat_gateway_threads_workspace_slug_idx" ON "wechat_gateway_threads"("workspace_slug");

-- CreateIndex
CREATE INDEX "wechat_gateway_threads_thread_slug_idx" ON "wechat_gateway_threads"("thread_slug");

-- CreateIndex
CREATE INDEX "scheduled_job_runs_jobId_idx" ON "scheduled_job_runs"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "security_key_registry_keyId_key" ON "security_key_registry"("keyId");

-- CreateIndex
CREATE INDEX "security_key_registry_purpose_status_idx" ON "security_key_registry"("purpose", "status");

-- CreateIndex
CREATE INDEX "security_key_registry_fingerprint_idx" ON "security_key_registry"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "security_key_domain_bindings_domain_key" ON "security_key_domain_bindings"("domain");

-- CreateIndex
CREATE INDEX "security_key_domain_bindings_purpose_idx" ON "security_key_domain_bindings"("purpose");

-- CreateIndex
CREATE INDEX "security_key_domain_bindings_activeKeyId_idx" ON "security_key_domain_bindings"("activeKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "security_key_rotation_jobs_jobId_key" ON "security_key_rotation_jobs"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "security_key_rotation_jobs_idempotencyKey_key" ON "security_key_rotation_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "security_key_rotation_jobs_purpose_status_idx" ON "security_key_rotation_jobs"("purpose", "status");

-- CreateIndex
CREATE INDEX "security_key_rotation_jobs_createdAt_idx" ON "security_key_rotation_jobs"("createdAt");

-- CreateIndex
CREATE INDEX "security_key_events_event_idx" ON "security_key_events"("event");

-- CreateIndex
CREATE INDEX "security_key_events_keyId_idx" ON "security_key_events"("keyId");

-- CreateIndex
CREATE INDEX "security_key_events_jobId_idx" ON "security_key_events"("jobId");

-- CreateIndex
CREATE INDEX "ai_price_catalog_provider_active_effectiveAt_idx" ON "ai_price_catalog"("provider", "active", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_price_catalog_provider_modelPattern_version_key" ON "ai_price_catalog"("provider", "modelPattern", "version");

-- CreateIndex
CREATE INDEX "ai_budget_policies_enabled_ownerType_ownerId_idx" ON "ai_budget_policies"("enabled", "ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_budget_policies_ownerType_ownerId_taskType_key" ON "ai_budget_policies"("ownerType", "ownerId", "taskType");

-- CreateIndex
CREATE INDEX "ai_budget_reservations_ownerType_ownerId_status_createdAt_idx" ON "ai_budget_reservations"("ownerType", "ownerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ai_budget_reservations_status_expiresAt_idx" ON "ai_budget_reservations"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ai_budget_reservations_workspaceId_createdAt_idx" ON "ai_budget_reservations"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_budget_reservations_userId_createdAt_idx" ON "ai_budget_reservations"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_events_ownerType_ownerId_createdAt_idx" ON "ai_usage_events"("ownerType", "ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_events_workspaceId_createdAt_idx" ON "ai_usage_events"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_events_userId_createdAt_idx" ON "ai_usage_events"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_events_provider_model_createdAt_idx" ON "ai_usage_events"("provider", "model", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_events_taskType_createdAt_idx" ON "ai_usage_events"("taskType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_events_reservationId_key" ON "ai_usage_events"("reservationId");

-- CreateIndex
CREATE INDEX "ai_eval_cases_suite_active_idx" ON "ai_eval_cases"("suite", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ai_eval_cases_suite_version_id_key" ON "ai_eval_cases"("suite", "version", "id");

-- CreateIndex
CREATE INDEX "ai_eval_results_caseId_createdAt_idx" ON "ai_eval_results"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_eval_results_runId_idx" ON "ai_eval_results"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_eval_results_runId_caseId_key" ON "ai_eval_results"("runId", "caseId");

-- AddForeignKey
ALTER TABLE "workspace_documents" ADD CONSTRAINT "workspace_documents_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeSupplement" ADD CONSTRAINT "NodeSupplement_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "workspace_documents"("docId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceSupplement" ADD CONSTRAINT "WorkspaceSupplement_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "workspace_documents"("docId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_authUserId_fkey" FOREIGN KEY ("authUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_codes" ADD CONSTRAINT "email_verification_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_grants" ADD CONSTRAINT "email_verification_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasskeyChallenge" ADD CONSTRAINT "PasskeyChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedLoginDevice" ADD CONSTRAINT "TrustedLoginDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "athena_clients" ADD CONSTRAINT "athena_clients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_state_preferences" ADD CONSTRAINT "user_state_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_library_items" ADD CONSTRAINT "reader_library_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_library_categories" ADD CONSTRAINT "reader_library_categories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZkLoginAttempt" ADD CONSTRAINT "ZkLoginAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_threads" ADD CONSTRAINT "workspace_threads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_threads" ADD CONSTRAINT "workspace_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "athena_sync_events" ADD CONSTRAINT "athena_sync_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "athena_ios_push_tokens" ADD CONSTRAINT "athena_ios_push_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "athena_mutation_receipts" ADD CONSTRAINT "athena_mutation_receipts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_suggested_messages" ADD CONSTRAINT "workspace_suggested_messages_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_chats" ADD CONSTRAINT "workspace_chats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_mind_maps" ADD CONSTRAINT "workspace_mind_maps_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_mind_maps" ADD CONSTRAINT "workspace_mind_maps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_agent_invocations" ADD CONSTRAINT "workspace_agent_invocations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_agent_invocations" ADD CONSTRAINT "workspace_agent_invocations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_users" ADD CONSTRAINT "workspace_users_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_users" ADD CONSTRAINT "workspace_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embed_configs" ADD CONSTRAINT "embed_configs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embed_configs" ADD CONSTRAINT "embed_configs_usersId_fkey" FOREIGN KEY ("usersId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embed_chats" ADD CONSTRAINT "embed_chats_embed_id_fkey" FOREIGN KEY ("embed_id") REFERENCES "embed_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embed_chats" ADD CONSTRAINT "embed_chats_usersId_fkey" FOREIGN KEY ("usersId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slash_command_presets" ADD CONSTRAINT "slash_command_presets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sync_queues" ADD CONSTRAINT "document_sync_queues_workspaceDocId_fkey" FOREIGN KEY ("workspaceDocId") REFERENCES "workspace_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sync_executions" ADD CONSTRAINT "document_sync_executions_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "document_sync_queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_extension_api_keys" ADD CONSTRAINT "browser_extension_api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temporary_auth_tokens" ADD CONSTRAINT "temporary_auth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_prompt_variables" ADD CONSTRAINT "system_prompt_variables_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_history" ADD CONSTRAINT "prompt_history_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_history" ADD CONSTRAINT "prompt_history_modifiedBy_fkey" FOREIGN KEY ("modifiedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desktop_mobile_devices" ADD CONSTRAINT "desktop_mobile_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_parsed_files" ADD CONSTRAINT "workspace_parsed_files_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_parsed_files" ADD CONSTRAINT "workspace_parsed_files_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_parsed_files" ADD CONSTRAINT "workspace_parsed_files_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "workspace_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_job_runs" ADD CONSTRAINT "scheduled_job_runs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "scheduled_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
