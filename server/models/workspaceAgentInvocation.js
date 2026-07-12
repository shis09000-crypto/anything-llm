const prisma = require("../utils/prisma");
const { v4: uuidv4 } = require("uuid");

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
      await prisma.workspace_agent_invocations.update({
        where: { uuid: String(uuid) },
        data: { closed: true },
      });
      return true;
    } catch (error) {
      console.warn("[WorkspaceAgentInvocation] close failed", {
        uuid: String(uuid),
        message: error.message,
      });
      return false;
    }
  },

  new: async function ({
    prompt,
    workspace,
    user = null,
    thread = null,
    clientTurnId = null,
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
      const invocation = await prisma.workspace_agent_invocations.create({
        data: {
          uuid: uuidv4(),
          clientTurnId: normalizedClientTurnId,
          workspace_id: workspace.id,
          prompt: String(prompt),
          user_id: user?.id,
          thread_id: thread?.id,
        },
      });

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
      console.error(error.message);
      return { invocation: null, message: error.message, replayed: false };
    }
  },

  get: async function (clause = {}) {
    try {
      const invocation = await prisma.workspace_agent_invocations.findFirst({
        where: clause,
      });

      return invocation || null;
    } catch (error) {
      console.error(error.message);
      return null;
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
      console.error(error.message);
      return null;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.workspace_agent_invocations.delete({
        where: clause,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
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
      console.error(error.message);
      return [];
    }
  },
};

module.exports = { WorkspaceAgentInvocation };
