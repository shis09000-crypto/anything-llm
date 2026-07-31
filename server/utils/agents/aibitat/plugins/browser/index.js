const { lazyDataAccessFacade } = require("../../../../dataAccess/lazyFacade");
const { safeJsonParse } = require("../../../../http");
const {
  browserPermissionDecision,
  normalizeMode,
} = require("../../../../browserPlane/policy");
const {
  browserToolBrokerEnabled,
  invokeBrowserTool,
} = require("../../../../toolRuntime/remoteClient");

const ToolInvocation = lazyDataAccessFacade("toolInvocation");
const SystemSettings = lazyDataAccessFacade("adminSystem");
const SKILL_NAME = "browser-agent";
const RESULT_POLICY = "browser/structured-observation-only";
const BROWSER_APPROVAL_CLASS = "browser-interaction";

function sessionInvocation(aibitat) {
  const invocation = aibitat.handlerProps?.invocation || {};
  const userId = Number(invocation.user_id);
  if (!invocation.uuid || !Number.isSafeInteger(userId) || userId < 1)
    throw new Error("browser_agent_owner_unavailable");
  return { invocation, userId };
}

async function domainPolicy() {
  const [authorized, denied] = await Promise.all([
    SystemSettings.getValueOrFallback(
      { label: "browser_authorized_domains" },
      "[]"
    ),
    SystemSettings.getValueOrFallback(
      { label: "browser_denied_domains" },
      "[]"
    ),
  ]);
  return {
    authorizedDomains: safeJsonParse(authorized, []).slice(0, 100),
    deniedDomains: safeJsonParse(denied, []).slice(0, 100),
  };
}

function policyAction(toolName, input = {}) {
  if (["browser_open", "browser_search"].includes(toolName)) return "navigate";
  if (["browser_read", "browser_task"].includes(toolName)) return "extract";
  if (toolName === "browser_capture") return "capture";
  if (toolName === "browser_interact") return input.action;
  if (toolName === "browser_transfer") return input.direction;
  if (toolName === "browser_workspace")
    return input.operation === "list" ? "extract" : "submit";
  if (toolName === "browser_knowledge_save") return "submit";
  return "submit";
}

function targetUrl(toolName, input = {}) {
  if (toolName === "browser_open") return input.url;
  if (toolName === "browser_search") return "https://www.bing.com/search";
  return input.url || null;
}

function publicScope(toolName, input, decision) {
  let origin = null;
  try {
    origin = targetUrl(toolName, input)
      ? new URL(targetUrl(toolName, input)).origin
      : null;
  } catch {}
  return {
    approvalClass: decision.approvalRequired
      ? BROWSER_APPROVAL_CLASS
      : "browser-automatic",
    action: policyAction(toolName, input),
    intent: input.intent || null,
    origin,
    sessionId: input.sessionId || null,
    risk: decision.risk,
  };
}

function createBrowserTool({ name, description, parameters }) {
  return {
    name,
    description,
    startupConfig: { params: {} },
    resultPolicy: RESULT_POLICY,
    plugin: function () {
      return {
        name,
        setup(aibitat) {
          aibitat.function({
            super: aibitat,
            name,
            description,
            resultPolicy: RESULT_POLICY,
            parameters: {
              $schema: "http://json-schema.org/draft-07/schema#",
              ...parameters,
            },
            handler: async function (input = {}) {
              const { invocation, userId } = sessionInvocation(this.super);
              const mode = normalizeMode(
                this.super.fileAccessPolicy?.mode || "sandbox"
              );
              const domains = await domainPolicy();
              const action = policyAction(name, input);
              const decision = browserPermissionDecision({
                mode,
                action,
                intent: input.intent || null,
                url: targetUrl(name, input),
                authorizedDomains: domains.authorizedDomains,
                administratorDeniedDomains: domains.deniedDomains,
              });
              if (!decision.allowed && !decision.approvalRequired)
                return JSON.stringify({
                  success: false,
                  error: decision.reasonCode,
                });
              const brokerArgs = {
                ...input,
                __policy: { mode, ...domains },
              };
              const scope = publicScope(name, input, decision);
              let approvalRequestId = null;
              try {
                if (decision.approvalRequired) {
                  if (typeof this.super.requestToolApproval !== "function")
                    throw new Error("browser_approval_context_unavailable");
                  const approval = await this.super.requestToolApproval({
                    skillName: name,
                    payload: scope,
                    description: `浏览器操作需要确认：${action}`,
                    forceApproval: true,
                    allowAlwaysAllow: false,
                    approvalClass: BROWSER_APPROVAL_CLASS,
                  });
                  if (!approval.approved)
                    return JSON.stringify({
                      success: false,
                      error: "browser_interaction_approval_denied",
                    });
                  approvalRequestId = approval.requestId;
                  await ToolInvocation.startExecution({
                    approvalRequestId,
                    agentInvocationId: invocation.uuid,
                    toolName: name,
                    scope,
                    args: brokerArgs,
                  });
                } else {
                  const automatic =
                    await ToolInvocation.startAutomaticExecution({
                      agentInvocationId: invocation.uuid,
                      clientTurnId: invocation.clientTurnId,
                      ownerUserId: userId,
                      toolName: name,
                      approvalClass: "browser-automatic",
                      scope,
                      args: brokerArgs,
                    });
                  approvalRequestId = automatic.approvalRequestId;
                }
                const invoke = (request) =>
                  browserToolBrokerEnabled()
                    ? invokeBrowserTool(request)
                    : require("../../../../toolRuntime/broker").dispatchBrowser(
                        request
                      );
                let result = await invoke({
                  approvalRequestId,
                  toolName: name,
                  args: brokerArgs,
                });
                if (
                  result?.status === "approval_required" &&
                  !decision.approvalRequired
                ) {
                  await ToolInvocation.completeExecution({
                    approvalRequestId,
                    result,
                  });
                  const escalationScope = {
                    ...scope,
                    risk: result.approval?.risk || "critical",
                    intent: result.approval?.intent || "irreversible",
                  };
                  const approval = await this.super.requestToolApproval({
                    skillName: name,
                    payload: escalationScope,
                    description: `浏览器检测到高风险操作，需要确认：${escalationScope.intent}`,
                    forceApproval: true,
                    allowAlwaysAllow: false,
                    approvalClass: BROWSER_APPROVAL_CLASS,
                  });
                  if (!approval.approved)
                    return JSON.stringify({
                      success: false,
                      error: "browser_interaction_approval_denied",
                    });
                  approvalRequestId = approval.requestId;
                  await ToolInvocation.startExecution({
                    approvalRequestId,
                    agentInvocationId: invocation.uuid,
                    toolName: name,
                    scope: escalationScope,
                    args: brokerArgs,
                  });
                  result = await invoke({
                    approvalRequestId,
                    toolName: name,
                    args: brokerArgs,
                  });
                }
                await ToolInvocation.completeExecution({
                  approvalRequestId,
                  result,
                });
                return JSON.stringify(result);
              } catch (error) {
                if (approvalRequestId)
                  await ToolInvocation.failExecution({
                    approvalRequestId,
                    reasonCode:
                      error.code || error.message || "browser_tool_failed",
                  }).catch(() => false);
                return JSON.stringify({
                  success: false,
                  error: String(
                    error.code || error.message || "browser_tool_failed"
                  ).slice(0, 160),
                });
              }
            },
          });
        },
      };
    },
  };
}

