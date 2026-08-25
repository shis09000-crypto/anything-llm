const { DataAccessCenter } = require("../../../dataAccess");

function invocationScope(aibitat) {
  const invocation = aibitat.handlerProps?.invocation || {};
  return {
    goalId: invocation.goalId,
    clientTurnId: invocation.clientTurnId,
    workspace:
      invocation.workspace ||
      (invocation.workspace_id ? { id: invocation.workspace_id } : null),
    thread: invocation.thread_id ? { id: invocation.thread_id } : null,
    user: invocation.user_id ? { id: invocation.user_id } : null,
  };
}

const getGoal = {
  name: "get_goal",
  startupConfig: { params: {} },
  plugin() {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: "get_goal",
          description:
            "Read the active persistent goal attached to this thread.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          handler: async function () {
            const scope = invocationScope(this.super);
            if (!scope.goalId) return JSON.stringify({ goal: null });
            const goal =
              await DataAccessCenter.workspaceThreadGoal.getScoped(scope);
            return JSON.stringify({
              goal: DataAccessCenter.workspaceThreadGoal.publicGoal(goal),
            });
          },
        });
      },
    };
  },
};

const updateGoal = {
  name: "update_goal",
  startupConfig: { params: {} },
  plugin() {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: "update_goal",
          description:
            "Stage completion or blocking of the active goal. It is committed only after response.completed.",
          parameters: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["completed", "blocked"] },
            },
            required: ["status"],
            additionalProperties: false,
          },
          handler: async function ({ status } = {}) {
            const scope = invocationScope(this.super);
            if (!scope.goalId || !["completed", "blocked"].includes(status))
              return JSON.stringify({
                ok: false,
                error: "goal_update_invalid",
              });
            await DataAccessCenter.workspaceThreadGoal.stageStatus({
              ...scope,
              status,
            });
            return JSON.stringify({ ok: true, status: `pending_${status}` });
          },
        });
      },
    };
  },
};

const threadGoal = {
  name: "thread-goal",
  startupConfig: { params: {} },
  plugin: [getGoal, updateGoal],
};

module.exports = { threadGoal };
