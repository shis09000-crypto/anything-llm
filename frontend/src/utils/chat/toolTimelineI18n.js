const EXACT_TOOL_KEYS = new Set([
  "rag-memory",
  "document-ingest-agent",
  "document-summarizer",
  "web-browsing",
  "web-scraping",
  "chat-history",
  "file-history",
  "shell-agent",
  "create-chart",
  "sql-agent",
]);

const PREFIX_TOOL_KEYS = [
  ["filesystem-", "filesystem"],
  ["create-", "create"],
  ["gmail-", "gmail"],
  ["outlook-", "outlook"],
  ["gcal-", "gcal"],
  ["sql-", "sql"],
];

const ACTION_KEYS = new Set([
  "search",
  "store",
  "read",
  "write",
  "create",
  "update",
  "delete",
  "list",
  "get",
  "send",
  "reply",
  "move",
  "mark",
  "query",
]);

function translate(t, key, fallback, options = {}) {
  return t(key, { defaultValue: fallback, ...options });
}

export function displayToolName(toolName, t) {
  const rawToolName = String(toolName || "").trim();
  if (!rawToolName)
    return translate(t, "chat_window.toolTimeline.toolFallback", "tool");

  if (EXACT_TOOL_KEYS.has(rawToolName)) {
    return translate(
      t,
      `chat_window.toolTimeline.tools.${rawToolName}`,
      rawToolName
    );
  }

  const family = PREFIX_TOOL_KEYS.find(([prefix]) =>
    rawToolName.startsWith(prefix)
  );
  if (!family) return rawToolName;

  const [, familyKey] = family;
  return translate(
    t,
    "chat_window.toolTimeline.toolFamilyLabel",
    "{{family}} ({{toolName}})",
    {
      family: translate(
        t,
        `chat_window.toolTimeline.toolFamilies.${familyKey}`,
        familyKey
      ),
      toolName: rawToolName,
    }
  );
}

export function displayActionName(action, t) {
  const rawAction = String(action || "").trim();
  if (!rawAction || !ACTION_KEYS.has(rawAction)) return rawAction;
  return translate(
    t,
    `chat_window.toolTimeline.actions.${rawAction}`,
    rawAction
  );
}

export function formatToolStatus(event = {}, t) {
  const status = String(event.status || "").toLowerCase();
  const exitCode = Number(event.exitCode);
  const isError =
    event.type === "tool_result" &&
    (status.includes("error") ||
      status.includes("fail") ||
      !!event.error ||
      !!event.errorMessage ||
      !!event.storageError ||
      event.timedOut === true ||
      event.isError === true ||
      (event.exitCode !== undefined &&
        !Number.isNaN(exitCode) &&
        exitCode !== 0));

  if (event.type === "tool_call")
    return translate(t, "chat_window.toolTimeline.status.calling", "Calling");
  if (isError)
    return translate(t, "chat_window.toolTimeline.status.errored", "Errored");
  if (event.type === "tool_result")
    return translate(t, "chat_window.toolTimeline.status.returned", "Returned");
  if (event.type === "running")
    return translate(
      t,
      "chat_window.toolTimeline.status.working",
      "Working..."
    );
  return translate(t, "chat_window.toolTimeline.status.finished", "Finished.");
}

function actionFromJsonText(text = "") {
  const match = String(text).match(/"action"\s*:\s*"([^"]+)"/);
  return match?.[1] || null;
}

function actionPrefix(text, t) {
  const action = actionFromJsonText(text);
  const localizedAction = displayActionName(action, t);
  if (!localizedAction || localizedAction === action) return "";

  return translate(
    t,
    "chat_window.toolTimeline.actionPrefix",
    "Action: {{action}} · ",
    {
      action: localizedAction,
    }
  );
}

function formatArgs(args = "", t) {
  const rawArgs = String(args || "").trim();
  if (!rawArgs) return "";
  return `${actionPrefix(rawArgs, t)}${rawArgs}`;
}

function templateKeyForToolCallPrefix(prefix = "") {
  const normalized = prefix.toLowerCase();
  if (normalized.startsWith("parsed")) return "parsedToolCall";
  if (normalized === "tool call") return "toolCall";
  return "assemblingToolCall";
}

export function formatTimelineContent(content, t) {
  const text = String(content || "").trim();
  if (!text) return "";

  const toolCall = text.match(
    /^(Assembling Tool Call|Parsed Tool Call|Tool Call):\s*([^(]+)\(([\s\S]*)\)$/
  );
  if (toolCall) {
    const [, prefix, toolName, args] = toolCall;
    return translate(
      t,
      `chat_window.toolTimeline.templates.${templateKeyForToolCallPrefix(prefix)}`,
      "{{tool}}: {{args}}",
      {
        tool: displayToolName(toolName, t),
        args: formatArgs(args, t),
      }
    );
  }

  const executingTool = text.match(
    /^@agent is executing `([^`]+)` tool(?:\s+([\s\S]+))?$/
  );
  if (executingTool) {
    const [, toolName, args = ""] = executingTool;
    return translate(
      t,
      "chat_window.toolTimeline.templates.executingTool",
      "@agent is executing {{tool}} tool {{args}}",
      {
        tool: displayToolName(toolName, t),
        args: formatArgs(args, t),
      }
    );
  }

  const contextFound = text.match(
    /^@agent: Found (\d+) additional piece of context to help answer this question\.$/
  );
  if (contextFound) {
    return translate(
      t,
      "chat_window.toolTimeline.templates.contextFound",
      "@agent found {{count}} additional context item(s).",
      { count: Number(contextFound[1]) }
    );
  }

  const returnedTool = text.match(/^Tool ([^.\s][^.]*) returned a result\.$/);
  if (returnedTool) {
    return translate(
      t,
      "chat_window.toolTimeline.templates.toolReturned",
      "{{tool}} returned a result.",
      {
        tool: displayToolName(returnedTool[1], t),
      }
    );
  }

  const callingTool = text.match(/^Calling ([^.\s][^.]*)\.\.\.$/);
  if (callingTool) {
    return translate(
      t,
      "chat_window.toolTimeline.templates.callingTool",
      "Calling {{tool}}...",
      {
        tool: displayToolName(callingTool[1], t),
      }
    );
  }

  return text;
}

export function formatToolPayloadPreview(payload, t) {
  const text = String(payload || "").trim();
  if (!text) return "";
  return `${actionPrefix(text, t)}${formatTimelineContent(text, t)}`;
}
