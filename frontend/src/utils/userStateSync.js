import {
  getUserStates,
  patchUserStates,
  deleteUserState,
  USER_STATE_NAMESPACES,
} from "@/lib/communication/userStateClient";
import { APPEARANCE_SETTINGS } from "@/utils/constants";
import { safeJsonParse } from "@/utils/request";
import { getStoredAuthUser } from "@/utils/authUserStorage";
import { decryptLocalCachePayload } from "@/utils/security/localCacheCrypto";

export { USER_STATE_NAMESPACES };

const META_STORAGE_KEY = "athena_user_state_sync_meta:v1";
const READ_CURSOR_STORAGE_KEY = "athena_user_state_read_cursors:v1";
const DEFAULT_SCOPE = "global";
const WRITE_DEBOUNCE_MS = 800;
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const pendingWrites = new Map();
const pendingReadCursorWrites = new Map();
const hydrationKeys = new Set();

function storage() {
  try {
    if (typeof window !== "undefined" && window.localStorage)
      return window.localStorage;
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {}
  return null;
}

function stateOwnerKey() {
  const user = getStoredAuthUser();
  const userId = user?.authUserId || user?.id || user?.username || user?.email;
  return userId ? `user:${String(userId)}` : "anonymous";
}

function stateKey(namespace, scope = DEFAULT_SCOPE) {
  return `${stateOwnerKey()}:${namespace}:${scope || DEFAULT_SCOPE}`;
}

function legacyStateKey(namespace, scope = DEFAULT_SCOPE) {
  return `${namespace}:${scope || DEFAULT_SCOPE}`;
}

function readMeta() {
  return safeJsonParse(storage()?.getItem(META_STORAGE_KEY), {}) || {};
}

function writeMeta(meta = {}) {
  try {
    storage()?.setItem(META_STORAGE_KEY, JSON.stringify(meta));
  } catch {}
}

function metaTimestamp(namespace, scope = DEFAULT_SCOPE) {
  const meta = readMeta();
  const key = stateKey(namespace, scope);
  if (meta[key]) return Number(meta[key] || 0);
  if (stateOwnerKey() !== "anonymous") return 0;
  return Number(meta[legacyStateKey(namespace, scope)] || 0);
}

function touchMeta(namespace, scope = DEFAULT_SCOPE, timestamp = Date.now()) {
  const meta = readMeta();
  meta[stateKey(namespace, scope)] = timestamp;
  writeMeta(meta);
  return timestamp;
}

function clearPendingWrite(key) {
  const pending = pendingWrites.get(key);
  if (!pending) return false;
  clearTimeout(pending?.timer ?? pending);
  pendingWrites.delete(key);
  return true;
}

function flushPendingWrite(key) {
  const pending = pendingWrites.get(key);
  if (!pending || typeof pending.commit !== "function") return null;
  clearTimeout(pending.timer);
  return pending.commit();
}

function readCursorState() {
  return safeJsonParse(storage()?.getItem(READ_CURSOR_STORAGE_KEY), {}) || {};
}

function persistedReadCursor(scope) {
  return Math.max(
    0,
    Number(
      readCursorState()[
        stateKey(USER_STATE_NAMESPACES.threadReadState, scope)
      ] || 0
    ) || 0
  );
}

function persistReadCursor(scope, cursor) {
  const cursors = readCursorState();
  const key = stateKey(USER_STATE_NAMESPACES.threadReadState, scope);
  cursors[key] = Math.max(Number(cursors[key] || 0), Number(cursor) || 0);
  try {
    storage()?.setItem(READ_CURSOR_STORAGE_KEY, JSON.stringify(cursors));
  } catch {}
  return cursors[key];
}

function remoteTimestamp(state = null) {
  const valueTimestamp = Number(state?.value?.updatedAt || 0);
  const rowTimestamp = new Date(state?.updatedAt || 0).getTime();
  return Math.max(valueTimestamp, rowTimestamp, 0);
}

function hasAuthoritativeStateVersion(state = null) {
  return (
    Number.isInteger(Number(state?.stateVersion)) &&
    Number(state.stateVersion) > 0
  );
}

function shouldApplyRemote(state = null, namespace, scope = DEFAULT_SCOPE) {
  if (!state) return false;
  if (hasAuthoritativeStateVersion(state)) return true;
  // Legacy servers have no stateVersion. Keep the timestamp comparison only
  // as a compatibility side path; Sync V2 never treats client time as truth.
  return remoteTimestamp(state) > metaTimestamp(namespace, scope);
}

function safeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

const SENSITIVE_READER_KEYS = new Set([
  "absolutePath",
  "buffer",
  "content",
  "dataUrl",
  "file",
  "fileContent",
  "localPath",
  "originalUrl",
  "raw",
  "sourceText",
  "text",
  "thumbnailDataUrl",
]);

export function sanitizeReaderState(value) {
  if (Array.isArray(value)) return value.map(sanitizeReaderState);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_READER_KEYS.has(key)) continue;
    next[key] = sanitizeReaderState(item);
  }
  return next;
}

