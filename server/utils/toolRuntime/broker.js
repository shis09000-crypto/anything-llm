const { DataAccessCenter } = require("../dataAccess");
const { requestInternalService } = require("../microModules/internalClient");
const { issueInvocationCredential } = require("../plugins/capabilityBroker");
const {
  ACCOUNT_PRIVATE_APPROVAL_CLASS,
  accountPrivateCapabilityManifest,
  accountPrivateInvocationSubject,
} = require("../modulePlatform/toolInvocationContract");
const { dispatchBrowserPlane } = require("../browserPlane/planeClient");
const { browserPermissionDecision } = require("../browserPlane/policy");
const {
  dispatchLocalRuntime: dispatchLocalRuntimeCenter,
} = require("../localRuntime/client");

const CRYPTO_ACCOUNT_TOOLS = new Set([
  "crypto_account_overview",
  "crypto_account_holdings",
  "crypto_account_positions",
  "crypto_account_activity",
  "crypto_portfolio_overview",
  "crypto_portfolio_risk",
]);
const BROWSER_TOOLS = new Set([
  "browser_open",
  "browser_search",
  "browser_read",
  "browser_interact",
  "browser_capture",
  "browser_transfer",
  "browser_workspace",
  "browser_knowledge_save",
  "browser_task",
]);
const BROWSER_APPROVAL_CLASS = "browser-interaction";
const LOCAL_RUNTIME_TOOLS = new Set([
  "local_device_status",
  "local_desktop_observe",
  "local_desktop_act",
  "local_file_read",
  "local_file_write",
  "local_command_run",
  "local_job_cancel",
]);

function normalizedBaseUrl(value, fallback) {
  return String(value || fallback).replace(/\/+$/, "");
}

function cryptoAccountServiceUrl(env = process.env) {
  return normalizedBaseUrl(
    env.ATHENA_CRYPTO_ACCOUNT_URL,
    "https://crypto-account:3021"
  );
}

async function dispatchCryptoAccount({
  approvalRequestId,
  toolName,
  args = {},
  env = process.env,
} = {}) {
  const tool = String(toolName || "").trim();
  if (!CRYPTO_ACCOUNT_TOOLS.has(tool)) {
    const error = new Error("tool_broker_crypto_account_tool_denied");
    error.code = "tool_broker_crypto_account_tool_denied";
    error.httpStatus = 400;
    throw error;
  }
  const context = await DataAccessCenter.toolInvocation.executionContext({
    approvalRequestId,
    toolName: tool,
    args,
    approvalClass: ACCOUNT_PRIVATE_APPROVAL_CLASS,
  });
  const manifest = accountPrivateCapabilityManifest(context);
  const credential = issueInvocationCredential({
    serviceIdentity: "crypto-account",
    tool,
    args,
    manifest,
    subject: accountPrivateInvocationSubject(context),
    requireHybrid: true,
    env,
  });
  const response = await requestInternalService({
    callerRole: "tool-broker",
    callerModule: "tool-runtime",
    targetModule: "crypto-account-access",
    capability: "crypto.account",
    contractVersion: "1.0",
    url: `${cryptoAccountServiceUrl(env)}/internal/v1/crypto/account/read`,
    body: {
      approvalRequestId: context.approvalRequestId,
      toolName: tool,
      args,
      manifest,
      credential,
    },
    idempotencyKey: context.id,
    env,
    timeoutMs: Number(env.ATHENA_TOOL_INVOCATION_TIMEOUT_MS || 120_000),
  });
  return response.result;
}

async function browserSession(context, args = {}) {
  if (args.sessionId)
    return dispatchBrowserPlane("session", {
      userId: context.ownerUserId,
      sessionId: args.sessionId,
    });
  return dispatchBrowserPlane("createSession", {
    userId: context.ownerUserId,
    location: args.location === "desktop" ? "desktop" : "cloud",
    requestedProfileId: args.profileId || "default",
    viewport: args.viewport || null,
  });
}

function actionInput(toolName, args = {}) {
  if (toolName === "browser_open")
    return { action: "navigate", arguments: { url: args.url } };
  if (toolName === "browser_search")
    return {
      action: "navigate",
      arguments: {
        url: `https://www.bing.com/search?q=${encodeURIComponent(String(args.query || ""))}`,
      },
    };
  if (toolName === "browser_read") return { action: "extract", arguments: {} };
  if (toolName === "browser_capture")
    return {
      action: "capture",
      arguments: { fullPage: Boolean(args.fullPage), persistArtifact: true },
    };
  if (toolName === "browser_interact")
    return {
      action: String(args.action || ""),
      arguments: args.arguments || {},
    };
  if (toolName === "browser_transfer")
    return {
      action: String(args.direction || ""),
      arguments: args.arguments || {},
    };
  return null;
}

function policyActionForTool(toolName, args = {}) {
  if (toolName === "browser_workspace")
    return args.operation === "list" ? "extract" : "submit";
  if (toolName === "browser_knowledge_save") return "submit";
  if (toolName === "browser_task") return "extract";
  return "submit";
}

