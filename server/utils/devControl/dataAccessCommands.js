const { DataAccessCenter } = require("../dataAccess");
const { redactDeveloperObject } = require("./redactor");
const { appendLog } = require("./logCollector");

const DATA_ACCESS_COMMANDS = [
  "dataAccess.snapshot",
  "dataAccess.bypassAudit",
  "dataAccess.domain.status",
  "dataAccess.migration.dryRun",
];

function boundedLimit(value, fallback = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(500, number));
}

function snapshotParams(params = {}) {
  return {
    includeBypassAudit: params.includeBypassAudit !== false,
    bypassAuditOptions: {
      includeAllowed: params.includeAllowed === true,
      limit: boundedLimit(params.limit, 100),
    },
  };
}

function domainStatus(domain) {
  const normalized = String(domain || "").trim();
  if (!normalized || !DataAccessCenter.domains.includes(normalized)) {
    const error = new Error("DataAccess domain is not registered.");
    error.code = "data_access_domain_not_registered";
    error.status = 404;
    throw error;
  }
  const repository = DataAccessCenter.repositoryObject(normalized);
  const snapshot = DataAccessCenter.snapshot();
  return {
    domain: normalized,
    repositoryName: repository.repositoryName || null,
    dataDomain: repository.dataDomain || normalized,
    methods: Object.entries(repository)
      .filter(([, value]) => typeof value === "function")
      .map(([key]) => key)
      .sort(),
    operations: {
      total: snapshot.byDomain[normalized] || 0,
      recent: snapshot.recent.filter((entry) => entry.domain === normalized),
    },
  };
}

async function dataAccessCommand(
  command,
  { params = {}, context, scope = {} } = {}
) {
  appendLog({
    level: "info",
    source: "data-access",
    message: "Developer data access command requested.",
    commandId: context.commandId,
    requestId: context.requestId,
    sessionId: context.sessionId,
    clientId: context.clientId,
    userId: context.userId,
    scope,
    metadata: { command, params: redactDeveloperObject(params) },
  });

  switch (command) {
    case "dataAccess.snapshot":
      return redactDeveloperObject(
        DataAccessCenter.snapshot(snapshotParams(params))
      );
    case "dataAccess.bypassAudit":
      return redactDeveloperObject(
        DataAccessCenter.bypassAudit({
          includeAllowed: params.includeAllowed === true,
          limit: boundedLimit(params.limit, 150),
        })
      );
    case "dataAccess.domain.status":
      return redactDeveloperObject(
        domainStatus(params.domain || scope.domain || null)
      );
    case "dataAccess.migration.dryRun": {
      const audit = DataAccessCenter.bypassAudit({
        includeAllowed: params.includeAllowed === true,
        limit: boundedLimit(params.limit, 200),
      });
      return redactDeveloperObject({
        mode: audit.mode,
        wouldBlock: audit.blocked,
        readyForEnforce: audit.blocked === 0,
        audit,
      });
    }
    default: {
      const error = new Error("DataAccess command is not implemented.");
      error.code = "data_access_command_not_implemented";
      error.status = 404;
      throw error;
    }
  }
}

function registerDataAccessCommands(registry) {
  DATA_ACCESS_COMMANDS.forEach((command) =>
    registry.register(command, (context) => dataAccessCommand(command, context))
  );
}

module.exports = {
  DATA_ACCESS_COMMANDS,
  registerDataAccessCommands,
};
