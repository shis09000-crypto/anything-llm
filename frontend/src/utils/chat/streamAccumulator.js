export function createChatStreamAccumulator({
  chatKey,
  turnId,
  turn = null,
} = {}) {
  return {
    chatKey,
    turnId,
    content: turn?.finalContent || "",
    sources: turn?.sources || [],
    metrics: turn?.metrics || null,
    chatId: turn?.chatId || null,
    publicChatId: turn?.publicChatId || null,
    revision: 0,
    timer: null,
  };
}

export function applyChatStreamRevision(
  accumulator,
  event = {},
  { replace = false } = {}
) {
  const revision = Number(event.revision || 0);
  if (revision && revision < accumulator.revision) return accumulator;
  accumulator.revision = Math.max(accumulator.revision, revision);
  accumulator.content = replace
    ? String(event.content || "")
    : `${accumulator.content}${event.content || ""}`;
  accumulator.sources =
    event.sources?.length > 0 ? event.sources : accumulator.sources;
  accumulator.metrics = event.metrics || accumulator.metrics;
  accumulator.chatId = event.chatId || accumulator.chatId;
  accumulator.publicChatId = event.publicChatId || accumulator.publicChatId;
  return accumulator;
}

export function chatStreamProjectionDelay({ compact = false } = {}) {
  return compact ? 100 : 50;
}
