import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

const DEFAULT_THRESHOLD_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 10_000;
const DEFAULT_INTERVAL_MS = 1_000;
const UNHEALTHY_STATUSES = new Set(["degraded", "disconnected", "error"]);

type CryptoHubWatchedConnection = {
  key: string;
  active: boolean;
  status: string | null | undefined;
  lastConnectedAt?: number | null;
  reconnect: () => void | Promise<void>;
};

type CryptoHubWatchdogEntry = CryptoHubWatchedConnection & {
  unhealthySince: number | null;
  lastForcedReconnectAt: number | null;
};

type CryptoHubWatchdogContextValue = {
  registerConnection: (connection: CryptoHubWatchedConnection) => void;
  unregisterConnection: (key: string) => void;
};

const CryptoHubWatchdogContext =
  createContext<CryptoHubWatchdogContextValue | null>(null);

function isUnhealthy(status: string | null | undefined) {
  return UNHEALTHY_STATUSES.has(String(status || "").toLowerCase());
}

export function CryptoHubWatchdogProvider({
  children,
  thresholdMs = DEFAULT_THRESHOLD_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
}: {
  children: React.ReactNode;
  thresholdMs?: number;
  cooldownMs?: number;
  intervalMs?: number;
}) {
  const entriesRef = useRef<Map<string, CryptoHubWatchdogEntry>>(new Map());

  const unregisterConnection = useCallback((key: string) => {
    entriesRef.current.delete(key);
  }, []);

  const registerConnection = useCallback(
    (connection: CryptoHubWatchedConnection) => {
      const current = entriesRef.current.get(connection.key);
      const unhealthy = connection.active && isUnhealthy(connection.status);
      entriesRef.current.set(connection.key, {
        ...connection,
        unhealthySince: unhealthy
          ? current?.unhealthySince || Date.now()
          : null,
        lastForcedReconnectAt: current?.lastForcedReconnectAt || null,
      });
    },
    []
  );

  const evaluate = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    const timestamp = Date.now();

    for (const entry of entriesRef.current.values()) {
      if (!entry.active) continue;
      if (!isUnhealthy(entry.status)) {
        entry.unhealthySince = null;
        continue;
      }

      entry.unhealthySince = entry.unhealthySince || timestamp;
      if (timestamp - entry.unhealthySince < thresholdMs) continue;
      if (
        entry.lastForcedReconnectAt &&
        timestamp - entry.lastForcedReconnectAt < cooldownMs
      ) {
        continue;
      }

      entry.lastForcedReconnectAt = timestamp;
      Promise.resolve(entry.reconnect()).catch(() => {
        // The component's own error state remains the user-facing source.
      });
    }
  }, [cooldownMs, thresholdMs]);

  useEffect(() => {
    const timer = window.setInterval(evaluate, intervalMs);
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") evaluate();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [evaluate, intervalMs]);

  const contextValue = useMemo(
    () => ({ registerConnection, unregisterConnection }),
    [registerConnection, unregisterConnection]
  );

  return (
    <CryptoHubWatchdogContext.Provider value={contextValue}>
      {children}
    </CryptoHubWatchdogContext.Provider>
  );
}

export function useCryptoHubWatchedConnection({
  key,
  active,
  status,
  lastConnectedAt = null,
  reconnect,
}: CryptoHubWatchedConnection) {
  const context = useContext(CryptoHubWatchdogContext);
  const reconnectRef = useRef(reconnect);

  useEffect(() => {
    reconnectRef.current = reconnect;
  }, [reconnect]);

  useEffect(() => {
    if (!context) return;
    context.registerConnection({
      key,
      active,
      status,
      lastConnectedAt,
      reconnect: () => reconnectRef.current(),
    });
    return () => context.unregisterConnection(key);
  }, [active, context, key, lastConnectedAt, status]);
}
