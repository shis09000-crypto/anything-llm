export function resolveWorkspaceHistorySyncChatKey({
  workspaceSlug = null,
  threadSlug = null,
  getChatKey = null,
} = {}) {
  if (!workspaceSlug || typeof getChatKey !== "function") return null;
  return getChatKey(workspaceSlug, threadSlug || null);
}

const HISTORY_SYNC_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

export function historySyncRetryDelay(attempt = 0) {
  const index = Number(attempt);
  if (!Number.isInteger(index) || index < 0) return null;
  return HISTORY_SYNC_RETRY_DELAYS_MS[index] ?? null;
}
