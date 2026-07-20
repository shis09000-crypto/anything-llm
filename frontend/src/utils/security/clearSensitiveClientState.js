import {
  AUTH_TIMESTAMP,
  LAST_USER_ACTION_AT,
  LAST_VISITED_WORKSPACE,
  LAST_VISITED_WORKSPACE_THREADS,
  USER_PROMPT_INPUT_MAP,
} from "@/utils/constants";
import { removeAuthToken } from "@/utils/authTokenStorage";
import {
  getStoredAuthUser,
  removeStoredAuthUser,
} from "@/utils/authUserStorage";
import { getAppEnvironment, storageKeys } from "@/utils/appEnvironment";
import { threadHistoryCache } from "@/utils/chat/threadHistoryCache";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { clearLocalCacheCryptoKeys } from "@/utils/security/localCacheCrypto";
import { lockVault } from "@/utils/security/vaultCrypto";
import { clearVaultAccessGrant } from "@/lib/communication/vaultClient";
import { serverStateCache } from "@/utils/serverState/serverStateCache";

const CHAT_THREAD_DRAFT_PREFIX = "chat-thread-draft:";
const CHAT_THREAD_ACTIVE_RUNNING_KEY = "chat-thread-active-running";

function currentSyncOwnerScope() {
  const user = getStoredAuthUser();
  return [
    getAppEnvironment(),
    user?.authUserId || user?.id || user?.username || "anonymous",
  ].join(":");
}

function removeLocalStorageKeys(keys = []) {
  if (typeof window === "undefined") return;
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  }
}

function removeSessionStorageByPrefix(prefixes = []) {
  if (typeof window === "undefined") return;
  try {
    storageKeys(window.sessionStorage).forEach((key) => {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        window.sessionStorage.removeItem(key);
      }
    });
  } catch {}
}

function removeLocalStorageByPrefix(prefixes = []) {
  if (typeof window === "undefined") return;
  try {
    storageKeys(window.localStorage).forEach((key) => {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        window.localStorage.removeItem(key);
      }
    });
  } catch {}
}

export function clearSensitiveClientCaches() {
  const syncOwnerScope = currentSyncOwnerScope();
  removeLocalStorageKeys([
    USER_PROMPT_INPUT_MAP,
    LAST_VISITED_WORKSPACE,
    LAST_VISITED_WORKSPACE_THREADS,
  ]);
  removeLocalStorageByPrefix([`athena-sync-v2:2:${syncOwnerScope}:`]);
  removeSessionStorageByPrefix([CHAT_THREAD_DRAFT_PREFIX]);
  try {
    window.sessionStorage.removeItem(CHAT_THREAD_ACTIVE_RUNNING_KEY);
  } catch {}
  threadHistoryCache.clearAll();
  workspaceNavigationCache.clear();
  serverStateCache.clear();
  void Promise.all([
    import("@/utils/syncV2/syncV2StateStore").then(({ syncV2StateStore }) =>
      syncV2StateStore.clear(syncOwnerScope)
    ),
    import("@/utils/syncV2/syncV2NodeArchive").then(({ syncV2NodeArchive }) =>
      syncV2NodeArchive.clear(syncOwnerScope)
    ),
    import("@/utils/syncV2/syncMutationQueue").then(({ syncMutationQueue }) =>
      syncMutationQueue.clearCurrentScope(syncOwnerScope)
    ),
    import("@/utils/syncV2/syncV2Runtime").then(({ syncV2Runtime }) =>
      syncV2Runtime.reset()
    ),
  ])
    .catch(() => null)
    .finally(() => clearLocalCacheCryptoKeys().catch(() => {}));
}

export function clearSensitiveClientSession({
  includeDurableCaches = true,
} = {}) {
  if (includeDurableCaches) clearSensitiveClientCaches();
  clearVaultAccessGrant();
  lockVault();
  removeStoredAuthUser();
  removeLocalStorageKeys([AUTH_TIMESTAMP, LAST_USER_ACTION_AT]);
  removeAuthToken();
}
