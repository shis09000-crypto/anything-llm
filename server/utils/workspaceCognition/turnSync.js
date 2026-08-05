const crypto = require("crypto");
const { requestInternalService } = require("../microModules");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const WorkspaceCognition = lazyDataAccessFacade("workspaceCognition");

function remoteWorkspaceCognitionEnabled(env = process.env) {
  return String(env.ATHENA_RUNTIME_ROLE || "").toLowerCase() === "chat-runtime";
}

function serializableFinalizedTurn(chat = {}) {
  return {
    id: chat.id ?? null,
    workspaceId: chat.workspaceId ?? null,
    thread_id: chat.thread_id ?? null,
    user_id: chat.user_id ?? null,
    api_session_id: chat.api_session_id ?? null,
    include: chat.include !== false,
    prompt: chat.prompt ?? "",
    response: chat.response ?? null,
    sources: chat.sources ?? [],
    created_from: chat.created_from ?? null,
    lastUpdatedAt: chat.lastUpdatedAt ?? null,
  };
}

function turnIdempotencyKey(chat, operation) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(serializableFinalizedTurn(chat)))
    .digest("hex");
  return `workspace-cognition:${operation}:${chat?.id || "unknown"}:${digest}`;
}

async function syncFinalizedWorkspaceTurn({
  chat,
  sourceChannel = "web",
  replaceEvidence = false,
  env = process.env,
  request = requestInternalService,
} = {}) {
  if (!chat?.id || !chat?.workspaceId) return null;

  if (remoteWorkspaceCognitionEnabled(env)) {
    return await request({
      callerRole: "chat-runtime",
      targetModule: "athena-api",
      capability: "workspace.cognition.turn.sync",
      contractVersion: "1.0",
      url: `${String(
        env.ATHENA_API_INTERNAL_URL || "https://anything-llm-api:3024"
      ).replace(/\/+$/, "")}/internal/v1/workspace/cognition/turn/sync`,
      body: {
        chat: serializableFinalizedTurn(chat),
        sourceChannel,
        replaceEvidence: replaceEvidence === true,
      },
      idempotencyKey: turnIdempotencyKey(
        chat,
        replaceEvidence ? "replace" : "enqueue"
      ),
      timeoutMs: 10_000,
      env,
    });
  }

  if (replaceEvidence) {
    await WorkspaceCognition.markChatEvidenceStale(
      Number(chat.workspaceId),
      [Number(chat.id)],
      "source_chat_updated"
    );
    await WorkspaceCognition.cancelBufferedChats(
      Number(chat.workspaceId),
      [Number(chat.id)],
      "chat_content_replaced"
    );
  }
  return await WorkspaceCognition.enqueueFinalizedTurn({
    chat,
    sourceChannel,
  });
}

module.exports = {
  remoteWorkspaceCognitionEnabled,
  serializableFinalizedTurn,
  syncFinalizedWorkspaceTurn,
  turnIdempotencyKey,
};
