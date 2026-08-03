const crypto = require("crypto");
const { DataAccessCenter } = require("../dataAccess");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { createCoordinationCenters, CENTER_IDS } = require("./centers");
const { assertEscalation } = require("./autonomyPolicy");
const { loadManifests } = require("../modulePlatform/manifestRegistry");

const RUN_STATUSES = new Set([
  "shadow",
  "proposed",
  "running",
  "recovering",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
]);

function runtimeError(code, httpStatus = 400) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function safeEvidence(entry = {}) {
  return {
    level: Math.max(0, Math.min(Number(entry.level) || 0, 4)),
    status: ["attempted", "exhausted", "succeeded"].includes(entry.status)
      ? entry.status
      : "attempted",
    validation: entry.validation === "passed" ? "passed" : "failed",
    reasonCode: String(entry.reasonCode || "unspecified").slice(0, 160),
    evidenceRef: String(entry.evidenceRef || "").slice(0, 192),
    occurredAt: entry.occurredAt || new Date().toISOString(),
  };
}

class CoordinationRuntime {
  constructor({
    repository = DataAccessCenter.coordination,
    centers = createCoordinationCenters(),
    env = process.env,
    emit = emitSemanticEvent,
  } = {}) {
    this.repository = repository;
    this.centers = centers;
    this.env = env;
    this.emit = emit;
    this.status = "created";
    this.lastError = null;
    this.startedAt = null;
    this.counters = {
      planned: 0,
      completed: 0,
      failed: 0,
      escalationDenied: 0,
      escalationAccepted: 0,
      lifecycleHeartbeats: 0,
    };
  }

  authorityMode() {
    return String(this.env.ATHENA_COORDINATION_AUTHORITY_MODE || "shadow")
      .trim()
      .toLowerCase() === "authoritative"
      ? "authoritative"
      : "shadow";
  }

  async start() {
    if (this.status === "running") return this.snapshot();
    this.status = "starting";
    this.startedAt = new Date().toISOString();
    this.status = "running";
    return this.snapshot();
  }

  async stop() {
    this.status = "stopped";
    return this.snapshot();
  }

  snapshot() {
    return {
      ready: this.status === "running",
      status: this.status,
      authorityMode: this.authorityMode(),
      centers: CENTER_IDS.map((id) => ({
        id,
        registered: this.centers.has(id),
      })),
      startedAt: this.startedAt,
      lastError: this.lastError,
      counters: { ...this.counters },
    };
  }

  emitRun(eventType, run, metadata = {}) {
    try {
      this.emit({
        eventType,
        category: "coordination",
        severity: eventType.endsWith("failed") ? "warning" : "info",
        outcome: run.status,
        subject: {
          type: "coordination-run",
          id: run.id,
          component: "coordination-plane",
          operation: run.type,
        },
        correlation: {
          operationId: run.id,
          traceId: metadata.traceId || undefined,
        },
        metadata: {
          center: run.center,
          priority: run.priority,
          escalationLevel: run.escalationLevel,
          reasonCode: metadata.reasonCode || null,
        },
        sensitivity: "metadata_only",
      });
    } catch {
      // Coordination telemetry cannot change the run result.
    }
  }

  async plan(input = {}) {
    if (this.status !== "running")
      throw runtimeError("coordination_not_ready", 503);
    const centerId = String(input.center || "");
    const center = this.centers.get(centerId);
    if (!center) throw runtimeError("coordination_center_unknown", 404);
    const correlationId = String(input.correlationId || crypto.randomUUID());
    const prepared = center.plan(input);
    const id = String(input.id || `coord_${crypto.randomUUID()}`);
    const run = await this.repository.createRun({
      id,
      idempotencyKey: input.idempotencyKey
        ? String(input.idempotencyKey)
        : null,
      center: centerId,
      type: String(input.type || `${centerId}.coordinate`),
      status: this.authorityMode() === "shadow" ? "shadow" : "proposed",
      priority: ["P0", "P1", "P2", "P3", "P4"].includes(input.priority)
        ? input.priority
        : "P2",
      correlationId,
      causationId: input.causationId ? String(input.causationId) : null,
      ownerUserId: Number(input.ownerUserId) || null,
      ownerAuthUserId: input.ownerAuthUserId
        ? String(input.ownerAuthUserId)
        : null,
      resourceType: input.resourceType ? String(input.resourceType) : null,
      resourceId: input.resourceId ? String(input.resourceId) : null,
      policy: {
        authorityMode: this.authorityMode(),
        center: centerId,
        noBusinessLogicOwnership: true,
        prioritySemantics: "athena-task-priority-v1",
        priorityInheritedByModuleSteps: true,
      },
      deadlineAt: input.deadlineAt ? new Date(input.deadlineAt) : null,
    });
    for (const step of prepared.steps) {
      await this.repository.addStep({
        id: `${run.id}:${step.id}`,
        runId: run.id,
        moduleId: step.moduleId,
        capability: step.capability,
        dependsOn: step.dependsOn,
        maxAttempts: step.maxAttempts,
      });
    }
    if (centerId === "optimistic") {
      await this.repository.createOptimisticReceipt({
        id: `optimistic_${crypto.randomUUID()}`,
        mutationId: prepared.mutationId,
        coordinationRunId: run.id,
        ownerUserId: Number(input.ownerUserId) || null,
        ownerAuthUserId: input.ownerAuthUserId
          ? String(input.ownerAuthUserId)
          : null,
        resourceType: prepared.resourceType,
        resourceId: prepared.resourceId,
        patchHash: prepared.patchHash,
        expiresAt: prepared.expiresAt,
      });
    }
    this.counters.planned += 1;
    this.emitRun("coordination.run.planned", run);
    return this.repository.getRun(run.id, { includeSteps: true });
  }