async function getRemoteState(namespace, scope = DEFAULT_SCOPE) {
  try {
    const { syncV2Runtime } = await import("@/utils/syncV2/syncV2Runtime");
    await syncV2Runtime.bootstrap();
  } catch {}
  const states = await getUserStates([namespace]);
  return (
    states.find(
      (state) =>
        state.namespace === namespace &&
        (state.scope || DEFAULT_SCOPE) === (scope || DEFAULT_SCOPE)
    ) || null
  );
}

export function pushUserStateValue(
  namespace,
  scope = DEFAULT_SCOPE,
  value = null,
  options = {}
) {
  const safeValue = options.sanitize
    ? options.sanitize(value)
    : safeClone(value);
  const updatedAt = touchMeta(namespace, scope);
  const payload = {
    namespace,
    scope: scope || DEFAULT_SCOPE,
    version: options.version || "1",
    value: {
      ...(safeValue &&
      typeof safeValue === "object" &&
      !Array.isArray(safeValue)
        ? safeValue
        : { value: safeValue }),
      updatedAt,
    },
  };
  const key = stateKey(namespace, scope);
  clearPendingWrite(key);
  pendingWrites.set(
    key,
    setTimeout(() => {
      pendingWrites.delete(key);
      patchUserStates([payload]).catch(() => {});
    }, options.debounceMs ?? WRITE_DEBOUNCE_MS)
  );
  return payload.value;
}

export async function hydrateJsonStorageKey({
  namespace,
  scope = DEFAULT_SCOPE,
  storageKey,
  fallback = null,
  sanitize,
  apply,
} = {}) {
  const cacheKey = `${namespace}:${scope}:${storageKey}`;
  if (hydrationKeys.has(cacheKey)) return null;
  hydrationKeys.add(cacheKey);

  const localStorageRef = storage();
  if (!localStorageRef || !storageKey) return null;
  const localValue = safeJsonParse(
    localStorageRef.getItem(storageKey),
    fallback
  );
  try {
    const remote = await getRemoteState(namespace, scope);
    if (shouldApplyRemote(remote, namespace, scope)) {
      const remoteValue = sanitize ? sanitize(remote.value) : remote.value;
      localStorageRef.setItem(storageKey, JSON.stringify(remoteValue));
      touchMeta(namespace, scope, remoteTimestamp(remote));
      apply?.(remoteValue);
      return remoteValue;
    }

    if (localValue !== null && localValue !== undefined) {
      pushUserStateValue(namespace, scope, localValue, { sanitize });
    }
  } catch {}
  return localValue;
}

export async function hydrateUserStateValue({
  namespace,
  scope = DEFAULT_SCOPE,
  fallback = null,
  sanitize,
  apply,
} = {}) {
  try {
    const remote = await getRemoteState(namespace, scope);
    if (shouldApplyRemote(remote, namespace, scope)) {
      const remoteValue = sanitize ? sanitize(remote.value) : remote.value;
      touchMeta(namespace, scope, remoteTimestamp(remote));
      apply?.(remoteValue);
      return remoteValue;
    }
    if (fallback !== null && fallback !== undefined) {
      pushUserStateValue(namespace, scope, fallback, { sanitize });
    }
  } catch {}
  return fallback;
}

export function writeJsonStorageKey(
  namespace,
  scope = DEFAULT_SCOPE,
  storageKey,
  value,
  options = {}
) {
  try {
    storage()?.setItem(storageKey, JSON.stringify(value));
  } catch {}
  pushUserStateValue(namespace, scope, value, options);
  return value;
}

