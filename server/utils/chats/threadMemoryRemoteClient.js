const {
  distributedTopology,
  requestInternalService,
} = require("../microModules");

function chatRuntimeUrl(env = process.env) {
  return String(env.ATHENA_CHAT_RUNTIME_URL || env.ATHENA_CHAT_UPSTREAM || "")
    .trim()
    .replace(/\/$/, "");
}

function remoteThreadMemoryEnabled(env = process.env) {
  return (
    distributedTopology(env) &&
    String(env.ATHENA_RUNTIME_ROLE || "api") !== "chat-runtime" &&
    Boolean(chatRuntimeUrl(env))
  );
}

function requestThreadMemoryCapability({
  capability,
  path,
  body,
  timeoutMs,
  idempotencyKey = null,
  env = process.env,
} = {}) {
  return requestInternalService({
    callerRole: String(env.ATHENA_RUNTIME_ROLE || "api"),
    callerModule: "athena-api",
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

async function remoteThreadMemoryStatus(input = {}, env = process.env) {
  return requestThreadMemoryCapability({
    capability: "chat.memory.status",
    path: "/internal/v1/chat/memory/status",
    body: input,
    timeoutMs: Number(env.ATHENA_THREAD_MEMORY_STATUS_TIMEOUT_MS || 10_000),
    env,
  });
}

async function remoteThreadMemoryCompact(input = {}, env = process.env) {
  return requestThreadMemoryCapability({
    capability: "chat.memory.compact",
    path: "/internal/v1/chat/memory/compact",
    body: input,
    idempotencyKey: input.sourceActionId || null,
    timeoutMs: Number(env.ATHENA_THREAD_MEMORY_COMPACT_TIMEOUT_MS || 300_000),
    env,
  });
}

async function remoteThreadMemoryContextResolve(input = {}, env = process.env) {
  return requestThreadMemoryCapability({
    capability: "chat.memory.context.resolve",
    path: "/internal/v1/chat/memory/context/resolve",
    body: input,
    timeoutMs: Number(env.ATHENA_THREAD_MEMORY_CONTEXT_TIMEOUT_MS || 15_000),
    env,
  });
}

module.exports = {
  remoteThreadMemoryCompact,
  remoteThreadMemoryContextResolve,
  remoteThreadMemoryEnabled,
  remoteThreadMemoryStatus,
};
