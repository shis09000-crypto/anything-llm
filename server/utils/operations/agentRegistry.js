const { DataAccessCenter } = require("../dataAccess");
const { agentSkillsFromSystemSettings } = require("../agents/defaults");
const ImportedPlugin = require("../agents/imported");
const { AgentFlows } = require("../agentFlows");
const { shadowAgentDefinitions } = require("./shadowAgents/definitions");
const packageJson = require("../../package.json");
const {
  agentSignatureRequired,
  signAgentManifest,
} = require("../security/agentManifestSignature");

function safePluginIdentity(plugin = {}) {
  return {
    id: `imported:${String(plugin.hubId || plugin.name || "unknown")}`,
    name: String(plugin.name || plugin.hubId || "Imported Agent"),
    type: "imported-extension",
    version: String(plugin.version || "unversioned"),
    status: plugin.active === false ? "disabled" : "active",
    capabilities: Array.isArray(plugin.skills)
      ? plugin.skills.map(String).slice(0, 100)
      : [],
  };
}

async function agentDefinitions() {
  const [skills, imported] = await Promise.all([
    agentSkillsFromSystemSettings(null, { registryMode: true }).catch(() => []),
    Promise.resolve(ImportedPlugin.listImportedPlugins()).catch(() => []),
  ]);
  const flows = AgentFlows.activeFlowPlugins?.() || [];
  return [
    {
      id: "workspace-agent",
      name: "Athena Workspace Agent",
      type: "orchestrator",
      version: packageJson.version,
      status: "active",
      capabilities: [...new Set(skills.map(String))].sort(),
      conditionalCapabilities: [
        {
          id: "crypto-account-agent",
          origin: "built-in",
          default: true,
          conditional: true,
          approvalRequired: true,
          approvalClass: "account-private-read",
        },
      ],
    },
    ...imported.map(safePluginIdentity),
    ...flows.map((flow) => ({
      id: `flow:${String(flow)}`,
      name: String(flow),
      type: "agent-flow",
      version: packageJson.version,
      status: "active",
      capabilities: [String(flow)],
    })),
    ...shadowAgentDefinitions(),
  ];
}

async function invocationSummaries({ limit = 100 } = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 100, 500));
  const invocations = await DataAccessCenter.workspaceAgentInvocation.where(
    {},
    bounded,
    { lastUpdatedAt: "desc" }
  );
  return invocations.map((invocation) => ({
    invocationId: invocation.uuid,
    agentId: "workspace-agent",
    status: invocation.closed ? "closed" : "running",
    workspaceId: invocation.workspace_id,
    threadId: invocation.thread_id || null,
    userId: invocation.user_id || null,
    clientTurnId: invocation.clientTurnId || null,
    startedAt: invocation.createdAt,
    lastUpdatedAt: invocation.lastUpdatedAt,
  }));
}

async function agentRegistrySnapshot({ invocationLimit = 100 } = {}) {
  const [agents, invocations] = await Promise.all([
    agentDefinitions(),
    invocationSummaries({ limit: invocationLimit }),
  ]);
  const running = invocations.filter(
    (invocation) => invocation.status === "running"
  ).length;
  const snapshot = {
    generatedAt: new Date().toISOString(),
    agents,
    invocations,
    summary: {
      registered: agents.length,
      invocations: invocations.length,
      running,
      closed: invocations.length - running,
    },
  };
  try {
    return { ...snapshot, integrity: signAgentManifest(snapshot) };
  } catch (error) {
    if (agentSignatureRequired()) throw error;
    return {
      ...snapshot,
      integrity: {
        format: "athena-agent-manifest-signature:v1",
        status: "unavailable",
        reason: error.message,
      },
    };
  }
}

module.exports = {
  agentDefinitions,
  agentRegistrySnapshot,
  invocationSummaries,
  safePluginIdentity,
};
