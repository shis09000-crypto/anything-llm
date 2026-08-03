const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

function coordinationError(code, httpStatus = 409) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function hydrateRun(row) {
  if (!row) return null;
  return {
    ...row,
    evidence: safeJsonParse(row.evidenceJson, []),
    policy: safeJsonParse(row.policyJson, {}),
    evidenceJson: undefined,
    policyJson: undefined,
  };
}

function hydrateStep(row) {
  if (!row) return null;
  return {
    ...row,
    dependsOn: safeJsonParse(row.dependsOnJson, []),
    checkpoint: safeJsonParse(row.checkpointJson, {}),
    dependsOnJson: undefined,
    checkpointJson: undefined,
  };
}

function runData(data = {}) {
  const result = { ...data };
  if (Object.prototype.hasOwnProperty.call(result, "evidence")) {
    result.evidenceJson = JSON.stringify(result.evidence || []);
    delete result.evidence;
  }
  if (Object.prototype.hasOwnProperty.call(result, "policy")) {
    result.policyJson = JSON.stringify(result.policy || {});
    delete result.policy;
  }
  return result;
}

function stepData(data = {}) {
  const result = { ...data };
  if (Object.prototype.hasOwnProperty.call(result, "dependsOn")) {
    result.dependsOnJson = JSON.stringify(result.dependsOn || []);
    delete result.dependsOn;
  }
  if (Object.prototype.hasOwnProperty.call(result, "checkpoint")) {
    result.checkpointJson = JSON.stringify(result.checkpoint || {});
    delete result.checkpoint;
  }
  return result;
}

const CoordinationRepository = {
  dataDomain: "coordination",
  repositoryName: "CoordinationRepository",

  async upsertModuleHeartbeat(heartbeat = {}) {
    const data = {
      moduleId: String(heartbeat.moduleId),
      runtimeRole: String(heartbeat.runtimeRole || heartbeat.moduleId),
      version: String(heartbeat.version),
      manifestFingerprint: String(heartbeat.manifestFingerprint),
      state: String(heartbeat.state),
      sequence: Number(heartbeat.sequence || 0),
      heartbeatAt: new Date(heartbeat.heartbeatAt),
      leaseExpiresAt: new Date(heartbeat.leaseExpiresAt),
      lastReasonCode: heartbeat.lastReasonCode
        ? String(heartbeat.lastReasonCode).slice(0, 160)
        : null,
      metadataJson: JSON.stringify(heartbeat.metadata || {}),
    };
    return prisma.module_instances.upsert({
      where: { id: String(heartbeat.instanceId) },
      create: { id: String(heartbeat.instanceId), ...data },
      update: data,
    });
  },

  async appendLifecycleEvent(event = {}) {
    try {
      return await prisma.module_lifecycle_events.create({
        data: {
          id: String(event.eventId),
          moduleId: String(event.moduleId),
          instanceId: String(event.instanceId),
          sequence: Number(event.sequence),
          fromState: String(event.from),
          toState: String(event.to),
          reasonCode: String(event.reasonCode).slice(0, 160),
          metadataJson: JSON.stringify(event.metadata || {}),
          occurredAt: new Date(event.occurredAt),
        },
      });
    } catch (error) {
      if (error?.code === "P2002") return null;
      throw error;
    }
  },

  async listModuleInstances({ moduleId = null, state = null } = {}) {
    return prisma.module_instances.findMany({
      where: {
        ...(moduleId ? { moduleId: String(moduleId) } : {}),
        ...(state ? { state: String(state) } : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
  },

  async createRun(data = {}) {
    if (data.idempotencyKey) {
      const existing = await prisma.coordination_runs.findUnique({
        where: { idempotencyKey: String(data.idempotencyKey) },
      });
      if (existing) return hydrateRun(existing);
    }
    return hydrateRun(
      await prisma.coordination_runs.create({ data: runData(data) })
    );
  },

  async getRun(id, { includeSteps = false } = {}) {
    const row = await prisma.coordination_runs.findUnique({
      where: { id: String(id) },
      include: includeSteps
        ? { steps: { orderBy: { createdAt: "asc" } } }
        : undefined,
    });
    const run = hydrateRun(row);
    if (run?.steps) run.steps = run.steps.map(hydrateStep);
    return run;
  },

  async transitionRun({ id, from = [], to, data = {} } = {}) {
    const states = Array.isArray(from) ? from.map(String) : [String(from)];
    const result = await prisma.coordination_runs.updateMany({
      where: {
        id: String(id),
        ...(states.length ? { status: { in: states } } : {}),
      },
      data: runData({ ...data, status: String(to) }),
    });
    if (result.count !== 1)
      throw coordinationError("coordination_run_state_conflict");
    return this.getRun(id, { includeSteps: true });
  },

  async addStep(data = {}) {
    try {
      return hydrateStep(
        await prisma.coordination_steps.create({ data: stepData(data) })
      );
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      return hydrateStep(
        await prisma.coordination_steps.findUnique({
          where: {
            runId_moduleId_capability: {
              runId: String(data.runId),
              moduleId: String(data.moduleId),
              capability: String(data.capability),
            },
          },
        })
      );
    }
  },

  async updateStep(id, data = {}) {
    return hydrateStep(
      await prisma.coordination_steps.update({
        where: { id: String(id) },
        data: stepData(data),
      })
    );
  },

  async createOptimisticReceipt(data = {}) {
    try {
      return await prisma.optimistic_mutation_receipts.create({ data });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      return prisma.optimistic_mutation_receipts.findUnique({
        where: { mutationId: String(data.mutationId) },
      });
    }
  },

  async settleOptimisticReceipt({ mutationId, status, data = {} } = {}) {
    if (!new Set(["confirmed", "rolled_back", "expired"]).has(status))
      throw coordinationError("optimistic_receipt_status_invalid", 400);
    const current = await prisma.optimistic_mutation_receipts.findUnique({
      where: { mutationId: String(mutationId) },
    });
    if (!current) throw coordinationError("optimistic_receipt_not_found", 404);
    if (current.status !== "pending") {
      if (current.status === status) return current;
      throw coordinationError("optimistic_receipt_state_conflict");
    }
    const now = new Date();
    return prisma.optimistic_mutation_receipts.update({
      where: { mutationId: String(mutationId) },
      data: {
        ...data,
        status,
        revision: { increment: 1 },
        ...(status === "confirmed" ? { confirmedAt: now } : {}),
        ...(status === "rolled_back" ? { rolledBackAt: now } : {}),
      },
    });
  },
};

module.exports = {
  CoordinationRepository,
  coordinationError,
  hydrateRun,
  hydrateStep,
};
