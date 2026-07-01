import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { recordCommunicationEvent } from "@/lib/communication/communicationMetrics";
import AccountSettingsApi from "./accountSettingsApi";

const CACHE_TTL_MS = 5 * 60_000;
const AccountSettingsDataContext = createContext(null);

export function AccountSettingsDataProvider({ user, children }) {
  const cacheRef = useRef(new Map());
  const inFlightRef = useRef(new Map());
  const [stats, setStats] = useState(emptyStats());

  const refreshStats = useCallback(() => {
    const entries = [...cacheRef.current.entries()].map(([key, entry]) => ({
      key,
      updatedAt: entry.updatedAt,
      bytes: byteLength(entry.value),
    }));
    setStats({
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      inFlight: [...inFlightRef.current.keys()],
    });
  }, []);

  const getCached = useCallback((key) => {
    const entry = cacheRef.current.get(key);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > CACHE_TTL_MS) return null;
    return entry.value;
  }, []);

  const setCached = useCallback(
    (key, value) => {
      cacheRef.current.set(key, { value, updatedAt: Date.now() });
      refreshStats();
      return value;
    },
    [refreshStats]
  );

  const loadCached = useCallback(
    async (key, loader, { force = false } = {}) => {
      if (!force) {
        const cached = getCached(key);
        if (cached) {
          recordAccountCacheEvent("hit", key);
          return cached;
        }
      }

      if (!force && inFlightRef.current.has(key)) {
        recordAccountCacheEvent("dedupe", key);
        return inFlightRef.current.get(key);
      }

      recordAccountCacheEvent(force ? "refresh" : "miss", key);
      const startedAt = performance.now();
      const promise = Promise.resolve()
        .then(loader)
        .then((value) => {
          recordAccountCacheEvent("loaded", key, {
            durationMs: Math.round(performance.now() - startedAt),
          });
          return setCached(key, value);
        })
        .finally(() => {
          inFlightRef.current.delete(key);
          refreshStats();
        });
      inFlightRef.current.set(key, promise);
      refreshStats();
      return promise;
    },
    [getCached, refreshStats, setCached]
  );

  const loadPasskeys = useCallback(
    (options = {}) =>
      loadCached("passkeys", () => AccountSettingsApi.fetchPasskeys(), options),
    [loadCached]
  );

  const loadTrustedDevices = useCallback(
    (options = {}) =>
      loadCached(
        "trustedDevices",
        () =>
          AccountSettingsApi.fetchTrustedLoginDevices({
            user,
            avatarUrl: options.avatarUrl,
          }),
        options
      ),
    [loadCached, user]
  );

  const loadEmailStatus = useCallback(
    (options = {}) =>
      loadCached(
        "emailStatus",
        () => AccountSettingsApi.emailStatus(),
        options
      ),
    [loadCached]
  );

  const loadMemoryOverview = useCallback(
    (options = {}) =>
      loadCached(
        "memoryOverview",
        () => AccountSettingsApi.fetchMemoryOverview(),
        options
      ),
    [loadCached]
  );

  const clear = useCallback(
    (key) => {
      if (key) cacheRef.current.delete(key);
      else cacheRef.current.clear();
      refreshStats();
    },
    [refreshStats]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.__anythingAccountSettings = {
      cacheStats: () => stats,
    };
  }, [stats]);

  const value = useMemo(
    () => ({
      getCached,
      setCached,
      loadCached,
      loadPasskeys,
      loadTrustedDevices,
      loadEmailStatus,
      loadMemoryOverview,
      clear,
      stats,
    }),
    [
      clear,
      getCached,
      loadCached,
      loadEmailStatus,
      loadMemoryOverview,
      loadPasskeys,
      loadTrustedDevices,
      setCached,
      stats,
    ]
  );

  return (
    <AccountSettingsDataContext.Provider value={value}>
      {children}
    </AccountSettingsDataContext.Provider>
  );
}

export function useAccountSettingsData() {
  return useContext(AccountSettingsDataContext);
}

function recordAccountCacheEvent(action, key, extra = {}) {
  recordCommunicationEvent({
    type: "account-settings-cache",
    method: "CACHE",
    path: `account-settings:${key}`,
    status: 200,
    durationMs: extra.durationMs || 0,
    requestBytes: 0,
    responseBytes: 0,
    ok: true,
    accountSettings: { action, key },
  });
}

function byteLength(value) {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

function emptyStats() {
  return {
    entries: [],
    totalBytes: 0,
    inFlight: [],
  };
}
