const { requestInternalService } = require("../microModules/internalClient");

function chatRuntimeUrl(env = process.env) {
  return String(env.ATHENA_CHAT_RUNTIME_URL || env.ATHENA_CHAT_UPSTREAM || "")
    .trim()
    .replace(/\/+$/, "");
}

function remoteAgentChatPersistenceEnabled(env = process.env) {
  return (
    String(env.ATHENA_RUNTIME_ROLE || "") === "agent-runtime" &&
    Boolean(chatRuntimeUrl(env))
  );
}

async function requestAgentChatPersistence(
  { capability, path, body, idempotencyKey = null, timeoutMs = 30_000 } = {},
  env = process.env
) {
  return requestInternalService({
    callerRole: "agent-runtime",
    callerModule: "agent-runtime",
    targetModule: "chat-runtime",
    capability,
    contractVersion: "1.0",
    url: `${chatRuntimeUrl(env)}${path}`,
    method: "POST",
    body,
    idempotencyKey,
    env,
    timeoutMs,
  });
}

function reserveAgentChatTurn(input = {}, env = process.env) {
  return requestAgentChatPersistence(
    {
      capability: "chat.agent-turn.reserve",
      path: "/internal/v1/chat/agent-turns/reserve",
      body: input,
      idempotencyKey: input.clientTurnId || null,
    },
    env
  );
}

function finalizeAgentChatTurn(input = {}, env = process.env) {
  return requestAgentChatPersistence(
    {
      capability: "chat.agent-turn.finalize",
      path: "/internal/v1/chat/agent-turns/finalize",
      body: input,
      idempotencyKey:
        input.clientTurnId || `agent-chat:${input.reservationId || input.chatId}`,
      timeoutMs: Number(env.ATHENA_AGENT_CHAT_FINALIZE_TIMEOUT_MS || 60_000),
    },
    env
  );
}

module.exports = {
  chatRuntimeUrl,
  finalizeAgentChatTurn,
  remoteAgentChatPersistenceEnabled,
  reserveAgentChatTurn,
};

