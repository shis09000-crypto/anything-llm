export const CHAT_SCROLL_MEMORY_STORAGE_KEY =
  "anythingllm_chat_scroll_memory_v1";
export const CHAT_FOLD_MEMORY_STORAGE_KEY = "anythingllm_chat_fold_memory_v1";
export const CHAT_SCROLL_MEMORY_MAX_THREADS = 80;
export const CHAT_SCROLL_MEMORY_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 90;
export const CHAT_SCROLL_MEMORY_OLDER_PAGE_LIMIT = 8;

function nowMs() {
  return Date.now();
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value ?? "");
  } catch {
    return fallback;
  }
}

function storageGet(key) {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeInnerAnchor(innerAnchor = null) {
  if (!innerAnchor || typeof innerAnchor !== "object") return null;
  const blockIndex = Number(innerAnchor.blockIndex);
  if (!Number.isFinite(blockIndex) || blockIndex < 0) return null;
  return {
    blockIndex,
    offsetTop: finiteNumber(innerAnchor.offsetTop, 0),
    textFingerprint: innerAnchor.textFingerprint
      ? String(innerAnchor.textFingerprint)
      : null,
  };
}

export function normalizeChatScrollMemoryEntry(entry = null, at = nowMs()) {
  if (!entry || typeof entry !== "object" || !entry.chatKey) return null;
  const savedAt = finiteNumber(entry.savedAt, 0);
  if (!savedAt || at - savedAt > CHAT_SCROLL_MEMORY_MAX_AGE_MS) return null;

  return {
    chatKey: String(entry.chatKey),
    itemId: entry.itemId ? String(entry.itemId) : null,
    chatId:
      entry.chatId === null || entry.chatId === undefined
        ? null
        : finiteNumber(entry.chatId, null),
    role: entry.role ? String(entry.role) : null,
    innerAnchor: normalizeInnerAnchor(entry.innerAnchor),
    rowOffsetTop: finiteNumber(entry.rowOffsetTop, 0),
    scrollTop: finiteNumber(entry.scrollTop, 0),
    isAtBottom: Boolean(entry.isAtBottom),
    firstItemId: entry.firstItemId ? String(entry.firstItemId) : null,
    lastItemId: entry.lastItemId ? String(entry.lastItemId) : null,
    savedAt,
  };
}

export function pruneChatScrollMemoryMap(
  map = {},
  { at = nowMs(), maxThreads = CHAT_SCROLL_MEMORY_MAX_THREADS } = {}
) {
  return Object.fromEntries(
    Object.entries(map || {})
      .map(([chatKey, entry]) => [
        chatKey,
        normalizeChatScrollMemoryEntry(entry, at),
      ])
      .filter(([, entry]) => !!entry)
      .sort(([, a], [, b]) => b.savedAt - a.savedAt)
      .slice(0, maxThreads)
  );
}

export function readChatScrollMemoryMap() {
  return pruneChatScrollMemoryMap(
    safeJson(storageGet(CHAT_SCROLL_MEMORY_STORAGE_KEY), {})
  );
}

export function readChatScrollMemory(chatKey) {
  if (!chatKey) return null;
  return readChatScrollMemoryMap()[chatKey] || null;
}

export function writeChatScrollMemory(chatKey, entry = {}) {
  if (!chatKey) return null;
  const current = readChatScrollMemoryMap();
  const normalized = normalizeChatScrollMemoryEntry(
    {
      ...entry,
      chatKey,
      savedAt: entry.savedAt || nowMs(),
    },
    nowMs()
  );
  if (!normalized) return null;

  const next = pruneChatScrollMemoryMap({
    ...current,
    [chatKey]: normalized,
  });
  storageSet(CHAT_SCROLL_MEMORY_STORAGE_KEY, JSON.stringify(next));
  return normalized;
}

export function textFingerprint(value = "") {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

export function createChatScrollMemorySnapshot({
  chatKey = null,
  item = null,
  anchor = null,
  scrollTop = 0,
  isAtBottom = false,
  firstItemId = null,
  lastItemId = null,
  savedAt = nowMs(),
} = {}) {
  if (!chatKey) return null;
  return normalizeChatScrollMemoryEntry(
    {
      chatKey,
      itemId: anchor?.itemId || item?.id || null,
      chatId: item?.chatId ?? null,
      role:
        item?.role ||
        (item?.type === "assistant_turn" ? "assistant" : item?.type) ||
        null,
      innerAnchor: anchor?.innerAnchor || null,
      rowOffsetTop: anchor?.offsetTop || anchor?.rowOffsetTop || 0,
      scrollTop,
      isAtBottom,
      firstItemId,
      lastItemId,
      savedAt,
    },
    savedAt
  );
}

export function createChatScrollBottomMemorySnapshot({
  chatKey = null,
  item = null,
  scrollTop = 0,
  firstItemId = null,
  lastItemId = null,
  savedAt = nowMs(),
} = {}) {
  if (!chatKey) return null;
  return normalizeChatScrollMemoryEntry(
    {
      chatKey,
      itemId: item?.id || null,
      chatId: item?.chatId ?? null,
      role:
        item?.role ||
        (item?.type === "assistant_turn" ? "assistant" : item?.type) ||
        null,
      innerAnchor: null,
      rowOffsetTop: 0,
      scrollTop,
      isAtBottom: true,
      firstItemId,
      lastItemId,
      savedAt,
    },
    savedAt
  );
}

export function writeChatScrollBottomMemory(chatKey, options = {}) {
  const snapshot = createChatScrollBottomMemorySnapshot({
    ...options,
    chatKey,
  });
  if (!snapshot) return null;
  return writeChatScrollMemory(chatKey, snapshot);
}

export function historyContainsChatId(history = [], chatId = null) {
  if (!chatId) return false;
  return history.some((message) => Number(message?.chatId) === Number(chatId));
}

export function shouldFetchOlderForChatScrollMemory({
  memory = null,
  history = [],
  page = null,
  attempt = 0,
  maxAttempts = CHAT_SCROLL_MEMORY_OLDER_PAGE_LIMIT,
} = {}) {
  const chatId = Number(memory?.chatId);
  if (!Number.isFinite(chatId) || chatId <= 0) return false;
  if (historyContainsChatId(history, chatId)) return false;
  if (page && page.hasMore === false) return false;
  return attempt < maxAttempts;
}

export function readChatFoldStateMap() {
  const raw = safeJson(storageGet(CHAT_FOLD_MEMORY_STORAGE_KEY), {});
  return Object.fromEntries(
    Object.entries(raw || {})
      .filter(([, entry]) => entry && typeof entry === "object")
      .sort(
        ([, a], [, b]) => finiteNumber(b.updatedAt) - finiteNumber(a.updatedAt)
      )
      .slice(0, CHAT_SCROLL_MEMORY_MAX_THREADS)
  );
}

export function readChatFoldStates(chatKey) {
  if (!chatKey) return {};
  const entry = readChatFoldStateMap()[chatKey];
  return entry?.states && typeof entry.states === "object" ? entry.states : {};
}

export function writeChatFoldState(chatKey, stateId, expanded) {
  if (!chatKey || !stateId) return {};
  const current = readChatFoldStateMap();
  const currentEntry = current[chatKey] || { states: {} };
  const nextEntry = {
    states: {
      ...(currentEntry.states || {}),
      [stateId]: Boolean(expanded),
    },
    updatedAt: nowMs(),
  };
  const next = Object.fromEntries(
    Object.entries({
      ...current,
      [chatKey]: nextEntry,
    })
      .sort(
        ([, a], [, b]) => finiteNumber(b.updatedAt) - finiteNumber(a.updatedAt)
      )
      .slice(0, CHAT_SCROLL_MEMORY_MAX_THREADS)
  );
  storageSet(CHAT_FOLD_MEMORY_STORAGE_KEY, JSON.stringify(next));
  return nextEntry.states;
}
