import { deleteJson, getJson, patchJson } from "./apiClient";
import { getAppEnvironment } from "@/utils/appEnvironment";
import { getStoredAuthUser } from "@/utils/authUserStorage";
import { serverStateCache } from "@/utils/serverState/serverStateCache";
import { serverStateTaskBridge } from "@/utils/serverState/serverStateTaskBridge";
import { isSensitiveStateKey } from "@/utils/sensitive/sensitiveDataGuards";

export const USER_STATE_NAMESPACES = {
  recentNavigation: "recent.navigation",
  appearance: "preferences.appearance",
  workspaceLayout: "workspace.layout",
  workspaceOrder: "workspace.order",
  readerProgress: "reader.progress",
  readerLibrary: "reader.library",
  chatDraft: "chat.draft",
  cryptoUi: "crypto.ui",
};

const USER_STATE_CACHE_TTL_MS = 30_000;
const USER_STATE_CACHE_PREFIX = "user-state:";

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
  const { data } = await patchJson(
    "/system/user/state",
    { states: Array.isArray(states) ? states : [states] },
    {
      ...options,
      communicationScene: options.communicationScene || "user-state-write",
      task:
        options.task === undefined
          ? userStateWriteTask(states, "write")
          : options.task,
    }
  );
  invalidateUserStateCache();
  return data?.states || [];
}

export async function deleteUserState(
  { namespace, scope = null } = {},
  options = {}
) {
  const { data } = await deleteJson("/system/user/state", {
    ...options,
    communicationScene: options.communicationScene || "user-state-delete",
    task:
      options.task === undefined
        ? userStateWriteTask([{ namespace }], "delete")
        : options.task,
    body: { namespace, scope },
  });
  invalidateUserStateCache();
  return data || { success: false, error: "empty_response" };
}
