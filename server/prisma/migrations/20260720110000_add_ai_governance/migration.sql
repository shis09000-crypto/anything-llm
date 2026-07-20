CREATE TABLE "ai_price_catalog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "modelPattern" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "inputMicrosPerMillion" INTEGER,
  "outputMicrosPerMillion" INTEGER,
  "source" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "effectiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ai_price_catalog_provider_modelPattern_version_key"
  ON "ai_price_catalog"("provider", "modelPattern", "version");
CREATE INDEX "ai_price_catalog_provider_active_effectiveAt_idx"
  ON "ai_price_catalog"("provider", "active", "effectiveAt");

CREATE TABLE "ai_budget_policies" (
  "id" TEXT NOT NULL PRIMARY KEY,
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
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ai_budget_policies_ownerType_ownerId_taskType_key"
  ON "ai_budget_policies"("ownerType", "ownerId", "taskType");
CREATE INDEX "ai_budget_policies_enabled_ownerType_ownerId_idx"
  ON "ai_budget_policies"("enabled", "ownerType", "ownerId");

CREATE TABLE "ai_budget_reservations" (
  "id" TEXT NOT NULL PRIMARY KEY,
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
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "settledAt" DATETIME
);
CREATE INDEX "ai_budget_reservations_ownerType_ownerId_status_createdAt_idx"
  ON "ai_budget_reservations"("ownerType", "ownerId", "status", "createdAt");
CREATE INDEX "ai_budget_reservations_status_expiresAt_idx"
  ON "ai_budget_reservations"("status", "expiresAt");
CREATE INDEX "ai_budget_reservations_workspaceId_createdAt_idx"
  ON "ai_budget_reservations"("workspaceId", "createdAt");
CREATE INDEX "ai_budget_reservations_userId_createdAt_idx"
  ON "ai_budget_reservations"("userId", "createdAt");

CREATE TABLE "ai_usage_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
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
  "startedAt" DATETIME NOT NULL,
  "completedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ai_usage_events_reservationId_key"
  ON "ai_usage_events"("reservationId");
CREATE INDEX "ai_usage_events_ownerType_ownerId_createdAt_idx"
  ON "ai_usage_events"("ownerType", "ownerId", "createdAt");
CREATE INDEX "ai_usage_events_workspaceId_createdAt_idx"
  ON "ai_usage_events"("workspaceId", "createdAt");
CREATE INDEX "ai_usage_events_userId_createdAt_idx"
  ON "ai_usage_events"("userId", "createdAt");
CREATE INDEX "ai_usage_events_provider_model_createdAt_idx"
  ON "ai_usage_events"("provider", "model", "createdAt");
CREATE INDEX "ai_usage_events_taskType_createdAt_idx"
  ON "ai_usage_events"("taskType", "createdAt");

CREATE TABLE "ai_eval_cases" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "suite" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "dataClass" TEXT NOT NULL DEFAULT 'synthetic',
  "authorizationRef" TEXT,
  "inputRef" TEXT,
  "expectedJson" TEXT NOT NULL DEFAULT '{}',
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ai_eval_cases_suite_version_id_key"
  ON "ai_eval_cases"("suite", "version", "id");
CREATE INDEX "ai_eval_cases_suite_active_idx"
  ON "ai_eval_cases"("suite", "active");

CREATE TABLE "ai_eval_results" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "caseId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "qualityScore" REAL,
  "safetyScore" REAL,
  "toolScore" REAL,
  "latencyMs" INTEGER,
  "costMicros" INTEGER,
  "resultRef" TEXT,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ai_eval_results_runId_caseId_key"
  ON "ai_eval_results"("runId", "caseId");
CREATE INDEX "ai_eval_results_caseId_createdAt_idx"
  ON "ai_eval_results"("caseId", "createdAt");
CREATE INDEX "ai_eval_results_runId_idx" ON "ai_eval_results"("runId");
