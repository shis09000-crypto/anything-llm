import { deleteJson, getJson, patchJson } from "./apiClient";
import { getAppEnvironment } from "@/utils/appEnvironment";
import { getStoredAuthUser } from "@/utils/authUserStorage";
import { serverStateCache } from "@/utils/serverState/serverStateCache";
import { serverStateTaskBridge } from "@/utils/serverState/serverStateTaskBridge";
import { isSensitiveStateKey } from "@/utils/sensitive/sensitiveDataGuards";
import { syncMutationQueue } from "@/utils/syncV2/syncMutationQueue";
import { syncV2Runtime } from "@/utils/syncV2/syncV2Runtime";
import { syncV2StateStore } from "@/utils/syncV2/syncV2StateStore";

export const USER_STATE_NAMESPACES = {
  recentNavigation: "recent.navigation",
  appearance: "preferences.appearance",
  workspaceLayout: "workspace.layout",
  workspaceOrder: "workspace.order",
  readerProgress: "reader.progress",
  readerLibrary: "reader.library",
  chatDraft: "chat.draft",
  threadReadState: "thread.read-state",
  cryptoUi: "crypto.ui",
};

const USER_STATE_CACHE_TTL_MS = 30_000;
const USER_STATE_CACHE_PREFIX = "user-state:";
const preferenceOperationChains = new Map();

function namespaceQuery(namespaces = []) {
  const list = Array.isArray(namespaces) ? namespaces : [namespaces];
  const filtered = list.filter(Boolean).map(encodeURIComponent);
  return filtered.length ? `?namespaces=${filtered.join(",")}` : "";
}

function namespaceList(namespaces = []) {
  const list = (Array.isArray(namespaces) ? namespaces : [namespaces])
    .filter(Boolean)
    .map(String)
    .sort();
  const blocked = list.find((namespace) => isSensitiveStateKey(namespace));
  if (blocked) {
    const error = new Error(
      `Sensitive namespace "${blocked}" is not allowed in UserStateSync.`
    );
    error.code = "SENSITIVE_USER_STATE_FORBIDDEN";
    throw error;
  }
  return list;
}

function userStateReadTask(namespaces = []) {
  const list = namespaceList(namespaces);
  const visibleNamespaces = new Set([
    USER_STATE_NAMESPACES.appearance,
    USER_STATE_NAMESPACES.recentNavigation,
    USER_STATE_NAMESPACES.readerLibrary,
    USER_STATE_NAMESPACES.readerProgress,
    USER_STATE_NAMESPACES.workspaceLayout,
    USER_STATE_NAMESPACES.workspaceOrder,
  ]);
  const visible = list.some((namespace) => visibleNamespaces.has(namespace));

  return {
    label: `user-state:read:${list.join(",") || "all"}`,
    kind: "user-state",
    priority: visible ? "P1" : "P2",
    policy: visible ? "visible" : "background",
    resource: "network",
    scope: {
      route: "user-state",
      namespaces: list,
    },
  };
}

function currentUserStateOwnerScope() {
  if (typeof window === "undefined") return "server";
  const user = getStoredAuthUser();
  return [
    getAppEnvironment(),
    user?.authUserId || user?.id || user?.username || "anonymous",
  ].join(":");
}

function userStateCacheKey(namespaces = []) {
  const list = namespaceList(namespaces);
  return `${USER_STATE_CACHE_PREFIX}${list.join(",") || "all"}`;
}

function userStateScope(namespaces = []) {
  return {
    domain: "user-state",
    route: "user-state",
    namespaces: namespaceList(namespaces),
  };
}

function userStateWriteTask(states = [], action = "write") {
  const list = (Array.isArray(states) ? states : [states])
    .map((state) => state?.namespace)
    .filter(Boolean);

  return {
    label: `user-state:${action}:${list.join(",") || "unknown"}`,
    kind: "user-state",
    priority: "P1",
    policy: "visible",
    protected: true,
    abortable: false,
    resource: "network",
    scope: {
      route: "user-state",
      namespaces: list,
    },
  };
}

function syncV2PreferenceNodeKey({ namespace, scope = "global" } = {}) {
  const userId = Number(getStoredAuthUser()?.id);
  if (!Number.isInteger(userId) || userId <= 0 || !namespace) return null;
  return `users/${userId}/preferences/${encodeURIComponent(
    namespace
  )}/${encodeURIComponent(scope || "global")}`;
}

function preferenceOperationKey({ namespace, scope = "global" } = {}) {
  if (!namespace) return null;
  return `${currentUserStateOwnerScope()}:${namespace}:${scope || "global"}`;
}

function serializePreferenceOperation(state, operation) {
  const key = preferenceOperationKey(state);
  if (!key) return operation();
  const previous = preferenceOperationChains.get(key) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  const tracked = current.finally(() => {
    if (preferenceOperationChains.get(key) === tracked) {
      preferenceOperationChains.delete(key);
    }
  });
  preferenceOperationChains.set(key, tracked);
  return tracked;
}

