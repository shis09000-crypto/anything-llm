const crypto = require("crypto");
const { CommandRegistry } = require("./commandRegistry");
const { registerReaderCommands } = require("./readerCommands");
const { registerNavigationCommands } = require("./navigationCommands");
const { registerDataAccessCommands } = require("./dataAccessCommands");
const { recordDeveloperCommandAudit } = require("./commandAudit");
const { redactDeveloperObject } = require("./redactor");

const registry = new CommandRegistry();
registerReaderCommands(registry);
registerNavigationCommands(registry);
registerDataAccessCommands(registry);

function commandId() {
  return `cmd_${crypto.randomUUID()}`;
}

async function executeDeveloperCommand({
  request,
  response,
  session,
  body = {},
  clientId = null,
  userId = null,
} = {}) {
  const id = commandId();
  const context = {
    request,
    response,
    commandId: id,
    command: body.command,
    requestId: body.requestId,
    sessionId: session.sessionId,
    clientId,
    userId,
  };
  await recordDeveloperCommandAudit({
    event: "developer_control_command_started",
    message: "Developer command started.",
    userId,
    clientId,
    sessionId: session.sessionId,
    requestId: body.requestId,
    commandId: id,
    command: body.command,
    scope: body.scope,
  });
  try {
    const result = await registry.execute(body.command, {
      request,
      response,
      scope: body.scope || {},
      params: body.params || {},
      context,
    });
    await recordDeveloperCommandAudit({
      event: "developer_control_command_completed",
      message: "Developer command completed.",
      userId,
      clientId,
      sessionId: session.sessionId,
      requestId: body.requestId,
      commandId: id,
      command: body.command,
      scope: body.scope,
      metadata: { status: "completed" },
    });
    return {
      success: true,
      commandId: id,
      status: "completed",
      summary: redactDeveloperObject(result || {}),
    };
  } catch (error) {
    await recordDeveloperCommandAudit({
      event: "developer_control_command_failed",
      level: "error",
      message: error.message || "Developer command failed.",
      userId,
      clientId,
      sessionId: session.sessionId,
      requestId: body.requestId,
      commandId: id,
      command: body.command,
      scope: body.scope,
      metadata: { code: error.code || null, status: error.status || 500 },
    });
    return {
      success: false,
      commandId: id,
      code: error.code || "developer_command_failed",
      message: error.message || "Developer command failed.",
      status: error.status || 500,
    };
  }
}

module.exports = {
  executeDeveloperCommand,
  registry,
};
