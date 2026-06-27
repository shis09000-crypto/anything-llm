import {
  isReaderCurrentDocumentFresh,
  readReaderCurrentDocumentClearedAt,
  readReaderDrawerState,
} from "../chat/readerDrawerState.js";

export const WORKSPACE_LAYOUT_INTENT_STORAGE_KEY =
  "anythingllm_workspace_layout_intent:v1";
export const SIDEBAR_COLLAPSED_BY_WORKSPACE_STORAGE_KEY =
  "anythingllm_sidebar_collapsed_by_workspace:v1";
export const LEGACY_SIDEBAR_TOGGLE_STORAGE_KEY = "anythingllm_sidebar_toggle";
export const READER_SPLIT_PERCENT_STORAGE_KEY =
  "anythingllm_reader_split_percent";
export const READER_CURRENT_DOCUMENT_STORAGE_KEY =
  "anythingllm_document_reader:v1:global";

export const READER_DEFAULT_SPLIT_PERCENT = 70;
export const READER_MIN_SPLIT_PERCENT = 30;
export const READER_MAX_SPLIT_PERCENT = READER_DEFAULT_SPLIT_PERCENT;
export const SIDEBAR_DEFAULT_WIDTH = 292;

const MODE_PRIORITY = [
  "dualThread",
  "readerDocument",
  "readerDrawer",
  "mindMap",
  "overview",
  "normal",
];
let hydratedWorkspaceLayout = false;
const WORKSPACE_LAYOUT_NAMESPACE = "workspace.layout";

export function clampReaderSplitPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return READER_DEFAULT_SPLIT_PERCENT;
  return Math.max(
    READER_MIN_SPLIT_PERCENT,
    Math.min(READER_MAX_SPLIT_PERCENT, numeric)
  );
}

function safeLocalStorage() {
  try {
    if (typeof window !== "undefined" && window.localStorage)
      return window.localStorage;
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    return null;
  }
  return null;
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value ?? "");
  } catch {
    return fallback;
  }
}

function readWorkspaceLayoutValue() {
  const storage = safeLocalStorage();
  return {
    layoutIntent: readLayoutIntent(),
    sidebarCollapsedByWorkspace: readSidebarCollapsedMap(),
    readerSplitPercent: readReaderSplitPercent(),
    legacySidebarState: storage?.getItem(LEGACY_SIDEBAR_TOGGLE_STORAGE_KEY),
  };
}

function applyWorkspaceLayoutValue(value = {}) {
  const storage = safeLocalStorage();
  if (!storage || !value || typeof value !== "object") return;
  if (value.layoutIntent) {
    storage.setItem(
      WORKSPACE_LAYOUT_INTENT_STORAGE_KEY,
      JSON.stringify(value.layoutIntent)
    );
  }
  if (value.sidebarCollapsedByWorkspace) {
    storage.setItem(
      SIDEBAR_COLLAPSED_BY_WORKSPACE_STORAGE_KEY,
      JSON.stringify(value.sidebarCollapsedByWorkspace)
    );
  }
  if (value.readerSplitPercent) {
    storage.setItem(
      READER_SPLIT_PERCENT_STORAGE_KEY,
      String(clampReaderSplitPercent(value.readerSplitPercent))
    );
  }
  if (value.legacySidebarState) {
    storage.setItem(
      LEGACY_SIDEBAR_TOGGLE_STORAGE_KEY,
      value.legacySidebarState
    );
  }
}

function hydrateWorkspaceLayoutOnce() {
  if (hydratedWorkspaceLayout) return;
  hydratedWorkspaceLayout = true;
  import("../userStateSync.js")
    .then(({ hydrateUserStateValue }) =>
      hydrateUserStateValue({
        namespace: WORKSPACE_LAYOUT_NAMESPACE,
        fallback: readWorkspaceLayoutValue(),
        apply: applyWorkspaceLayoutValue,
      })
    )
    .catch(() => {});
}

function persistWorkspaceLayout() {
  import("../userStateSync.js")
    .then(({ pushUserStateValue }) =>
      pushUserStateValue(
        WORKSPACE_LAYOUT_NAMESPACE,
        "global",
        readWorkspaceLayoutValue()
      )
    )
    .catch(() => {});
}

function workspaceFromPath(pathname = "") {
  const match = String(pathname).match(
    /^\/workspace\/([^/]+)(?:\/t\/([^/]+))?/
  );
  if (!match) return { workspaceId: null, threadId: null };
  return {
    workspaceId: decodeURIComponent(match[1] || "") || null,
    threadId: decodeURIComponent(match[2] || "") || null,
  };
}

