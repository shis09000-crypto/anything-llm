CREATE TABLE "module_instances" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "runtimeRole" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifestFingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'registered',
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "heartbeatAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "lastReasonCode" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "module_instances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "module_instances_moduleId_state_idx" ON "module_instances"("moduleId", "state");
CREATE INDEX "module_instances_leaseExpiresAt_idx" ON "module_instances"("leaseExpiresAt");
CREATE INDEX "module_instances_runtimeRole_state_idx" ON "module_instances"("runtimeRole", "state");

CREATE TABLE "module_lifecycle_events" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "module_lifecycle_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "module_lifecycle_events_instanceId_sequence_key" ON "module_lifecycle_events"("instanceId", "sequence");
CREATE INDEX "module_lifecycle_events_moduleId_occurredAt_idx" ON "module_lifecycle_events"("moduleId", "occurredAt");
CREATE INDEX "module_lifecycle_events_instanceId_occurredAt_idx" ON "module_lifecycle_events"("instanceId", "occurredAt");

CREATE TABLE "coordination_runs" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "center" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "priority" TEXT NOT NULL DEFAULT 'P2',
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "ownerUserId" INTEGER,
    "ownerAuthUserId" TEXT,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "lowerLevelExhausted" BOOLEAN NOT NULL DEFAULT false,
    "evidenceJson" TEXT NOT NULL DEFAULT '[]',
    "policyJson" TEXT NOT NULL DEFAULT '{}',
    "deadlineAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "coordination_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "coordination_runs_idempotencyKey_key" ON "coordination_runs"("idempotencyKey");
CREATE INDEX "coordination_runs_center_status_createdAt_idx" ON "coordination_runs"("center", "status", "createdAt");
CREATE INDEX "coordination_runs_correlationId_idx" ON "coordination_runs"("correlationId");
CREATE INDEX "coordination_runs_ownerUserId_status_idx" ON "coordination_runs"("ownerUserId", "status");
CREATE INDEX "coordination_runs_deadlineAt_status_idx" ON "coordination_runs"("deadlineAt", "status");

CREATE TABLE "coordination_steps" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dependsOnJson" TEXT NOT NULL DEFAULT '[]',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "checkpointJson" TEXT NOT NULL DEFAULT '{}',
    "resultHash" TEXT,
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "coordination_steps_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "coordination_steps" ADD CONSTRAINT "coordination_steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "coordination_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "coordination_steps_runId_moduleId_capability_key" ON "coordination_steps"("runId", "moduleId", "capability");
CREATE INDEX "coordination_steps_runId_status_idx" ON "coordination_steps"("runId", "status");
CREATE INDEX "coordination_steps_moduleId_status_idx" ON "coordination_steps"("moduleId", "status");

CREATE TABLE "optimistic_mutation_receipts" (
    "id" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "coordinationRunId" TEXT,
    "ownerUserId" INTEGER,
    "ownerAuthUserId" TEXT,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "patchHash" TEXT NOT NULL,
    "authoritativeHash" TEXT,
    "reasonCode" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "optimistic_mutation_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "optimistic_mutation_receipts_mutationId_key" ON "optimistic_mutation_receipts"("mutationId");
CREATE INDEX "optimistic_mutation_receipts_ownerUserId_status_createdAt_idx" ON "optimistic_mutation_receipts"("ownerUserId", "status", "createdAt");
CREATE INDEX "optimistic_mutation_receipts_resourceType_resourceId_status_idx" ON "optimistic_mutation_receipts"("resourceType", "resourceId", "status");
CREATE INDEX "optimistic_mutation_receipts_expiresAt_status_idx" ON "optimistic_mutation_receipts"("expiresAt", "status");
