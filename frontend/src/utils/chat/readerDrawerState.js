export const READER_DRAWER_OPEN_STORAGE_KEY =
  "anythingllm_document_reader_drawer_open:v1:global";
export const READER_DRAWER_STATE_STORAGE_KEY =
  "anythingllm_document_reader_drawer_state:v1:global";
export const READER_CURRENT_DOCUMENT_STORAGE_KEY =
  "anythingllm_document_reader:v1:global";
export const READER_CURRENT_DOCUMENT_CLEAR_STORAGE_KEY =
  "anythingllm_document_reader_current_cleared_at:v1:global";

const READER_CURRENT_DOCUMENT_LEGACY_PREFIX = "anythingllm_document_reader:v1:";
const DEFAULT_DRAWER_SECTION = "history";
const VALID_DRAWER_SECTIONS = new Set(["history", "bookshelf", "workspace"]);

function safeLocalStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value ?? "");
  } catch {
    return fallback;
  }
}

function storageKeys(storage) {
  if (!storage) return [];
  try {
    if (
      typeof storage.length === "number" &&
      typeof storage.key === "function"
    ) {
      return Array.from({ length: storage.length }, (_, index) =>
        storage.key(index)
      ).filter(Boolean);
    }
  } catch {
    return [];
  }
  return [];
}

function timestampValue(value) {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const numeric = Number(value);
  if (String(value).trim() && Number.isFinite(numeric)) return numeric;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function normalizeReaderDrawerSection(section = null) {
  const normalized = String(section || "").trim();
  return VALID_DRAWER_SECTIONS.has(normalized)
    ? normalized
    : DEFAULT_DRAWER_SECTION;
}

export function normalizeReaderDrawerState(state = null) {
  if (state && typeof state === "object") {
    return {
      open: state.open === true,
      section: normalizeReaderDrawerSection(state.section),
      updatedAt: timestampValue(state.updatedAt) || Date.now(),
    };
  }
  return {
    open: state === true || state === "true",
    section: DEFAULT_DRAWER_SECTION,
    updatedAt: Date.now(),
  };
}

export function readReaderDrawerState() {
  const storage = safeLocalStorage();
  if (!storage) return normalizeReaderDrawerState(null);
  try {
    const state = safeJson(
      storage.getItem(READER_DRAWER_STATE_STORAGE_KEY),
      null
    );
    if (state && typeof state === "object")
      return normalizeReaderDrawerState(state);

    return normalizeReaderDrawerState(
      storage.getItem(READER_DRAWER_OPEN_STORAGE_KEY) === "true"
    );
  } catch {
    return normalizeReaderDrawerState(null);
  }
}

export function readReaderDrawerOpenIntent() {
  return readReaderDrawerState().open;
}

export function setReaderDrawerState(nextState = {}) {
  const storage = safeLocalStorage();
  const current = readReaderDrawerState();
  const state = normalizeReaderDrawerState({
    open: nextState.open === undefined ? current.open : nextState.open,
    section: nextState.section || current.section,
    updatedAt: nextState.updatedAt || Date.now(),
  });
  if (!storage) return state;
  try {
    storage.setItem(READER_DRAWER_STATE_STORAGE_KEY, JSON.stringify(state));
    if (state.open) {
      storage.setItem(READER_DRAWER_OPEN_STORAGE_KEY, "true");
    } else {
      storage.removeItem(READER_DRAWER_OPEN_STORAGE_KEY);
    }
  } catch {
    // Drawer state is only a UI convenience.
  }
  return state;
}

export function setReaderDrawerOpenIntent(open, options = {}) {
  return setReaderDrawerState({ open, section: options.section });
}

export function setReaderDrawerSection(section, options = {}) {
  return setReaderDrawerState({
    open: options.open,
    section: normalizeReaderDrawerSection(section),
  });
}

export function clearReaderDrawerOpenIntent(options = {}) {
  return setReaderDrawerOpenIntent(false, options);
}

export function readerCurrentDocumentTimestamp(document = {}) {
  return Math.max(
    timestampValue(document.restoredAt),
    timestampValue(document.progress?.updatedAt),
    timestampValue(document.metadata?.createdAt),
    timestampValue(document.metadata?.reopenedAt)
  );
}

export function readReaderCurrentDocumentClearedAt() {
  const storage = safeLocalStorage();
  if (!storage) return 0;
  try {
    return timestampValue(
      storage.getItem(READER_CURRENT_DOCUMENT_CLEAR_STORAGE_KEY)
    );
  } catch {
    return 0;
  }
}

export function clearReaderCurrentDocumentClearMarker() {
  const storage = safeLocalStorage();
  if (!storage) return false;
  try {
    storage.removeItem(READER_CURRENT_DOCUMENT_CLEAR_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function isReaderCurrentDocumentFresh(document = null, clearedAt = 0) {
  if (!document) return false;
  if (!clearedAt) return true;
  return readerCurrentDocumentTimestamp(document) > clearedAt;
}

export function readerCurrentDocumentStorageKeys() {
  const storage = safeLocalStorage();
  if (!storage) return [READER_CURRENT_DOCUMENT_STORAGE_KEY];
  return [
    READER_CURRENT_DOCUMENT_STORAGE_KEY,
    ...storageKeys(storage).filter(
      (key) =>
        key?.startsWith(READER_CURRENT_DOCUMENT_LEGACY_PREFIX) &&
        key !== READER_CURRENT_DOCUMENT_STORAGE_KEY
    ),
  ];
}

export function clearReaderCurrentDocumentStorage(options = {}) {
  const storage = safeLocalStorage();
  const clearedAt = options.clearedAt || Date.now();
  if (!storage) return { clearedAt, removed: [] };
  const removed = [];
  try {
    for (const key of readerCurrentDocumentStorageKeys()) {
      if (!key) continue;
      storage.removeItem(key);
      removed.push(key);
    }
    if (options.markCleared !== false) {
      storage.setItem(
        READER_CURRENT_DOCUMENT_CLEAR_STORAGE_KEY,
        String(clearedAt)
      );
    }
  } catch {
    // Best effort cleanup; later reads also honor the tombstone when present.
  }
  return { clearedAt, removed };
}