function readReaderDocumentIntent(storage) {
  if (!storage) return null;
  const stored = safeJson(
    storage.getItem(READER_CURRENT_DOCUMENT_STORAGE_KEY),
    null
  );
  if (
    !isReaderCurrentDocumentFresh(stored, readReaderCurrentDocumentClearedAt())
  )
    return null;
  return stored;
}

export function readReaderSplitPercent() {
  hydrateWorkspaceLayoutOnce();
  const storage = safeLocalStorage();
  if (!storage) return READER_DEFAULT_SPLIT_PERCENT;
  return clampReaderSplitPercent(
    storage.getItem(READER_SPLIT_PERCENT_STORAGE_KEY)
  );
}

export function writeReaderSplitPercent(value) {
  const storage = safeLocalStorage();
  if (!storage) return;
  storage.setItem(
    READER_SPLIT_PERCENT_STORAGE_KEY,
    String(clampReaderSplitPercent(value))
  );
  persistWorkspaceLayout();
}

export function readSidebarCollapsedMap() {
  hydrateWorkspaceLayoutOnce();
  const storage = safeLocalStorage();
  if (!storage) return {};
  const map = safeJson(
    storage.getItem(SIDEBAR_COLLAPSED_BY_WORKSPACE_STORAGE_KEY),
    {}
  );
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

export function readSidebarCollapsed(workspaceId = null) {
  const storage = safeLocalStorage();
  const map = readSidebarCollapsedMap();
  if (workspaceId && typeof map[workspaceId] === "boolean")
    return map[workspaceId];

  const legacy = storage?.getItem(LEGACY_SIDEBAR_TOGGLE_STORAGE_KEY);
  return legacy === "closed";
}

export function writeSidebarCollapsed(workspaceId = null, collapsed = false) {
  const storage = safeLocalStorage();
  if (!storage) return;
  if (workspaceId) {
    storage.setItem(
      SIDEBAR_COLLAPSED_BY_WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        ...readSidebarCollapsedMap(),
        [workspaceId]: !!collapsed,
      })
    );
  }
  storage.setItem(
    LEGACY_SIDEBAR_TOGGLE_STORAGE_KEY,
    collapsed ? "closed" : "open"
  );
  persistWorkspaceLayout();
}

export function readLayoutIntent() {
  hydrateWorkspaceLayoutOnce();
  const storage = safeLocalStorage();
  if (!storage) return {};
  const intent = safeJson(
    storage.getItem(WORKSPACE_LAYOUT_INTENT_STORAGE_KEY),
    {}
  );
  return intent && typeof intent === "object" && !Array.isArray(intent)
    ? intent
    : {};
}

export function writeLayoutIntent(patch = {}) {
  const storage = safeLocalStorage();
  if (!storage) return;
  const filteredPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  );
  const next = {
    ...readLayoutIntent(),
    ...filteredPatch,
    updatedAt: Date.now(),
  };
  storage.setItem(WORKSPACE_LAYOUT_INTENT_STORAGE_KEY, JSON.stringify(next));
  persistWorkspaceLayout();
}

export function deriveLayoutMode(state = {}) {
  const candidates = {
    dualThread: !!state.dualThreadOpen,
    readerDocument: state.readerOpen && state.readerType === "document",
    readerDrawer: state.readerOpen && state.readerType === "drawer",
    mindMap: !!state.mindMapOpen,
    overview: state.mode === "overview",
    normal: true,
  };
  return MODE_PRIORITY.find((mode) => candidates[mode]) || "normal";
}

export function effectiveSidebarCollapsed(state = {}) {
  return !!state.sidebarCollapsed;
}

export function createLayoutState(partial = {}) {
  const state = {
    mode: "normal",
    workspaceId: null,
    threadId: null,
    sidebarCollapsed: false,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    readerOpen: false,
    readerType: null,
    readerPercent: READER_DEFAULT_SPLIT_PERCENT,
    mindMapOpen: false,
    dualThreadOpen: false,
    hydrating: false,
    ...partial,
  };
  state.readerPercent = clampReaderSplitPercent(state.readerPercent);
  state.mode = deriveLayoutMode(state);
  return state;
}