async function saveBrowserPageToKnowledge(context, session, args, env) {
  const extracted = await dispatchBrowserPlane("action", {
    userId: context.ownerUserId,
    sessionId: session.id,
    tabId: args.tabId || null,
    action: "extract",
    arguments: {},
    actorType: "agent",
    mode: args.__policy.mode,
    authorizedDomains: args.__policy.authorizedDomains,
    deniedDomains: args.__policy.deniedDomains,
    approvalGranted: true,
    approvalRequestId: context.approvalRequestId,
    idempotencyKey: `${context.id}:extract`,
  });
  const text = String(extracted?.observation?.text || "").trim();
  if (!text) throw new Error("browser_knowledge_source_empty");
  const baseUrl = normalizedBaseUrl(
    env.ATHENA_KNOWLEDGE_INGEST_URL,
    "https://anything-llm-knowledge-ingest:3027"
  );
  const response = await requestInternalService({
    callerRole: "tool-broker",
    callerModule: "tool-runtime",
    targetModule: "knowledge-ingest",
    capability: "knowledge.ingest",
    contractVersion: "1.0",
    url: `${baseUrl}/internal/v1/knowledge/browser-ingest`,
    body: {
      workspaceId: context.workspaceId,
      userId: context.ownerUserId,
      textContent: text,
      metadata: {
        title: extracted.observation?.title || "Browser capture",
        sourceUrl: extracted.observation?.url || null,
        browserRunId: extracted.runId,
        browserResultSha256: extracted.resultSha256,
      },
    },
    idempotencyKey: context.id,
    env,
    timeoutMs: Number(env.ATHENA_TOOL_INVOCATION_TIMEOUT_MS || 120_000),
  });
  return {
    schemaVersion: "athena.browser.result.v1",
    status: "completed",
    action: "knowledge_save",
    sessionId: session.id,
    tabId: extracted.tabId,
    knowledge: response.result,
    lineage: [{ runId: extracted.runId, resultSha256: extracted.resultSha256 }],
  };
}

async function dispatchBrowser({
  approvalRequestId,
  toolName,
  args = {},
  env = process.env,
} = {}) {
  const tool = String(toolName || "").trim();
  if (!BROWSER_TOOLS.has(tool))
    throw Object.assign(new Error("tool_broker_browser_tool_denied"), {
      code: "tool_broker_browser_tool_denied",
      httpStatus: 400,
    });
  const context = await DataAccessCenter.toolInvocation.executionContext({
    approvalRequestId,
    toolName: tool,
    args,
  });
  const policy = args.__policy || {};
  const requestedPermission = browserPermissionDecision({
    mode: policy.mode,
    action: actionInput(tool, args)?.action || policyActionForTool(tool, args),
    intent: args.intent,
    url: actionInput(tool, args)?.arguments?.url || null,
    authorizedDomains: policy.authorizedDomains || [],
    administratorDeniedDomains: policy.deniedDomains || [],
  });
  if (
    requestedPermission.approvalRequired &&
    context.approvalClass !== BROWSER_APPROVAL_CLASS
  )
    throw Object.assign(new Error("browser_interaction_approval_missing"), {
      code: "browser_interaction_approval_missing",
      httpStatus: 403,
    });
  if (tool === "browser_workspace") {
    if (args.operation === "list")
      return dispatchBrowserPlane("listWorkspaces", {
        userId: context.ownerUserId,
      });
    return dispatchBrowserPlane("saveWorkspace", {
      userId: context.ownerUserId,
      input: args.workspace || {},
    });
  }
  const session = await browserSession(context, args);
  if (tool === "browser_task") return session;
  if (session.executionLocation === "desktop" && session.status !== "active")
    return {
      schemaVersion: "athena.browser.result.v1",
      status: "waiting_for_browser_node",
      sessionId: session.id,
      driver: session.driver,
    };
  if (tool === "browser_knowledge_save")
    return saveBrowserPageToKnowledge(context, session, args, env);
  const requested = actionInput(tool, args);
  if (!requested) throw new Error("browser_tool_action_missing");
  return dispatchBrowserPlane("action", {
    userId: context.ownerUserId,
    sessionId: session.id,
    tabId: args.tabId || null,
    ...requested,
    actorType: "agent",
    mode: policy.mode,
    intent: args.intent || null,
    authorizedDomains: policy.authorizedDomains || [],
    deniedDomains: policy.deniedDomains || [],
    approvalRequestId: context.approvalRequestId,
    approvalGranted: context.approvalClass === BROWSER_APPROVAL_CLASS,
    idempotencyKey: context.id,
  });
}

async function dispatchLocalRuntime({
  approvalRequestId,
  toolName,
  args = {},
  env = process.env,
} = {}) {
  const tool = String(toolName || "").trim();
  if (!LOCAL_RUNTIME_TOOLS.has(tool))
    throw Object.assign(new Error("tool_broker_local_runtime_tool_denied"), {
      code: "tool_broker_local_runtime_tool_denied",
      httpStatus: 400,
    });
  const context = await DataAccessCenter.toolInvocation.executionContext({
    approvalRequestId,
    toolName: tool,
    args,
  });
  if (tool === "local_job_cancel")
    return dispatchLocalRuntimeCenter(
      "cancel",
      { ownerUserId: context.ownerUserId, jobId: args.jobId },
      { env, idempotencyKey: context.id }
    );
  return dispatchLocalRuntimeCenter(
    "dispatch",
    {
      ownerUserId: context.ownerUserId,
      ownerAuthUserId: context.ownerAuthUserId,
      deviceId: args.deviceId,
      toolName: tool,
      args,
      responseId: context.responseId || context.scope?.responseId || null,
      toolInvocationId: context.id,
      priority: context.scope?.priority || "P2",
      idempotencyKey: context.id,
      executionMode: args.background === true ? "background" : "interactive",
      stepUpApproved: context.approvalClass === "local-runtime-step-up",
    },
    { env, idempotencyKey: context.id, timeoutMs: 610_000 }
  );
}

module.exports = {
  CRYPTO_ACCOUNT_TOOLS,
  BROWSER_APPROVAL_CLASS,
  BROWSER_TOOLS,
  LOCAL_RUNTIME_TOOLS,
  cryptoAccountServiceUrl,
  dispatchBrowser,
  dispatchLocalRuntime,
  dispatchCryptoAccount,
};
