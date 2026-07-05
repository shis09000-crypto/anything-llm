const { redactDeveloperObject } = require("./redactor");

const LOG_LIMIT = 500;
const logs = [];

function appendLog(entry = {}) {
  const safeEntry = {
    timestamp: entry.timestamp || new Date().toISOString(),
    level: entry.level || "info",
    source: entry.source || "dev-control",
    message: String(entry.message || ""),
    requestId: entry.requestId || null,
    commandId: entry.commandId || null,
    sessionId: entry.sessionId || null,
    clientId: entry.clientId || null,
    userIdHash: entry.userIdHash || null,
    scope: redactDeveloperObject(entry.scope || {}),
    metadata: redactDeveloperObject(entry.metadata || {}),
  };
  logs.push(safeEntry);
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
  return safeEntry;
}

function queryLogs({ source = null, commandId = null, limit = 100 } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 250));
  return logs
    .filter((entry) => !source || entry.source === source)
    .filter((entry) => !commandId || entry.commandId === commandId)
    .slice(-boundedLimit)
    .reverse();
}

function snapshot() {
  return {
    count: logs.length,
    recent: queryLogs({ limit: 20 }),
  };
}

module.exports = {
  appendLog,
  queryLogs,
  snapshot,
};
