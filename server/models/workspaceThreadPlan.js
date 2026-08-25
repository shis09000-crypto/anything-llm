const prisma = require("../utils/prisma");
const { v4: uuidv4 } = require("uuid");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");

const STEP_STATUSES = new Set(["pending", "in_progress", "completed"]);

function planError(code, httpStatus = 400) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function scope({ workspace, thread, user = null }) {
  if (!workspace?.id || !thread?.id) throw planError("plan_thread_required");
  return {
    workspace_id: Number(workspace.id),
    thread_id: Number(thread.id),
    user_id: user?.id ? Number(user.id) : null,
  };
}

function threadScope(values) {
  return {
    workspace_id: values.workspace_id,
    thread_id: values.thread_id,
  };
}

function activeScopeKey(values) {
  return `${values.workspace_id}:${values.thread_id}`;
}

function parseSteps(value = "[]") {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, index) => ({
        id: String(item?.id || `step-${index + 1}`),
        step: String(item?.step || "").trim(),
        status: STEP_STATUSES.has(item?.status) ? item.status : "pending",
      }))
      .filter((item) => item.step);
  } catch {
    return [];
  }
}

function planFromMarkdown(markdown = "") {
  const text = String(markdown || "").trim();
  const lines = text.split(/\r?\n/);
  const title =
    lines
      .find((line) => /^#{1,3}\s+\S/.test(line))
      ?.replace(/^#{1,3}\s+/, "") || "Implementation plan";
  const steps = [];
  for (const line of lines) {
    const match = line.match(
      /^\s*(?:[-*]\s+(?:\[([ xX])\]\s*)?|\d+[.)]\s+)(.+?)\s*$/
    );
    if (!match) continue;
    const step = String(match[2] || "").trim();
    if (!step || step.length > 2_000) continue;
    steps.push({
      id: `step-${steps.length + 1}`,
      step,
      status: /[xX]/.test(match[1] || "") ? "completed" : "pending",
    });
    if (steps.length >= 40) break;
  }
  if (!steps.length && text) {
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((value) => value.replace(/^#{1,3}\s+/, "").trim())
      .filter((value) => value && value !== title)
      .slice(0, 12);
    paragraphs.forEach((step, index) =>
      steps.push({ id: `step-${index + 1}`, step, status: "pending" })
    );
  }
  return { title: title.slice(0, 240), steps };
}

function publicPlan(plan = null) {
  if (!plan) return null;
  return {
    planId: plan.uuid,
    goalId: plan.goalId || null,
    objective: plan.objective,
    title: plan.title || "Implementation plan",
    markdown: plan.markdown || "",
    steps: parseSteps(plan.stepsJson),
    status: plan.status,
    revision: Number(plan.revision || 0),
    createdAt: plan.createdAt,
    lastUpdatedAt: plan.lastUpdatedAt,
    readyAt: plan.readyAt,
    startedAt: plan.startedAt,
    completedAt: plan.completedAt,
    abandonedAt: plan.abandonedAt,
  };
}

const WorkspaceThreadPlan = {
  active: async ({ workspace, thread, user = null }) => {
    try {
      const values = scope({ workspace, thread, user });
      return await prisma.workspace_thread_plans.findFirst({
        where: { activeScopeKey: activeScopeKey(values) },
        orderBy: { createdAt: "desc" },
      });
    } catch (error) {
      if (error?.code?.startsWith?.("plan_")) throw error;
      throwModelDataAccessError("workspaceThreadPlan.active", error);
    }
  },

  getScoped: async ({ workspace, thread, user = null, planId }) => {
    try {
      return await prisma.workspace_thread_plans.findFirst({
        where: {
          ...threadScope(scope({ workspace, thread, user })),
          uuid: String(planId || ""),
        },
      });
    } catch (error) {
      if (error?.code?.startsWith?.("plan_")) throw error;
      throwModelDataAccessError("workspaceThreadPlan.getScoped", error);
    }
  },

  resolveForTurn: async ({
    workspace,
    thread,
    user = null,
    clientTurnId,
    objective,
    goalId = null,
    plan = null,
  }) => {
    const values = scope({ workspace, thread, user });
    const turnId = String(clientTurnId || "").trim();
    const action = String(plan?.action || "create")
      .trim()
      .toLowerCase();
    if (!turnId) throw planError("plan_client_turn_required");
    if (!["create", "revise", "execute", "attach"].includes(action))
      throw planError("plan_action_invalid");
    try {
      if (action === "create") {
        const replay = await prisma.workspace_thread_plans.findUnique({
          where: { createClientTurnId: turnId },
        });
        if (replay) {
          if (
            replay.workspace_id !== values.workspace_id ||
            replay.thread_id !== values.thread_id
          )
            throw planError("plan_client_turn_conflict", 409);
          return { plan: replay, created: false, replayed: true, action };
        }
        const created = await prisma.$transaction(async (tx) => {
          await tx.workspace_thread_plans.updateMany({
            where: { activeScopeKey: activeScopeKey(values) },
            data: {
              status: "superseded",
              activeScopeKey: null,
              lastUpdatedAt: new Date(),
            },
          });
          return tx.workspace_thread_plans.create({
            data: {
              uuid: uuidv4(),
              ...values,
              goalId: String(goalId || "").trim() || null,
              objective: String(objective || "").trim(),
              status: "drafting",
              activeScopeKey: activeScopeKey(values),
              createClientTurnId: turnId,
              lastClientTurnId: turnId,
            },
          });
        });
        return { plan: created, created: true, replayed: false, action };
      }

      const existing = plan?.planId
        ? await prisma.workspace_thread_plans.findFirst({
            where: {
              ...threadScope(values),
              uuid: String(plan.planId),
              activeScopeKey: activeScopeKey(values),
            },
          })
        : await prisma.workspace_thread_plans.findFirst({
            where: { activeScopeKey: activeScopeKey(values) },
          });
      if (!existing) throw planError("plan_not_available", 409);
      if (existing.lastClientTurnId === turnId)
        return { plan: existing, created: false, replayed: true, action };
      if (action === "attach")
        return { plan: existing, created: false, replayed: false, action };
      if (action === "revise") {
        if (!["ready", "failed", "completed"].includes(existing.status))
          throw planError("plan_busy", 409);
        const revised = await prisma.workspace_thread_plans.update({
          where: { id: existing.id },
          data: {
            status: "drafting",
            lastClientTurnId: turnId,
            executionClientTurnId: null,
            startedAt: null,
            completedAt: null,
            lastUpdatedAt: new Date(),
          },
        });
        return { plan: revised, created: false, replayed: false, action };
      }
      if (!["ready", "executing"].includes(existing.status))
        throw planError("plan_not_ready", 409);
      const executing = await prisma.workspace_thread_plans.update({
        where: { id: existing.id },
        data: {
          status: "executing",
          executionClientTurnId: turnId,
          lastClientTurnId: turnId,
          startedAt: existing.startedAt || new Date(),
          lastUpdatedAt: new Date(),
        },
      });
      return { plan: executing, created: false, replayed: false, action };
    } catch (error) {
      if (error?.code?.startsWith?.("plan_")) throw error;
      if (error?.code === "P2002") throw planError("plan_active_changed", 409);
      throwModelDataAccessError("workspaceThreadPlan.resolveForTurn", error);
    }
  },

  finalizeDraft: async ({ planId, clientTurnId, markdown }) => {
    try {
      const parsed = planFromMarkdown(markdown);
      return await prisma.workspace_thread_plans.update({
        where: { uuid: String(planId) },
        data: {
          title: parsed.title,
          markdown: String(markdown || ""),
          stepsJson: JSON.stringify(parsed.steps),
          status: "ready",
          revision: { increment: 1 },
          lastClientTurnId: String(clientTurnId || "").trim() || null,
          readyAt: new Date(),
          lastUpdatedAt: new Date(),
        },
      });
    } catch (error) {
      throwModelDataAccessError("workspaceThreadPlan.finalizeDraft", error);
    }
  },

  markDraftFailed: async ({ planId, clientTurnId }) => {
    try {
      return await prisma.workspace_thread_plans.update({
        where: { uuid: String(planId) },
        data: {
          status: "failed",
          lastClientTurnId: String(clientTurnId || "").trim() || null,
          lastUpdatedAt: new Date(),
        },
      });
    } catch (error) {
      throwModelDataAccessError("workspaceThreadPlan.markDraftFailed", error);
    }
  },

  updateSteps: async ({ planId, clientTurnId, steps }) => {
    const normalized = parseSteps(steps);
    if (!normalized.length) throw planError("plan_steps_required");
    if (normalized.filter((step) => step.status === "in_progress").length > 1)
      throw planError("plan_multiple_in_progress");
    try {
      const completed = normalized.every((step) => step.status === "completed");
      return await prisma.workspace_thread_plans.update({
        where: { uuid: String(planId) },
        data: {
          stepsJson: JSON.stringify(normalized),
          status: completed ? "completed" : "executing",
          lastClientTurnId: String(clientTurnId || "").trim() || undefined,
          completedAt: completed ? new Date() : null,
          lastUpdatedAt: new Date(),
        },
      });
    } catch (error) {
      if (error?.code?.startsWith?.("plan_")) throw error;
      throwModelDataAccessError("workspaceThreadPlan.updateSteps", error);
    }
  },

  finishExecution: async ({ planId, clientTurnId }) => {
    try {
      const existing = await prisma.workspace_thread_plans.findUnique({
        where: { uuid: String(planId) },
      });
      if (!existing || existing.executionClientTurnId !== String(clientTurnId))
        return existing;
      if (existing.status === "completed") return existing;
      return await prisma.workspace_thread_plans.update({
        where: { id: existing.id },
        data: {
          status: "ready",
          lastUpdatedAt: new Date(),
        },
      });
    } catch (error) {
      throwModelDataAccessError("workspaceThreadPlan.finishExecution", error);
    }
  },

  abandon: async ({ workspace, thread, user = null, planId }) => {
    try {
      const existing = await prisma.workspace_thread_plans.findFirst({
        where: {
          ...threadScope(scope({ workspace, thread, user })),
          uuid: String(planId || ""),
          activeScopeKey: { not: null },
        },
      });
      if (!existing) throw planError("plan_not_active", 404);
      return await prisma.workspace_thread_plans.update({
        where: { id: existing.id },
        data: {
          status: "abandoned",
          activeScopeKey: null,
          abandonedAt: new Date(),
          lastUpdatedAt: new Date(),
        },
      });
    } catch (error) {
      if (error?.code?.startsWith?.("plan_")) throw error;
      throwModelDataAccessError("workspaceThreadPlan.abandon", error);
    }
  },

  publicPlan,
  planFromMarkdown,
  parseSteps,
};

module.exports = { WorkspaceThreadPlan };
