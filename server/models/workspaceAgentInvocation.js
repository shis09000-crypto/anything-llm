const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const prisma = require("../utils/prisma");
const { v4: uuidv4 } = require("uuid");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");
const { emitSemanticEvent } = require("../utils/observability/semanticEvents");

function emitInvocationLifecycle(invocation, eventType, outcome = "observed") {
  if (!invocation?.uuid) return;
  emitSemanticEvent({
    eventType,
    category: "agent",
    severity: "info",
    outcome,
    subject: {
      type: "agent-invocation",
      id: invocation.uuid,
      component: "agent-runtime",
      operation: eventType.endsWith("closed") ? "close" : "start",
    },
    actor: {
      type: invocation.user_id ? "user" : "system",
      id: invocation.user_id || "system",
    },
    correlation: {
      invocationId: invocation.uuid,
      clientTurnId: invocation.clientTurnId || undefined,
    },
    stateTransition: {
      from: eventType.endsWith("closed") ? "running" : "created",
      to: eventType.endsWith("closed") ? "closed" : "running",
    },
    impact: { scope: "agent-invocation", status: outcome },
  });
}

async function agentSyncReady() {
  return SyncV2.enabled("agents") && (await SyncV2.schemaReady());
}

async function recordAgentChange(
  tx,
  { workspaceId, eventType, invocation, operation }
) {
  return await SyncV2.recordNodeChange(tx, {
    nodeKey: nodeKeys.workspaceDomain(workspaceId, "agents"),
    content: {
      invocationId: invocation.id,
      invocationUuid: invocation.uuid,
      closed: invocation.closed,
    },
    eventType,
    changedPaths: [`invocations.${invocation.id}`],
    payloadHint: {
      operation,
      invocationId: invocation.id,
      invocationUuid: invocation.uuid,
      threadId: invocation.thread_id || null,
      closed: Boolean(invocation.closed),
    },
  });
}

const WorkspaceAgentInvocation = {
  // returns array of strings with their @ handle.
  // must start with @agent for now.
  parseAgents: function (promptString) {
    if (!promptString.startsWith("@agent")) return [];
    return promptString.split(/\s+/).filter((v) => v.startsWith("@"));
  },

  close: async function (uuid) {
    if (!uuid) return false;
    try {
      if (!(await agentSyncReady())) {
        const invocation = await prisma.workspace_agent_invocations.update({
          where: { uuid: String(uuid) },
          data: { closed: true },
        });
        emitInvocationLifecycle(
          invocation,
          "agent.invocation.closed",
          "succeeded"
        );
        return true;
      }
      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.workspace_agent_invocations.findUnique({
          where: { uuid: String(uuid) },
        });
        if (existing?.closed) return { invocation: existing, changed: false };
        const invocation = await tx.workspace_agent_invocations.update({
          where: { uuid: String(uuid) },
          data: { closed: true, lastUpdatedAt: new Date() },
        });
        await recordAgentChange(tx, {
          workspaceId: invocation.workspace_id,
          eventType: "agent.invocation_closed",
          invocation,
          operation: "close",
        });
        return { invocation, changed: true };
      });
      if (result.changed)
        emitInvocationLifecycle(
          result.invocation,
          "agent.invocation.closed",
          "succeeded"
        );
      return true;
    } catch (error) {
      throwModelDataAccessError("workspaceAgentInvocation.close", error);
    }
  },

  new: async function ({
    prompt,
    workspace,
    user = null,
    thread = null,
    clientTurnId = null,
    requestedProvider = null,
    requestedModel = null,
  }) {
    try {
      const normalizedClientTurnId = String(clientTurnId || "").trim() || null;
      if (normalizedClientTurnId) {
        const existing = await prisma.workspace_agent_invocations.findFirst({
          where: {
            clientTurnId: normalizedClientTurnId,
            workspace_id: workspace.id,
            user_id: user?.id || null,
            thread_id: thread?.id || null,
          },
        });
        if (existing) {
          return { invocation: existing, message: null, replayed: true };
        }
      }
      const data = {
        uuid: uuidv4(),
        clientTurnId: normalizedClientTurnId,
        workspace_id: workspace.id,
        prompt: String(prompt),
        user_id: user?.id,
        thread_id: thread?.id,
        requestedProvider: String(requestedProvider || "").trim() || null,
        requestedModel: String(requestedModel || "").trim() || null,
      };
      const invocation = (await agentSyncReady())
        ? await prisma.$transaction(async (tx) => {
            const created = await tx.workspace_agent_invocations.create({
              data,
            });
            await recordAgentChange(tx, {
              workspaceId: workspace.id,
              eventType: "agent.invocation_created",
              invocation: created,
              operation: "append",
            });
            return created;
          })
        : await prisma.workspace_agent_invocations.create({ data });

      emitInvocationLifecycle(
        invocation,
        "agent.invocation.started",
        "accepted"
      );

      return { invocation, message: null, replayed: false };
    } catch (error) {
      if (clientTurnId && error?.code === "P2002") {
        const existing = await prisma.workspace_agent_invocations.findFirst({
          where: {
            clientTurnId: String(clientTurnId).trim(),
            workspace_id: workspace.id,
            user_id: user?.id || null,
            thread_id: thread?.id || null,
          },
        });
        if (existing) {
          return { invocation: existing, message: null, replayed: true };
        }
      }
      const errorCode = String(error?.code || "agent_invocation_store_failed")
        .slice(0, 120)
        .replace(/[^A-Za-z0-9_.:-]/g, "_");
      console.error("[AgentInvocation] persistence failed", {
        errorCode,
        fields: ["requestedProvider", "requestedModel"],
        clientTurnId: String(clientTurnId || "").slice(0, 160) || null,
      });
      return {
        invocation: null,
        message: "agent_invocation_store_unavailable",
        replayed: false,
      };
    }
  },

  get: async function (clause = {}) {
    try {
      const invocation = await prisma.workspace_agent_invocations.findFirst({
        where: clause,
      });

      return invocation || null;
    } catch (error) {
      throwModelDataAccessError("workspaceAgentInvocation.get", error);
    }
  },

  getWithWorkspace: async function (clause = {}) {
    try {
      const invocation = await prisma.workspace_agent_invocations.findFirst({
        where: clause,
        include: {
          workspace: true,
        },
      });

      return invocation || null;
    } catch (error) {
      throwModelDataAccessError(
        "workspaceAgentInvocation.getWithWorkspace",
        error
      );
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.workspace_agent_invocations.delete({
        where: clause,
      });
      return true;
    } catch (error) {
      throwModelDataAccessError("workspaceAgentInvocation.delete", error);
    }
  },

  where: async function (clause = {}, limit = null, orderBy = null) {
    try {
      const results = await prisma.workspace_agent_invocations.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return results;
    } catch (error) {
      throwModelDataAccessError("workspaceAgentInvocation.where", error);
    }
  },
};

module.exports = { WorkspaceAgentInvocation };