export async function deleteSyncedState(namespace, scope = DEFAULT_SCOPE) {
  try {
    await deleteUserState({ namespace, scope });
  } catch {}
}

export function recentNavigationScope() {
  return DEFAULT_SCOPE;
}

export function promptDraftScope({
  workspaceSlug = null,
  threadSlug = null,
} = {}) {
  if (threadSlug) return `thread:${workspaceSlug || "unknown"}:${threadSlug}`;
  if (workspaceSlug) return `workspace:${workspaceSlug}`;
  return DEFAULT_SCOPE;
}

export function normalizeDraftValue(value = "", options = {}) {
  return {
    text: String(value || "").slice(0, 64 * 1024),
    workspaceSlug: options.workspaceSlug || null,
    threadSlug: options.threadSlug || null,
    expiresAt: Date.now() + DRAFT_TTL_MS,
  };
}

function draftCryptoNamespace(scope) {
  return `chat-draft:${scope || DEFAULT_SCOPE}`;
}

async function draftTextFromValue(scope, draft = null, fallback = "") {
  if (!draft) return fallback;
  if (Number(draft.expiresAt || 0) && Number(draft.expiresAt) < Date.now()) {
    await deleteSyncedState(USER_STATE_NAMESPACES.chatDraft, scope);
    return fallback;
  }
  if (draft.encryptedText?.encrypted) {
    try {
      const decrypted = await decryptLocalCachePayload({
        namespace: draftCryptoNamespace(scope),
        encryptedPayload: draft.encryptedText,
      });
      const text = String(decrypted?.text || "");
      // The originating browser can open the legacy device-local envelope.
      // Rewrite it once through the server-protected format so every other
      // authorized device can read the same draft afterwards.
      persistPromptDraft(scope, text, {
        workspaceSlug: draft.workspaceSlug || null,
        threadSlug: draft.threadSlug || null,
        debounceMs: 0,
      });
      return text;
    } catch {
      return fallback;
    }
  }
  return draft.text ? String(draft.text || "") : fallback;
}

export async function hydratePromptDraft(scope, fallback = "") {
  try {
    const remote = await getRemoteState(USER_STATE_NAMESPACES.chatDraft, scope);
    const draft = remote?.value;
    if (!draft) return fallback;
    touchMeta(USER_STATE_NAMESPACES.chatDraft, scope, remoteTimestamp(remote));
    return draftTextFromValue(scope, draft, fallback);
  } catch {
    return fallback;
  }
}

export function persistPromptDraft(scope, value = "", options = {}) {
  const normalizedScope = scope || DEFAULT_SCOPE;
  const key = stateKey(USER_STATE_NAMESPACES.chatDraft, normalizedScope);
  clearPendingWrite(key);
  const updatedAt = touchMeta(USER_STATE_NAMESPACES.chatDraft, normalizedScope);
  const preview = normalizeDraftValue(value, options);
  const pending = {
    timer: null,
    commit: () => {
      if (pendingWrites.get(key) !== pending) return null;
      pendingWrites.delete(key);
      // Remote drafts are protected at rest by the server. The browser-local
      // cache key is intentionally not used for cross-device payloads because
      // another authorized device cannot possess that key. Legacy envelopes
      // remain readable above on their originating browser profile.
      const draftValue = normalizeDraftValue(value, options);
      return patchUserStates([
        {
          namespace: USER_STATE_NAMESPACES.chatDraft,
          scope: normalizedScope,
          version: "3",
          value: { ...draftValue, updatedAt },
        },
      ]).catch(() => null);
    },
  };
  pending.timer = setTimeout(pending.commit, options.debounceMs ?? 600);
  pendingWrites.set(key, pending);
  return preview;
}

export function flushPromptDraft(scope) {
  return flushPendingWrite(
    stateKey(USER_STATE_NAMESPACES.chatDraft, scope || DEFAULT_SCOPE)
  );
}

export function clearPromptDraft(scope) {
  const key = stateKey(USER_STATE_NAMESPACES.chatDraft, scope);
  clearPendingWrite(key);
  touchMeta(USER_STATE_NAMESPACES.chatDraft, scope);
  void deleteSyncedState(USER_STATE_NAMESPACES.chatDraft, scope);
}

