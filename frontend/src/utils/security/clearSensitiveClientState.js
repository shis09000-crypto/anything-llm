import {
  AUTH_TIMESTAMP,
  LAST_USER_ACTION_AT,
  LAST_VISITED_WORKSPACE,
  LAST_VISITED_WORKSPACE_THREADS,
  USER_PROMPT_INPUT_MAP,
} from "@/utils/constants";
import { removeAuthToken } from "@/utils/authTokenStorage";
import { removeStoredAuthUser } from "@/utils/authUserStorage";
import { storageKeys } from "@/utils/appEnvironment";
import { threadHistoryCache } from "@/utils/chat/threadHistoryCache";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { clearLocalCacheCryptoKeys } from "@/utils/security/localCacheCrypto";
import { lockVault } from "@/utils/security/vaultCrypto";
import { clearVaultAccessGrant } from "@/lib/communication/vaultClient";

const CHAT_THREAD_DRAFT_PREFIX = "chat-thread-draft:";
const CHAT_THREAD_ACTIVE_RUNNING_KEY = "chat-thread-active-running";

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

export function clearSensitiveClientCaches() {
  removeLocalStorageKeys([
    USER_PROMPT_INPUT_MAP,
    LAST_VISITED_WORKSPACE,
    LAST_VISITED_WORKSPACE_THREADS,
  ]);
  removeSessionStorageByPrefix([CHAT_THREAD_DRAFT_PREFIX]);
  try {
    window.sessionStorage.removeItem(CHAT_THREAD_ACTIVE_RUNNING_KEY);
  } catch {}
  threadHistoryCache.clearAll();
  workspaceNavigationCache.clear();
  void clearLocalCacheCryptoKeys().catch(() => {});
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