export function readInitialLayoutIntent(options = {}) {
  const pathState = workspaceFromPath(
    options.pathname ||
      (typeof window !== "undefined" ? window.location?.pathname : "")
  );
  const workspaceId = options.workspaceId ?? pathState.workspaceId;
  const threadId = options.threadId ?? pathState.threadId;
  const storedLayout = readLayoutIntent();
  const storage = safeLocalStorage();
  const readerDocument = readReaderDocumentIntent(storage);
  const drawerState = readReaderDrawerState();
  const readerType = readerDocument
    ? "document"
    : drawerState.open
      ? "drawer"
      : null;
  const readerOpen = !!readerType;

  return createLayoutState({
    workspaceId: workspaceId || storedLayout.workspaceId || null,
    threadId: threadId || storedLayout.threadId || null,
    sidebarCollapsed: readSidebarCollapsed(
      workspaceId || storedLayout.workspaceId
    ),
    sidebarWidth: Number(storedLayout.sidebarWidth) || SIDEBAR_DEFAULT_WIDTH,
    readerOpen,
    readerType,
    readerPercent: readReaderSplitPercent(),
    mindMapOpen: !!storedLayout.mindMapOpen,
    dualThreadOpen: !!storedLayout.dualThreadOpen,
    hydrating: false,
  });
}

export function workspaceLayoutReducer(state, event = {}) {
  switch (event.type) {
    case "APP_HYDRATED":
      return createLayoutState({
        ...state,
        ...event.payload,
        hydrating: false,
      });
    case "WORKSPACE_CHANGED": {
      const workspaceId = event.workspaceId ?? null;
      return createLayoutState({
        ...state,
        workspaceId,
        sidebarCollapsed: readSidebarCollapsed(workspaceId),
      });
    }
    case "THREAD_CHANGED":
      return createLayoutState({ ...state, threadId: event.threadId ?? null });
    case "SIDEBAR_TOGGLED":
      return createLayoutState({
        ...state,
        sidebarCollapsed: !!event.collapsed,
      });
    case "READER_OPENED":
      return createLayoutState({
        ...state,
        readerOpen: true,
        readerType: event.readerType || "drawer",
      });
    case "READER_CLOSED":
      return createLayoutState({
        ...state,
        readerOpen: false,
        readerType: null,
      });
    case "READER_RESIZE_DRAFT":
    case "READER_RESIZE_COMMIT":
      return createLayoutState({
        ...state,
        readerPercent: clampReaderSplitPercent(event.percent),
      });
    case "MINDMAP_OPENED":
      return createLayoutState({ ...state, mindMapOpen: true });
    case "MINDMAP_CLOSED":
      return createLayoutState({ ...state, mindMapOpen: false });
    case "DUAL_THREAD_OPENED":
      return createLayoutState({ ...state, dualThreadOpen: true });
    case "DUAL_THREAD_CLOSED":
      return createLayoutState({ ...state, dualThreadOpen: false });
    case "VIEWPORT_RESIZED":
      return createLayoutState({
        ...state,
        viewportWidth: event.width,
        viewportHeight: event.height,
      });
    default:
      return createLayoutState(state);
  }
}

export function applyWorkspaceLayoutStorageEvent(event = {}) {
  if (event.type === "SIDEBAR_TOGGLED") {
    writeSidebarCollapsed(event.workspaceId, !!event.collapsed);
    return;
  }
  if (event.type === "READER_RESIZE_COMMIT") {
    writeReaderSplitPercent(event.percent);
    return;
  }
  if (
    [
      "WORKSPACE_CHANGED",
      "THREAD_CHANGED",
      "READER_OPENED",
      "READER_CLOSED",
      "MINDMAP_OPENED",
      "MINDMAP_CLOSED",
      "DUAL_THREAD_OPENED",
      "DUAL_THREAD_CLOSED",
    ].includes(event.type)
  ) {
    writeLayoutIntent({
      workspaceId: event.workspaceId,
      threadId: event.threadId,
      readerOpen:
        event.type === "READER_OPENED"
          ? true
          : event.type === "READER_CLOSED"
            ? false
            : undefined,
      readerType: event.readerType,
      mindMapOpen:
        event.type === "MINDMAP_OPENED"
          ? true
          : event.type === "MINDMAP_CLOSED"
            ? false
            : undefined,
      dualThreadOpen:
        event.type === "DUAL_THREAD_OPENED"
          ? true
          : event.type === "DUAL_THREAD_CLOSED"
            ? false
            : undefined,
    });
  }
}