export function threadReadStateScope({
  workspaceSlug = null,
  threadSlug = null,
} = {}) {
  if (!workspaceSlug) return null;
  if (!threadSlug) return `workspace:${workspaceSlug}`;
  return `thread:${workspaceSlug}:${threadSlug}`;
}

export async function advanceThreadReadCursor({
  workspaceSlug,
  threadSlug,
  cursor,
  messageId = null,
} = {}) {
  const scope = threadReadStateScope({ workspaceSlug, threadSlug });
  const normalizedCursor = Math.max(0, Number(cursor) || 0);
  if (
    !scope ||
    !Number.isSafeInteger(normalizedCursor) ||
    normalizedCursor <= 0
  )
    return null;
  const key = stateKey(USER_STATE_NAMESPACES.threadReadState, scope);
  const previous = pendingReadCursorWrites.get(key);
  if (
    normalizedCursor <=
    Math.max(persistedReadCursor(scope), Number(previous?.cursor || 0))
  )
    return previous?.promise || null;

  const promise = (previous?.promise || Promise.resolve())
    .catch(() => null)
    .then(async () => {
      if (normalizedCursor <= persistedReadCursor(scope)) return null;
      const result = await patchUserStates([
        {
          namespace: USER_STATE_NAMESPACES.threadReadState,
          scope,
          version: "1",
          value: {
            cursor: normalizedCursor,
            ...(Number.isSafeInteger(Number(messageId)) &&
            Number(messageId) >= 0
              ? { messageId: Number(messageId) }
              : {}),
          },
        },
      ]);
      persistReadCursor(scope, normalizedCursor);
      return result;
    })
    .finally(() => {
      if (pendingReadCursorWrites.get(key)?.promise === promise) {
        pendingReadCursorWrites.delete(key);
      }
    });
  pendingReadCursorWrites.set(key, { cursor: normalizedCursor, promise });
  return promise;
}

export function appearancePreferenceValue(patch = {}) {
  const localStorageRef = storage();
  const value = {
    theme: localStorageRef?.getItem("theme") || "system",
    appearanceSettings:
      safeJsonParse(localStorageRef?.getItem(APPEARANCE_SETTINGS), {}) || {},
    textSize: localStorageRef?.getItem("anythingllm_text_size") || "normal",
    customTextSizePx:
      localStorageRef?.getItem("anythingllm_text_size_custom_px") || null,
    ...patch,
  };
  return value;
}

export function persistAppearancePreferences(patch = {}) {
  return pushUserStateValue(
    USER_STATE_NAMESPACES.appearance,
    DEFAULT_SCOPE,
    appearancePreferenceValue(patch)
  );
}

async function applyTextSizeFromAppearance(value = {}) {
  const hasTextSize = Boolean(value?.textSize);
  const hasCustomTextSize =
    value?.customTextSizePx !== null && value?.customTextSizePx !== undefined;
  if (!hasTextSize && !hasCustomTextSize) return;

  try {
    const { applySyncedTextSizePreference } = await import("@/utils/textSize");
    applySyncedTextSizePreference({
      textSize: value.textSize,
      customTextSizePx: value.customTextSizePx,
    });
    return;
  } catch {}

  try {
    window.dispatchEvent(new Event("textSizeChange"));
  } catch {}
}

export async function hydrateAppearancePreferences(apply = () => {}) {
  try {
    const remote = await getRemoteState(USER_STATE_NAMESPACES.appearance);
    if (!remote?.value) {
      persistAppearancePreferences();
      return null;
    }

    const incomingTimestamp = remoteTimestamp(remote);
    if (
      !hasAuthoritativeStateVersion(remote) &&
      incomingTimestamp < metaTimestamp(USER_STATE_NAMESPACES.appearance)
    ) {
      persistAppearancePreferences();
      return appearancePreferenceValue();
    }

    const value = remote.value;
    const localStorageRef = storage();
    if (!localStorageRef) return value;
    if (value.theme) localStorageRef.setItem("theme", value.theme);
    if (value.appearanceSettings) {
      localStorageRef.setItem(
        APPEARANCE_SETTINGS,
        JSON.stringify(value.appearanceSettings)
      );
    }
    touchMeta(
      USER_STATE_NAMESPACES.appearance,
      DEFAULT_SCOPE,
      incomingTimestamp
    );
    await applyTextSizeFromAppearance(value);
    apply(value);
    return value;
  } catch {
    return null;
  }
}
