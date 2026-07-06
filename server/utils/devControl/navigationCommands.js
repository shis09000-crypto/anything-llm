const { publishBroadcastEvent, broadcastCenter } = require("../broadcast");
const { redactDeveloperObject } = require("./redactor");
const { appendLog } = require("./logCollector");

const NAVIGATION_COMMANDS = [
  "navigation.snapshot",
  "navigation.ui.snapshot",
  "navigation.ui.goto",
  "navigation.ui.back",
  "navigation.ui.forward",
  "navigation.ui.reload",
  "navigation.ui.openChat",
  "navigation.ui.openSettings",
  "navigation.ui.openCrypto",
  "navigation.ui.enableObserver",
  "navigation.test.roundTrip",
];

function normalizeScope(scope = {}) {
  return {
    clientId: scope.clientId || null,
    workspaceSlug: scope.workspaceSlug || null,
    threadSlug: scope.threadSlug || null,
    route: scope.route || null,
  };
}

function assertLocalPath(path, { prefix = null } = {}) {
  const value = String(path || "");
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    const error = new Error("Navigation command requires a local app path.");
    error.code = "developer_navigation_invalid_path";
    error.status = 400;
    throw error;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const error = new Error("Navigation command rejected an external path.");
    error.code = "developer_navigation_external_path";
    error.status = 400;
    throw error;
  }
  if (prefix && !value.startsWith(prefix)) {
    const error = new Error("Navigation command path is outside allowlist.");
    error.code = "developer_navigation_path_not_allowed";
    error.status = 400;
    throw error;
  }
  if (
    /(?:^|[?&])(?:token|auth|authorization|access_token|refresh_token|secret|key|apikey|api_key|signature|signingSecret|signing_secret|sensitiveSession|sensitive_session)=/i.test(
      value
    )
  ) {
    const error = new Error(
      "Navigation command path contains sensitive query."
    );
    error.code = "developer_navigation_sensitive_query";
    error.status = 400;
    throw error;
  }
  return value;
}

function chatPathFrom({ scope = {}, params = {} } = {}) {
  if (params.path) {
    return assertLocalPath(params.path, { prefix: "/workspace" });
  }
  const workspaceSlug = params.workspaceSlug || scope.workspaceSlug;
  const threadSlug = params.threadSlug || scope.threadSlug;
  if (!workspaceSlug) {
    const error = new Error("Navigation chat command requires workspaceSlug.");
    error.code = "developer_navigation_missing_workspace";
    error.status = 400;
    throw error;
  }
  const base = `/workspace/${encodeURIComponent(workspaceSlug)}`;
  return threadSlug ? `${base}/t/${encodeURIComponent(threadSlug)}` : base;
}

function settingsPathFrom(params = {}) {
  if (!params.path) return "/settings/interface";
  const path = assertLocalPath(params.path);
  if (path.startsWith("/settings") || path.includes("/settings")) return path;
  const error = new Error("Navigation settings command path is not allowed.");
  error.code = "developer_navigation_settings_path_not_allowed";
  error.status = 400;
  throw error;
}

function commandPayload({ command, params = {}, scope = {} }) {
  switch (command) {
    case "navigation.ui.goto":
      return {
        command,
        params: {
          ...params,
          path: assertLocalPath(params.path),
        },
      };
    case "navigation.ui.openChat":
      return {
        command,
        params: {
          ...params,
          path: chatPathFrom({ scope, params }),
        },
      };
    case "navigation.ui.openSettings":
      return {
        command,
        params: {
          ...params,
          path: settingsPathFrom(params),
        },
      };
    case "navigation.ui.openCrypto":
      return {
        command,
        params: {
          ...params,
          path: "/settings/crypto-center",
        },
      };
    case "navigation.test.roundTrip": {
      const toPath = assertLocalPath(params.toPath || params.path);
      const fromPath = params.fromPath
        ? assertLocalPath(params.fromPath)
        : null;
      return {
        command,
        params: {
          ...params,
          toPath,
          fromPath,
          backDelayMs: Math.max(
            0,
            Math.min(10_000, Number(params.backDelayMs) || 650)
          ),
          settleMs: Math.max(
            50,
            Math.min(10_000, Number(params.settleMs) || 900)
          ),
        },
      };
    }
    default:
      return { command, params };
  }
}

function publishNavigationCommand({
  context,
  command,
  params = {},
  scope = {},
}) {
  const clientId = scope.clientId || context.clientId;
  const normalized = commandPayload({ command, params, scope });
  const event = publishBroadcastEvent(
    {
      namespace: "developerControl",
      type: "navigationCommand",
      eventPriority: "critical",
      visibility: "client",
      scope: { userId: context.userId, clientId },
      sourceClientId: context.clientId,
      sourceRequestId: context.requestId,
      resource: {
        kind: "developer-control-navigation-command",
        id: context.commandId,
      },
      payload: {
        center: "developer-control",
        command: normalized.command,
        commandId: context.commandId,
        requestId: context.requestId,
        scope: normalizeScope(scope),
        params: normalized.params,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    { coalesce: false }
  );
  appendLog({
    level: "info",
    source: "navigation",
    message: "Developer navigation command published.",
    commandId: context.commandId,
    requestId: context.requestId,
    sessionId: context.sessionId,
    clientId,
    userId: context.userId,
    scope,
    metadata: {
      command: normalized.command,
      params: redactDeveloperObject(normalized.params),
      eventId: event?.eventId || null,
    },
  });
  return {
    deliveredEventId: event?.eventId || null,
    clientId,
    command: normalized.command,
    params: redactDeveloperObject(normalized.params),
    connections: broadcastCenter.snapshot().connections,
  };
}

async function navigationCommand(
  command,
  { scope = {}, params = {}, context }
) {
  if (command === "navigation.snapshot") {
    return {
      server: {
        broadcast: broadcastCenter.snapshot(),
      },
      uiCommand: publishNavigationCommand({
        context,
        command: "navigation.ui.snapshot",
        params,
        scope,
      }),
    };
  }
  return {
    uiCommand: true,
    ...publishNavigationCommand({ context, command, params, scope }),
  };
}

function registerNavigationCommands(registry) {
  NAVIGATION_COMMANDS.forEach((command) =>
    registry.register(command, (context) => navigationCommand(command, context))
  );
}

module.exports = {
  NAVIGATION_COMMANDS,
  assertLocalPath,
  registerNavigationCommands,
};
