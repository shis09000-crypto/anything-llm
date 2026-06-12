export async function fetchPersistedChatHydration({
  workspaceModel,
  workspaceSlug,
  threadSlug = null,
  chatId,
} = {}) {
  if (!workspaceModel || !workspaceSlug || !chatId) {
    return { history: [], hydratedChatIds: [] };
  }

  if (threadSlug) {
    return await workspaceModel.threads.chatHistoryHydration(
      workspaceSlug,
      threadSlug,
      [chatId]
    );
  }

  return await workspaceModel.chatHistoryHydration(workspaceSlug, [chatId]);
}

export function persistedHydratedChatHistory(payload = {}, chatId = null) {
  const history = Array.isArray(payload?.history) ? payload.history : [];
  if (!chatId) return [];

  const scopedHistory = history.filter((message) => message.chatId === chatId);
  const hasAssistant = scopedHistory.some(
    (message) => message.role === "assistant"
  );
  return hasAssistant ? scopedHistory : [];
}
