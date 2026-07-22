const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

const JSON_FIELDS = [
  "scopeJson",
  "parametersJson",
  "policyJson",
  "dryRunJson",
  "canaryJson",
  "resultJson",
  "validationJson",
  "rollbackJson",
];

function hydrate(row) {
  if (!row) return null;
  const result = { ...row };
  for (const field of JSON_FIELDS) {
    const key = field.replace(/Json$/, "");
    result[key] = safeJsonParse(row[field], {});
    delete result[field];
  }
  return result;
}

function serializeJsonFields(data = {}) {
  const result = { ...data };
  for (const field of JSON_FIELDS) {
    const key = field.replace(/Json$/, "");
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
    result[field] = JSON.stringify(result[key] || {});
    delete result[key];
  }
  return result;
}

const OperationsActionRepository = {
  domain: "operations-action",
  repositoryName: "OperationsActionRepository",

  async createRun(data = {}) {
    return hydrate(
      await prisma.operations_action_runs.create({
        data: serializeJsonFields(data),
      })
    );
  },

  async getRun(id) {
    return hydrate(
      await prisma.operations_action_runs.findUnique({
        where: { id: String(id) },
      })
    );
  },

  async getRunBySourceActionId(sourceActionId) {
    return hydrate(
      await prisma.operations_action_runs.findUnique({
        where: { sourceActionId: String(sourceActionId) },
      })
    );
  },

  async listRuns({
    status = null,
    statuses = [],
    actionId = null,
    limit = 100,
  } = {}) {
    const normalizedStatuses = [
      ...new Set(
        (Array.isArray(statuses) ? statuses : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      ),
    ];
    const rows = await prisma.operations_action_runs.findMany({
      where: {
        ...(normalizedStatuses.length
          ? { status: { in: normalizedStatuses } }
          : status
            ? { status: String(status) }
            : {}),
        ...(actionId ? { actionId: String(actionId) } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(Number(limit) || 100, 500)),
    });
    return rows.map(hydrate);
  },

  async transitionRun({ id, from = [], to, data = {} } = {}) {
    const expected = Array.isArray(from) ? from.map(String) : [String(from)];
    const result = await prisma.operations_action_runs.updateMany({
      where: {
        id: String(id),
        ...(expected.length ? { status: { in: expected } } : {}),
      },
      data: serializeJsonFields({ ...data, status: String(to) }),
    });
    if (result.count !== 1) {
      const error = new Error("operations_action_state_conflict");
      error.code = "operations_action_state_conflict";
      throw error;
    }
    return this.getRun(id);
  },

  async updateRun(id, data = {}) {
    return hydrate(
      await prisma.operations_action_runs.update({
        where: { id: String(id) },
        data: serializeJsonFields(data),
      })
    );
  },

  async addApproval({ runId, approverUserId, decision, reasonCode = null }) {
    try {
      return await prisma.operations_action_approvals.create({
        data: {
          runId: String(runId),
          approverUserId: Number(approverUserId),
          decision: String(decision),
          reasonCode: reasonCode ? String(reasonCode).slice(0, 160) : null,
        },
      });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      const existing = await prisma.operations_action_approvals.findUnique({
        where: {
          runId_approverUserId: {
            runId: String(runId),
            approverUserId: Number(approverUserId),
          },
        },
      });
      if (existing?.decision === String(decision)) return existing;
      const conflict = new Error("operations_approval_already_recorded");
      conflict.code = "operations_approval_already_recorded";
      throw conflict;
    }
  },

  async approvalsForRun(runId) {
    return await prisma.operations_action_approvals.findMany({
      where: { runId: String(runId) },
      orderBy: { createdAt: "asc" },
    });
  },

  async acquireLease({ runId, leaseOwner, leaseMs = 10 * 60_000 }) {
    const now = new Date();
    const result = await prisma.operations_action_runs.updateMany({
      where: {
        id: String(runId),
        OR: [
          { leaseOwner: null },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: now } },
          { leaseOwner: String(leaseOwner) },
        ],
      },
      data: {
        leaseOwner: String(leaseOwner).slice(0, 160),
        leaseExpiresAt: new Date(
          now.getTime() + Math.max(30_000, Number(leaseMs) || 10 * 60_000)
        ),
      },
    });
    return result.count === 1;
  },

  async releaseLease(runId, leaseOwner) {
    return await prisma.operations_action_runs.updateMany({
      where: { id: String(runId), leaseOwner: String(leaseOwner) },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  },

  async expiredLeasedRuns({
    statuses = [],
    now = new Date(),
    limit = 100,
  } = {}) {
    const normalizedStatuses = [
      ...new Set(
        (Array.isArray(statuses) ? statuses : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      ),
    ];
    const rows = await prisma.operations_action_runs.findMany({
      where: {
        ...(normalizedStatuses.length
          ? { status: { in: normalizedStatuses } }
          : {}),
        leaseOwner: { not: null },
        leaseExpiresAt: { lte: now },
      },
      orderBy: { leaseExpiresAt: "asc" },
      take: Math.max(1, Math.min(Number(limit) || 100, 500)),
    });
    return rows.map(hydrate);
  },
};

module.exports = { OperationsActionRepository, hydrate, serializeJsonFields };
