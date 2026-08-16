const prisma = require("../prisma");
const {
  AicpContractRegistry,
} = require("../modulePlatform/aicp/contractRegistry");
const { emitSemanticEvent } = require("../observability/semanticEvents");

const REQUIRED_FIELDS = Object.freeze(["requestedProvider", "requestedModel"]);
const REQUIRED_LINKS = Object.freeze([
  {
    callerModule: "chat-runtime",
    targetModule: "agent-runtime",
    capability: "agent.submit",
    version: "1.0",
  },
  {
    callerModule: "agent-runtime",
    targetModule: "rag",
    capability: "rag.retrieve",
    version: "1.0",
  },
  {
    callerModule: "agent-runtime",
    targetModule: "tool-runtime",
    capability: "tool.invoke",
    version: "1.0",
  },
]);

const contractState = {
  ready: false,
  status: "pending",
  reasonCode: "agent_persistence_contract_pending",
  clientFields: [],
  databaseFields: [],
  aicpLinks: [],
  checkedAt: null,
};

function generatedModelFields(prismaClient = prisma) {
  const model =
    prismaClient?._runtimeDataModel?.models?.workspace_agent_invocations ||
    prismaClient?._runtimeDataModel?.models?.WorkspaceAgentInvocation ||
    null;
  return Array.isArray(model?.fields)
    ? model.fields.map((field) => String(field?.name || "")).filter(Boolean)
    : [];
}

async function databaseModelFields(prismaClient = prisma) {
  const provider = String(prismaClient?.$databaseProvider || "").toLowerCase();
  if (provider === "postgresql") {
    const rows = await prismaClient.$queryRawUnsafe(
      `SELECT DISTINCT column_name FROM information_schema.columns WHERE table_schema = ANY(current_schemas(false)) AND table_name = $1`,
      "workspace_agent_invocations"
    );
    return rows.map((row) => String(row.column_name));
  }
  const rows = await prismaClient.$queryRawUnsafe(
    `PRAGMA table_info("workspace_agent_invocations")`
  );
  return rows.map((row) => String(row.name));
}

function negotiateRequiredLinks({
  registry = new AicpContractRegistry(),
} = {}) {
  return REQUIRED_LINKS.map((link) => {
    const result = registry.negotiate(link);
    return {
      capability: link.capability,
      targetModule: link.targetModule,
      version: result.version,
      fingerprint: result.contractFingerprint,
    };
  });
}

function missingRequiredFields(fields = []) {
  const available = new Set(fields);
  return REQUIRED_FIELDS.filter((field) => !available.has(field));
}

async function inspectAgentPersistenceContract({
  prismaClient = prisma,
  registry,
} = {}) {
  await prismaClient.$prismaReady;
  const clientFields = generatedModelFields(prismaClient);
  const missingClientFields = missingRequiredFields(clientFields);
  if (missingClientFields.length) {
    return {
      ready: false,
      status: "incompatible",
      reasonCode: "agent_persistence_contract_incompatible",
      clientFields: REQUIRED_FIELDS.filter((field) =>
        clientFields.includes(field)
      ),
      databaseFields: [],
      aicpLinks: [],
      missingFields: missingClientFields,
    };
  }

  const databaseFields = await databaseModelFields(prismaClient);
  const missingDatabaseFields = missingRequiredFields(databaseFields);
  if (missingDatabaseFields.length) {
    return {
      ready: false,
      status: "incompatible",
      reasonCode: "agent_persistence_contract_incompatible",
      clientFields: REQUIRED_FIELDS,
      databaseFields: REQUIRED_FIELDS.filter((field) =>
        databaseFields.includes(field)
      ),
      aicpLinks: [],
      missingFields: missingDatabaseFields,
    };
  }

  const aicpLinks = negotiateRequiredLinks({ registry });
  return {
    ready: true,
    status: "compatible",
    reasonCode: null,
    clientFields: REQUIRED_FIELDS,
    databaseFields: REQUIRED_FIELDS,
    aicpLinks,
    missingFields: [],
  };
}

function safeContractError(error) {
  return String(error?.code || error?.reasonCode || "contract_probe_failed")
    .slice(0, 120)
    .replace(/[^A-Za-z0-9_.:-]/g, "_");
}

async function refreshAgentPersistenceContract(options = {}) {
  try {
    Object.assign(
      contractState,
      await inspectAgentPersistenceContract(options),
      {
        checkedAt: new Date().toISOString(),
      }
    );
  } catch (error) {
    Object.assign(contractState, {
      ready: false,
      status: "incompatible",
      reasonCode: "agent_persistence_contract_incompatible",
      clientFields: [],
      databaseFields: [],
      aicpLinks: [],
      missingFields: [],
      probeErrorCode: safeContractError(error),
      checkedAt: new Date().toISOString(),
    });
  }
  emitSemanticEvent({
    eventType: contractState.ready
      ? "agent.persistence_contract_ready"
      : "agent.persistence_contract_incompatible",
    category: "agent",
    severity: contractState.ready ? "info" : "warning",
    outcome: contractState.ready ? "succeeded" : "failed",
    subject: {
      type: "runtime-contract",
      id: "workspace_agent_invocations",
      component: "agent-runtime",
      operation: "startup-probe",
    },
    impact: {
      scope: "agent-submit",
      status: contractState.status,
    },
    metadata: {
      reasonCode: contractState.reasonCode,
      missingFields: contractState.missingFields || [],
      probeErrorCode: contractState.probeErrorCode || null,
    },
    sensitivity: "metadata_only",
  });
  return agentPersistenceContractSnapshot();
}

function agentPersistenceContractSnapshot() {
  return JSON.parse(JSON.stringify(contractState));
}

module.exports = {
  REQUIRED_FIELDS,
  REQUIRED_LINKS,
  agentPersistenceContractSnapshot,
  databaseModelFields,
  generatedModelFields,
  inspectAgentPersistenceContract,
  negotiateRequiredLinks,
  refreshAgentPersistenceContract,
};
