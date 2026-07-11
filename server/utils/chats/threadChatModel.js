const THREAD_CHAT_MODELS = Object.freeze({
  flash: "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
});

const SUPPORTED_THREAD_CHAT_MODELS = new Set(Object.values(THREAD_CHAT_MODELS));

function isSupportedThreadChatModel(model = null) {
  return typeof model === "string" && SUPPORTED_THREAD_CHAT_MODELS.has(model);
}

function resolveThreadChatModel(workspace = null, thread = null) {
  if (isSupportedThreadChatModel(thread?.chatModel)) return thread.chatModel;
  if (isSupportedThreadChatModel(workspace?.chatModel))
    return workspace.chatModel;
  return THREAD_CHAT_MODELS.pro;
}

function workspaceWithThreadChatModel(workspace = null, thread = null) {
  return {
    ...(workspace || {}),
    chatModel: resolveThreadChatModel(workspace, thread),
  };
}

module.exports = {
  THREAD_CHAT_MODELS,
  isSupportedThreadChatModel,
  resolveThreadChatModel,
  workspaceWithThreadChatModel,
};
