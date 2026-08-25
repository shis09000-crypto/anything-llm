const prisma = require("../utils/prisma");
const { v4: uuidv4 } = require("uuid");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");

function goalError(code, httpStatus = 400) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function scope({ workspace, thread, user = null }) {
  if (!workspace?.id || !thread?.id) throw goalError("goal_thread_required");
  return {
    workspace_id: Number(workspace.id),
    thread_id: Number(thread.id),
    user_id: user?.id ? Number(user.id) : null,
  };
}

function activeScopeKey(values) {
  return `${values.workspace_id}:${values.thread_id}`;
}

function threadScope(values) {
  return {
    workspace_id: values.workspace_id,
    thread_id: values.thread_id,
  };
}

function publicGoal(goal = null) {
  if (!goal) return null;
  return {
    goalId: goal.uuid,
    objective: goal.objective,
    status: goal.status,
    createdAt: goal.createdAt,
    lastUpdatedAt: goal.lastUpdatedAt,
    completedAt: goal.completedAt,
    blockedAt: goal.blockedAt,
    abandonedAt: goal.abandonedAt,
  };
}

const WorkspaceThreadGoal = {
  active: async ({ workspace, thread, user = null }) => {
    try {
      const values = scope({ workspace, thread, user });
      return await prisma.workspace_thread_goals.findFirst({
        where: { ...threadScope(values), status: "active" },
        orderBy: { createdAt: "desc" },
      });
    } catch (error) {
      if (error?.code?.startsWith?.("goal_")) throw error;
      throwModelDataAccessError("workspaceThreadGoal.active", error);
    }
  },

  getScoped: async ({ workspace, thread, user = null, goalId }) => {
    try {
      return await prisma.workspace_thread_goals.findFirst({
        where: {
          ...threadScope(scope({ workspace, thread, user })),
          uuid: String(goalId || ""),
        },
      });
    } catch (error) {
      if (error?.code?.startsWith?.("goal_")) throw error;
      throwModelDataAccessError("workspaceThreadGoal.getScoped", error);
    }
  },

  resolveForTurn: async ({
    workspace,
    thread,
    user = null,
    clientTurnId,
    objective,
    goal = null,
  }) => {
    const values = scope({ workspace, thread, user });
    const normalizedTurnId = String(clientTurnId || "").trim();
    const action = String(goal?.action || "attach")
      .trim()
      .toLowerCase();
    if (!normalizedTurnId) throw goalError("goal_client_turn_required");
    if (!["create", "attach", "replace"].includes(action))
      throw goalError("goal_action_invalid");
    try {
      const replay = await prisma.workspace_thread_goals.findUnique({
        where: { sourceClientTurnId: normalizedTurnId },
      });
      if (replay) {
        if (
          replay.workspace_id !== values.workspace_id ||
          replay.thread_id !== values.thread_id ||
          replay.user_id !== values.user_id
        )
          throw goalError("goal_client_turn_conflict", 409);
        return { goal: replay, created: false, replayed: true };
      }

      if (action === "attach") {
        const attached = goal?.goalId
          ? await prisma.workspace_thread_goals.findFirst({
              where: {
                ...threadScope(values),
                uuid: String(goal.goalId),
                status: { in: ["active", "completed"] },
              },
            })
          : await prisma.workspace_thread_goals.findFirst({
              where: { ...threadScope(values), status: "active" },
              orderBy: { createdAt: "desc" },
            });
        if (goal?.goalId && !attached)
          throw goalError("goal_not_available", 409);
        return { goal: attached, created: false, replayed: false };
      }

      const text = String(objective || "").trim();
      if (!text) throw goalError("goal_objective_required");
      const created = await prisma.$transaction(async (tx) => {
        const active = await tx.workspace_thread_goals.findFirst({
          where: { ...threadScope(values), status: "active" },
          orderBy: { createdAt: "desc" },
        });
        if (action === "create" && active)
          throw goalError("goal_active_exists", 409);
        if (action === "replace") {
          const expected = String(goal?.expectedActiveGoalId || "").trim();
          if (!active || !expected || active.uuid !== expected)
            throw goalError("goal_active_changed", 409);
          await tx.workspace_thread_goals.update({
            where: { id: active.id },
            data: {
              status: "abandoned",
              activeScopeKey: null,
              abandonedAt: new Date(),
              lastUpdatedAt: new Date(),
            },
          });
        }
        return tx.workspace_thread_goals.create({
          data: {
            uuid: uuidv4(),
            ...values,
            objective: text,
            sourceClientTurnId: normalizedTurnId,
            activeScopeKey: activeScopeKey(values),
          },
        });
      });
      return { goal: created, created: true, replayed: false };
    } catch (error) {
      if (error?.code?.startsWith?.("goal_")) throw error;
      if (error?.code === "P2002") throw goalError("goal_active_changed", 409);
      throwModelDataAccessError("workspaceThreadGoal.resolveForTurn", error);
    }
  },

  abandon: async ({ workspace, thread, user = null, goalId }) => {
    try {
      const existing = await prisma.workspace_thread_goals.findFirst({
        where: {
          ...threadScope(scope({ workspace, thread, user })),
          uuid: String(goalId || ""),
          status: "active",
        },
      });
      if (!existing) throw goalError("goal_not_active", 404);
      return await prisma.workspace_thread_goals.update({
        where: { id: existing.id },
        data: {
          status: "abandoned",
          activeScopeKey: null,
          abandonedAt: new Date(),
          lastUpdatedAt: new Date(),
        },
      });
    } catch (error) {
      if (error?.code?.startsWith?.("goal_")) throw error;
      throwModelDataAccessError("workspaceThreadGoal.abandon", error);
    }
  },

  stageStatus: async ({ goalId, clientTurnId, status }) => {
    const terminalStatus = String(status || "").trim();
    if (!["completed", "blocked"].includes(terminalStatus))
      throw goalError("goal_status_invalid");
    try {
      return await prisma.workspace_thread_goals.updateMany({
        where: { uuid: String(goalId), status: "active" },
        data: {
          pendingStatus: terminalStatus,
          pendingStatusClientTurnId: String(clientTurnId),
          lastUpdatedAt: new Date(),
        },
      });
    } catch (error) {
      if (error?.code?.startsWith?.("goal_")) throw error;
      throwModelDataAccessError("workspaceThreadGoal.stageStatus", error);
    }
  },

  commitStatus: async ({ goalId, clientTurnId }) => {
    try {
      return await prisma.$transaction(async (tx) => {
        const pending = await tx.workspace_thread_goals.findFirst({
          where: {
            uuid: String(goalId),
            status: "active",
            pendingStatus: { in: ["completed", "blocked"] },
            pendingStatusClientTurnId: String(clientTurnId),
          },
        });
        if (!pending) return null;
        const now = new Date();
        const result = await tx.workspace_thread_goals.updateMany({
          where: {
            id: pending.id,
            status: "active",
            pendingStatus: pending.pendingStatus,
            pendingStatusClientTurnId: String(clientTurnId),
          },
          data: {
            status: pending.pendingStatus,
            activeScopeKey: null,
            statusClientTurnId: String(clientTurnId),
            pendingStatus: null,
            pendingStatusClientTurnId: null,
            ...(pending.pendingStatus === "completed"
              ? { completedAt: now }
              : { blockedAt: now }),
            lastUpdatedAt: now,
          },
        });
        return Number(result?.count || 0) > 0
          ? { ...pending, status: pending.pendingStatus }
          : null;
      });
    } catch (error) {
      throwModelDataAccessError("workspaceThreadGoal.commitStatus", error);
    }
  },

  publicGoal,
};

module.exports = { WorkspaceThreadGoal, publicGoal };
