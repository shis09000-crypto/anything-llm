const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const Workspace = lazyDataAccessFacade("workspace");
const pluralize = require("pluralize");
const WorkspaceAgentInvocation = lazyDataAccessFacade(
  "workspaceAgentInvocation"
);
const { writeResponseChunk } = require("../helpers/chat/responses");

/**
 * In-memory cache for attachments associated with agent invocations.
 * Attachment payloads are stored here when grepAgents creates an invocation,
 * then retrieved by AgentHandler when the websocket connects.
 * @type {Map<string, Array>}
 */
const invocationAttachmentsCache = new Map();
const invocationFileAccessCache = new Map();

/**
 * Store attachments for an invocation UUID
 * @param {string} uuid - The invocation UUID
 * @param {object} payload - Attachment payload for this invocation
 * @param {Array} payload.llmAttachments - Attachments passed to the agent model
 * @param {Array} payload.displayAttachments - Attachments stored in chat history
 * @param {string|null} payload.displayPrompt - Prompt stored in chat history
 * @param {string|null} payload.visionAnalysisContext - Vision analysis stored with chat history
 */
function cacheInvocationAttachments(
  uuid,
  {
    llmAttachments = [],
    displayAttachments = llmAttachments,
    displayPrompt = null,
    visionAnalysisContext = null,
  } = {}
) {
  invocationAttachmentsCache.set(uuid, {
    llmAttachments,
    displayAttachments,
    displayPrompt,
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

  // If the workspace is in automatic mode, check if the workspace supports native tooling
  // to determine if the agent flow should be used or not.
  if (workspace?.chatMode === "automatic")
    nativeToolingEnabled = await Workspace.supportsNativeToolCalling(workspace);

  const agentHandles = WorkspaceAgentInvocation.parseAgents(message);
  if (agentHandles.length > 0 || nativeToolingEnabled) {
    const { invocation: newInvocation } = await WorkspaceAgentInvocation.new({
      prompt: message,
      workspace: workspace,
      user: user,
      thread: thread,
      clientTurnId,
    });

    if (!newInvocation) {
      writeResponseChunk(response, {
        id: uuid,
        type: "statusResponse",
        textResponse: `${pluralize(
          "Agent",
          agentHandles.length
        )} ${agentHandles.join(
          ", "
        )} could not be called. Chat will be handled as default chat.`,
        sources: [],
        close: true,
        animate: false,
        error: null,
      });
      return;
    }

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
  getAndClearInvocationAttachments,
  cacheInvocationFileAccess,
  getInvocationFileAccess,
  clearInvocationFileAccess,
};