  async startRun(runId) {
    const run = await this.repository.getRun(runId, { includeSteps: true });
    if (!run) throw runtimeError("coordination_run_not_found", 404);
    if (run.status === "shadow") return run;
    return this.repository.transitionRun({
      id: run.id,
      from: ["proposed"],
      to: "running",
    });
  }

  async recordAutonomyAttempt(runId, evidenceInput = {}) {
    const run = await this.repository.getRun(runId, { includeSteps: true });
    if (!run) throw runtimeError("coordination_run_not_found", 404);
    const evidence = [...run.evidence, safeEvidence(evidenceInput)].slice(-100);
    const latest = evidence.at(-1);
    if (latest.status === "succeeded" || latest.validation === "passed") {
      this.counters.completed += 1;
      const completed = await this.repository.transitionRun({
        id: run.id,
        from: [run.status],
        to: "completed",
        data: { evidence, completedAt: new Date() },
      });
      this.emitRun("coordination.run.completed", completed);
      return completed;
    }
    return this.repository.transitionRun({
      id: run.id,
      from: [run.status],
      to: run.status,
      data: { evidence },
    });
  }

  async requestEscalation({
    runId,
    targetLevel,
    phase = "propose",
    approvalCount = 0,
    moduleId = null,
  } = {}) {
    const run = await this.repository.getRun(runId, { includeSteps: true });
    if (!run) throw runtimeError("coordination_run_not_found", 404);
    const manifest = moduleId
      ? require("../modulePlatform/manifestRegistry").moduleManifest(moduleId)
      : null;
    let decision;
    try {
      decision = assertEscalation({
        currentLevel: run.escalationLevel,
        targetLevel,
        evidence: run.evidence,
        phase,
        approvalCount,
        moduleFailureMode:
          manifest?.security?.failureMode || "isolated-degraded",
      });
    } catch (error) {
      this.counters.escalationDenied += 1;
      throw error;
    }
    const nextStatus = decision.approvalRequired
      ? "awaiting_approval"
      : "recovering";
    const updated = await this.repository.transitionRun({
      id: run.id,
      from: [run.status],
      to: nextStatus,
      data: {
        escalationLevel: Number(targetLevel),
        lowerLevelExhausted: Number(targetLevel) >= 2,
        policy: { ...run.policy, escalation: decision },
      },
    });
    this.counters.escalationAccepted += 1;
    this.emitRun("coordination.escalation.accepted", updated);
    return { run: updated, decision };
  }

  async statusForRun(runId) {
    const run = await this.repository.getRun(runId, { includeSteps: true });
    if (!run) throw runtimeError("coordination_run_not_found", 404);
    return run;
  }

  async cancel(runId, reasonCode = "cancelled_by_request") {
    const run = await this.statusForRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    return this.repository.transitionRun({
      id: run.id,
      from: [run.status],
      to: "cancelled",
      data: {
        completedAt: new Date(),
        evidence: [
          ...run.evidence,
          safeEvidence({
            level: run.escalationLevel,
            status: "attempted",
            validation: "failed",
            reasonCode,
            evidenceRef: `run:${run.id}`,
          }),
        ],
      },
    });
  }

  async recordModuleHeartbeat(input = {}) {
    this.counters.lifecycleHeartbeats += 1;
    return this.repository.upsertModuleHeartbeat(input);
  }

  async recordLifecycleEvent(input = {}) {
    return this.repository.appendLifecycleEvent(input);
  }

  async moduleCoverage({ now = Date.now() } = {}) {
    const expected = loadManifests().map((manifest) => manifest.id);
    const expectedSet = new Set(expected);
    const instances = await this.repository.listModuleInstances();
    const latest = new Map();
    for (const instance of instances)
      if (!latest.has(instance.moduleId))
        latest.set(instance.moduleId, instance);
    const modules = expected.map((moduleId) => {
      const instance = latest.get(moduleId) || null;
      const leaseExpiresAt = instance?.leaseExpiresAt
        ? new Date(instance.leaseExpiresAt).toISOString()
        : null;
      const fresh = Boolean(
        leaseExpiresAt && Date.parse(leaseExpiresAt) > Number(now)
      );
      const healthy = fresh && instance?.state === "ready";
      return {
        moduleId,
        instanceId: instance?.id || null,
        version: instance?.version || null,
        state: instance?.state || "unmonitored",
        fresh,
        healthy,
        heartbeatAt: instance?.heartbeatAt
          ? new Date(instance.heartbeatAt).toISOString()
          : null,
        leaseExpiresAt,
        reasonCode: instance?.lastReasonCode || null,
      };
    });
    const healthy = modules.filter((module) => module.healthy).length;
    return {
      generatedAt: new Date(Number(now)).toISOString(),
      authorityMode: this.authorityMode(),
      expected: expected.length,
      healthy,
      complete: healthy === expected.length,
      unknown: instances
        .filter((instance) => !expectedSet.has(instance.moduleId))
        .map((instance) => instance.moduleId),
      degraded: modules
        .filter((module) => !module.healthy)
        .map((module) => module.moduleId),
      modules,
    };
  }
}

module.exports = {
  CoordinationRuntime,
  RUN_STATUSES,
  runtimeError,
  safeEvidence,
};