const sessionFields = {
  sessionId: { type: "string", description: "Existing Browser session ID." },
  tabId: { type: "string", description: "Existing Browser tab ID." },
};

const browserTools = [
  createBrowserTool({
    name: "browser_open",
    description:
      "Open a public HTTP(S) URL in Athena Browser Plane. Returns a typed browser observation; it never exposes cookies, credentials, or CDP.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        sessionId: sessionFields.sessionId,
        location: {
          type: "string",
          enum: ["cloud", "desktop"],
          default: "cloud",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  }),
  createBrowserTool({
    name: "browser_search",
    description:
      "Search the web in an Athena Browser session and return the loaded results-page observation.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        ...sessionFields,
      },
      required: ["query"],
      additionalProperties: false,
    },
  }),
  createBrowserTool({
    name: "browser_read",
    description:
      "Read visible page text from an existing Athena Browser tab as structured JSON.",
    parameters: {
      type: "object",
      properties: sessionFields,
      required: ["sessionId"],
      additionalProperties: false,
    },
  }),
  createBrowserTool({
    name: "browser_interact",
    description:
      "Interact with a Browser tab. Sandbox and authorized modes require approval for writes; payment, account-security, external-message, public-publish, and irreversible intents always require approval.",
    parameters: {
      type: "object",
      properties: {
        ...sessionFields,
        action: {
          type: "string",
          enum: ["scroll", "click", "input", "key", "submit", "fullscreen"],
        },
        arguments: { type: "object", additionalProperties: true },
        intent: {
          type: "string",
          enum: [
            "ordinary",
            "payment",
            "purchase",
            "password_change",
            "security_setting",
            "account_delete",
            "public_publish",
            "external_message",
            "irreversible",
          ],
        },
        url: { type: "string", format: "uri" },
      },
      required: ["sessionId", "action"],
      additionalProperties: false,
    },
  }),
  createBrowserTool({
    name: "browser_capture",
    description:
      "Capture the current Browser tab into an encrypted expiring artifact and return only its reference and hash.",
    parameters: {
      type: "object",
      properties: {
        ...sessionFields,
        fullPage: { type: "boolean", default: false },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  }),
  createBrowserTool({
    name: "browser_transfer",
    description:
      "Upload to or download from a Browser tab under the Browser approval and staging policies.",
    parameters: {
      type: "object",
      properties: {
        ...sessionFields,
        direction: { type: "string", enum: ["upload", "download"] },
        arguments: { type: "object", additionalProperties: true },
        intent: { type: "string", default: "ordinary" },
      },
      required: ["sessionId", "direction", "arguments"],
      additionalProperties: false,
    },
  }),
  createBrowserTool({
    name: "browser_workspace",
    description:
      "List or save a resumable Browser Workspace. Saving is governed as a write operation.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["list", "save"] },
        workspace: { type: "object", additionalProperties: true },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  }),
  createBrowserTool({
    name: "browser_knowledge_save",
    description:
      "Save the current page text into the invoking Athena workspace Knowledge index with Browser run lineage.",
    parameters: {
      type: "object",
      properties: sessionFields,
      required: ["sessionId"],
      additionalProperties: false,
    },
  }),
  createBrowserTool({
    name: "browser_task",
    description:
      "Read a Browser session or waiting-node task state without performing page interaction.",
    parameters: {
      type: "object",
      properties: sessionFields,
      required: ["sessionId"],
      additionalProperties: false,
    },
  }),
];

const browserAgent = {
  name: SKILL_NAME,
  conditional: true,
  approvalRequired: true,
  startupConfig: { params: {} },
  plugin: browserTools,
};

module.exports = {
  BROWSER_APPROVAL_CLASS,
  RESULT_POLICY,
  SKILL_NAME,
  browserAgent,
  browserTools,
};