function syncV2PreferenceMutation(state, operation = "merge") {
  const nodeKey = syncV2PreferenceNodeKey(state);
  const descriptor = nodeKey ? syncV2StateStore.descriptor(nodeKey) : null;
  if (!descriptor) return null;
  const payload =
    state?.value &&
    typeof state.value === "object" &&
    !Array.isArray(state.value)
      ? Object.fromEntries(
          Object.entries(state.value).filter(
            ([key]) => key !== "dirty" && key !== "updatedAt"
          )
        )
      : state?.value;
  return {
    mutationId: crypto.randomUUID(),
    nodeKey,
    baseVersion: Number(descriptor.stateVersion || 0),
    operation,
    changedPaths:
      operation === "delete"
        ? ["$"]
        : payload && typeof payload === "object" && !Array.isArray(payload)
          ? Object.keys(payload)
          : ["value"],
    payload: operation === "delete" ? null : payload,
  };
}

function syncV2ClientEnabled() {
  return (
    String(import.meta.env?.VITE_SYNC_V2_ENABLED || "false") === "true" &&
    syncV2Runtime.enabled()
  );
}

async function fetchUserStates(namespaces = [], options = {}) {
  const {
    communicationScene = "user-state-read",
    signal,
    task: _task,
    serverStateCache: _serverStateCache,
    ...rest
  } = options;
  const { data } = await getJson(
    `/system/user/state${namespaceQuery(namespaces)}`,
    {
      ...rest,
      signal,
      communicationScene,
      task: false,
    }
  );
  return data?.states || [];
}

function invalidateUserStateCache() {
  return serverStateCache.invalidatePrefix(USER_STATE_CACHE_PREFIX, {
    ownerScope: currentUserStateOwnerScope(),
  });
}

export async function getUserStates(namespaces = [], options = {}) {
  const list = namespaceList(namespaces);
  const task =
    options.task === undefined ? userStateReadTask(list) : options.task;

  if (task === false || options.serverStateCache === false) {
    const { data } = await getJson(
      `/system/user/state${namespaceQuery(list)}`,
      {
        ...options,
        communicationScene: options.communicationScene || "user-state-read",
        task,
      }
    );
    return data?.states || [];
  }

  const taskMeta =
    task && typeof task === "object" ? task : userStateReadTask(list);
  const key = userStateCacheKey(list);
  return await serverStateTaskBridge.ensure({
    key,
    fetcher: ({ signal }) =>
      fetchUserStates(list, {
        ...options,
        signal,
        communicationScene: options.communicationScene || "user-state-read",
      }),
    ttlMs: USER_STATE_CACHE_TTL_MS,
    ownerScope: currentUserStateOwnerScope(),
    scope: taskMeta.scope || userStateScope(list),
    priority: taskMeta.priority || "P2",
    policy: taskMeta.policy || "background",
    resource: taskMeta.resource || "network",
    kind: taskMeta.kind || "user-state",
    label: taskMeta.label || `user-state:read:${list.join(",") || "all"}`,
    intentRank: taskMeta.intentRank,
    protected: taskMeta.protected,
    signal: options.signal,
    staleWhileRevalidate: options.staleWhileRevalidate !== false,
    dedupeKey: `server-state:${key}`,
    meta: { namespaces: list },
  });
}

export async function patchUserStates(states = [], options = {}) {
  const list = Array.isArray(states) ? states : [states];
  const mutations = syncV2ClientEnabled()
    ? list.map((state) => syncV2PreferenceMutation(state))
    : [];
  if (mutations.length && mutations.every(Boolean)) {
    await Promise.all(
      list.map((state, index) =>
        serializePreferenceOperation(state, () =>
          syncMutationQueue.submit(
            // Build the mutation only when its same-node predecessor has
            // settled so baseVersion observes the descriptor it committed.
            syncV2PreferenceMutation(state) || mutations[index],
            {
              allowOffline: options.allowOffline !== false,
            }
          )
        )
      )
    );
    invalidateUserStateCache();
    return list;
  }
  const write = async () =>
    patchJson(
      "/system/user/state",
      { states: list },
      {
        ...options,
        communicationScene: options.communicationScene || "user-state-write",
        task:
          options.task === undefined
            ? userStateWriteTask(states, "write")
            : options.task,
      }
    );
  // Most user-state writes are single-node. Preserve multi-node REST batching,
  // while serializing single-node fallback writes with deletes for last-intent
  // ordering even when Sync V2 is disabled.
  const { data } =
    list.length === 1
      ? await serializePreferenceOperation(list[0], write)
      : await write();
  invalidateUserStateCache();
  return data?.states || [];
}

export async function deleteUserState(
  { namespace, scope = null } = {},
  options = {}
) {
  const mutation = syncV2ClientEnabled()
    ? syncV2PreferenceMutation(
        { namespace, scope: scope || "global", value: null },
        "delete"
      )
    : null;
  if (mutation) {
    const result = await serializePreferenceOperation(
      { namespace, scope: scope || "global" },
      () =>
        syncMutationQueue.submit(
          syncV2PreferenceMutation(
            { namespace, scope: scope || "global", value: null },
            "delete"
          ) || mutation,
          {
            allowOffline: options.allowOffline !== false,
          }
        )
    );
    invalidateUserStateCache();
    return { success: true, ...result };
  }
  const { data } = await serializePreferenceOperation(
    { namespace, scope: scope || "global" },
    () =>
      deleteJson("/system/user/state", {
        ...options,
        communicationScene: options.communicationScene || "user-state-delete",
        task:
          options.task === undefined
            ? userStateWriteTask([{ namespace }], "delete")
            : options.task,
        body: { namespace, scope },
      })
  );
  invalidateUserStateCache();
  return data || { success: false, error: "empty_response" };
}
