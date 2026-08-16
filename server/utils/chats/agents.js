const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const Workspace = lazyDataAccessFacade("workspace");
const WorkspaceAgentInvocation = lazyDataAccessFacade(
  "workspaceAgentInvocation"
);
const {
  createRemoteAgentInvocation,
  remoteAgentInvocationEnabled,
} = require("../agents/invocationClient");
const { writeResponseChunk } = require("../helpers/chat/responses");
const { enrichOperationContext } = require("../observability/operationContext");
const {
  shouldBypassAutomaticAgentRouting,
} = require("./automaticAgentRouting");

/**
 * In-memory cache for attachments associated with agent invocations.
 * Attachment payloads are stored here when grepAgents creates an invocation,
 * then retrieved by AgentHandler when the websocket connects.
 * @type {Map<string, Array>}
 */
const invocationAttachmentsCache = new Map();
const invocationFileAccessCache = new Map();
const invocationExecutionTargetCache = new Map();

/**
 * Store attachments for an invocation UUID
 * @param {string} uuid - The invocation UUID
 * @param {object} payload - Attachment payload for this invocation
 * @param {Array} payload.llmAttachments - Attachments passed to the agent model
 * @param {Array} payload.displayAttachments - Attachments stored in chat history
 * @param {string|null} payload.displayPrompt - Prompt stored in chat history
 * @param {string|null} payload.reservedPublicChatId - Public message identity reserved by the Responses Runtime
 * @param {string|null} payload.visionAnalysisContext - Vision analysis stored with chat history
 */
function cacheInvocationAttachments(
  uuid,
  {
    llmAttachments = [],
    displayAttachments = llmAttachments,
    displayPrompt = null,
    reservedPublicChatId = null,
    visionAnalysisContext = null,
  } = {}
) {
  invocationAttachmentsCache.set(uuid, {
    llmAttachments,
    displayAttachments,
    displayPrompt,
    reservedPublicChatId,
    visionAnalysisContext,
  });
}

/**
 * Retrieve and remove attachments for an invocation UUID
 * @param {string} uuid - The invocation UUID
 * @returns {{llmAttachments: Array, displayAttachments: Array, displayPrompt: string|null, visionAnalysisContext: string|null}}
 */
function getAndClearInvocationAttachments(uuid) {
  const attachments = invocationAttachmentsCache.get(uuid) || {
    llmAttachments: [],
    displayAttachments: [],
    displayPrompt: null,
    reservedPublicChatId: null,
    visionAnalysisContext: null,
  };
  invocationAttachmentsCache.delete(uuid);
  return attachments;
}

function cacheInvocationFileAccess(uuid, fileAccess = {}) {
  invocationFileAccessCache.set(uuid, fileAccess || {});
}

function getInvocationFileAccess(uuid) {
  return invocationFileAccessCache.get(uuid) || {};
}

function clearInvocationFileAccess(uuid) {
  invocationFileAccessCache.delete(uuid);
  invocationExecutionTargetCache.delete(uuid);
}

function cacheInvocationExecutionTarget(uuid, target = {}) {
  const provider = String(target?.provider || "").trim();
  const model = String(target?.model || "").trim();
  if (!provider || !model) return;
  invocationExecutionTargetCache.set(uuid, { provider, model });
}

function getInvocationExecutionTarget(uuid) {
  return invocationExecutionTargetCache.get(uuid) || null;
}

async function grepAgents({
  uuid,
  response,
  message,
  workspace,
  user = null,
  thread = null,
  attachments = [],
  displayAttachments = attachments,
  displayPrompt = null,
  visionAnalysisContext = null,
  fileAccess = {},
  clientTurnId = null,
}) {
  let nativeToolingEnabled = false;
  const agentHandles = WorkspaceAgentInvocation.parseAgents(message);

  if (
    agentHandles.length === 0 &&
    workspace?.chatMode === "automatic" &&
    shouldBypassAutomaticAgentRouting(message)
  )
    return false;

  // If the workspace is in automatic mode, check if the workspace supports native tooling
  // to determine if the agent flow should be used or not.
  if (workspace?.chatMode === "automatic")
    nativeToolingEnabled = await Workspace.supportsNativeToolCalling(workspace);

  if (agentHandles.length > 0 || nativeToolingEnabled) {
    writeResponseChunk(response, {
      id: uuid,
      type: "agentProgress",
      phase: "routing",
      status: "running",
      sequence: 1,
      details: {
        routeKind: agentHandles.length > 0 ? "explicit" : "automatic",
      },
      close: false,
    });
    const submission = {
      prompt: message,
      workspace,
      user,
      thread,
      clientTurnId,
    };
    let newInvocation = null;
    try {
      const result = remoteAgentInvocationEnabled()
        ? await createRemoteAgentInvocation(submission)
        : await WorkspaceAgentInvocation.new(submission);
      newInvocation = result?.invocation || null;
    } catch (error) {
      const errorCode = String(error?.code || "unknown")
        .replace(/[^a-zA-Z0-9_.-]/g, "_")
        .slice(0, 96);
      console.error("[AgentInvocation] submission failed", {
        errorCode,
        clientTurnId: clientTurnId || null,
      });
    }

    if (!newInvocation) {
      writeResponseChunk(response, {
        id: uuid,
        type: "agentProgress",
        phase: "routing",
        status: "failed",
        sequence: 1,
        details: { errorCode: "agent_invocation_store_unavailable" },
        close: false,
      });
      writeResponseChunk(response, {
        id: uuid,
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        animate: false,
        error: "agent_invocation_store_unavailable",
      });
      return true;
    }

    enrichOperationContext({
      invocationId: newInvocation.uuid,
      clientTurnId,
      workspaceId: workspace?.id || null,
      threadId: thread?.id || null,
      journey: "agent_tool",
    });

    writeResponseChunk(response, {
      id: uuid,
      type: "agentProgress",
      phase: "routing",
      status: "completed",
      sequence: 1,
      details: {
        routeKind: agentHandles.length > 0 ? "explicit" : "automatic",
      },
      close: false,
    });

    // Cache attachments for the websocket handler to retrieve later
    cacheInvocationAttachments(newInvocation.uuid, {
      llmAttachments: attachments,
      displayAttachments,
      displayPrompt,
      visionAnalysisContext,
    });
    cacheInvocationFileAccess(newInvocation.uuid, fileAccess);

    writeResponseChunk(response, {
      id: uuid,
      type: "agentInitWebsocketConnection",
      textResponse: null,
      sources: [],
      close: false,
      error: null,
      websocketUUID: newInvocation.uuid,
    });

    // Close HTTP stream-able chunk response method because we will swap to agents now.
    writeResponseChunk(response, {
      id: uuid,
      type: "statusResponse",
      textResponse:
        "@agent: Swapping over to agent chat. Type /exit to exit agent execution loop early.",
      sources: [],
      close: true,
      error: null,
      animate: true,
    });
    return true;
  }

  return false;
}

module.exports = {
  grepAgents,
  cacheInvocationAttachments,
  getAndClearInvocationAttachments,
  cacheInvocationFileAccess,
  getInvocationFileAccess,
  clearInvocationFileAccess,
  cacheInvocationExecutionTarget,
  getInvocationExecutionTarget,
};
