const { DataAccessCenter } = require("../../../dataAccess");

function invocationScope(aibitat) {
  const invocation = aibitat.handlerProps?.invocation || {};
  return {
    planId: invocation.planId,
    clientTurnId: invocation.clientTurnId,
    workspace:
      invocation.workspace ||
      (invocation.workspace_id ? { id: invocation.workspace_id } : null),
    thread: invocation.thread_id ? { id: invocation.thread_id } : null,
    user: invocation.user_id ? { id: invocation.user_id } : null,
  };
}

const getPlan = {
  name: "get_plan",
  startupConfig: { params: {} },
  plugin() {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: "get_plan",
          description: "Read the current executable thread plan and its steps.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          handler: async function () {
            const scope = invocationScope(this.super);
            if (!scope.planId) return JSON.stringify({ plan: null });
            const plan =
              await DataAccessCenter.workspaceThreadPlan.getScoped(scope);
            return JSON.stringify({
              plan: DataAccessCenter.workspaceThreadPlan.publicPlan(plan),
            });
          },
        });
      },
    };
  },
};

const updatePlan = {
  name: "update_plan",
  startupConfig: { params: {} },
  plugin() {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: "update_plan",
          description:
            "Update the executable plan checklist. Keep at most one step in progress.",
          parameters: {
            type: "object",
            properties: {
              steps: {
                type: "array",
                minItems: 1,
                maxItems: 40,
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    step: { type: "string" },
                    status: {
                      type: "string",
                      enum: ["pending", "in_progress", "completed"],
                    },
                  },
                  required: ["id", "step", "status"],
                  additionalProperties: false,
                },
              },
            },
            required: ["steps"],
            additionalProperties: false,
          },
          handler: async function ({ steps } = {}) {
            const scope = invocationScope(this.super);
            if (!scope.planId)
              return JSON.stringify({ ok: false, error: "plan_not_attached" });
            const plan = await DataAccessCenter.workspaceThreadPlan.updateSteps(
              {
                ...scope,
                steps,
              }
            );
            return JSON.stringify({
              ok: true,
              plan: DataAccessCenter.workspaceThreadPlan.publicPlan(plan),
            });
          },
        });
      },
    };
  },
};

const threadPlan = {
  name: "thread-plan",
  startupConfig: { params: {} },
  plugin: [getPlan, updatePlan],
};

module.exports = { threadPlan };
