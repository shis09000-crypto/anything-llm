const crypto = require("crypto");
const { EventLogs } = require("../../models/eventLogs");
const { appendLog } = require("./logCollector");
const { redactDeveloperObject, safeHash } = require("./redactor");

function auditUserIdHash(userId = null) {
  if (!userId) return null;
  return crypto
    .createHash("sha256")
    .update(String(userId))
    .digest("hex")
    .slice(0, 16);
}

async function recordDeveloperCommandAudit({
  event = "developer_control_command",
  level = "info",
  message = "",
  userId = null,
  clientId = null,
  sessionId = null,
  requestId = null,
  commandId = null,
  command = null,
  scope = {},
  metadata = {},
} = {}) {
  const safeMetadata = redactDeveloperObject({
    command,
    ...metadata,
  });
  const logEntry = appendLog({
    level,
    source: "developer-control",
    message,
    requestId,
    commandId,
    sessionId,
    clientId,
    userIdHash: auditUserIdHash(userId),
    scope,
    metadata: safeMetadata,
  });
  try {
    await EventLogs.logEvent(
      event,
      {
        command,
        commandId,
        requestId,
        sessionIdHash: sessionId ? safeHash(sessionId) : null,
        clientId,
        scope,
        ...safeMetadata,
      },
      userId
    );
  } catch {}
  return logEntry;
}

module.exports = {
  auditUserIdHash,
  recordDeveloperCommandAudit,
};
