import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import WorkspaceHealth from "@/models/workspaceHealth";

const HEALTH_POLL_INTERVAL_MS = 45_000;
const SCORE_DEBOUNCE_MS = 220;
const healthCache = new Map();

const WorkspaceHealthContext = createContext(null);

export function WorkspaceHealthProvider({ workspaceSlug, children }) {
  const [beacon, setBeacon] = useState(() => {
    return workspaceSlug ? healthCache.get(workspaceSlug) || null : null;
  });
  const [displayScore, setDisplayScore] = useState(() => {
    const cached = workspaceSlug ? healthCache.get(workspaceSlug) : null;
    return cached?.unknown ? null : (cached?.score ?? null);
  });
  const [loading, setLoading] = useState(false);
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);
  const scoreTimer = useRef(null);

  const applyBeacon = useCallback(
    (nextBeacon) => {
      if (!nextBeacon) return;
      healthCache.set(workspaceSlug, nextBeacon);
      setBeacon(nextBeacon);
      setCooldownRemainingMs(nextBeacon.cooldownRemainingMs || 0);
      clearTimeout(scoreTimer.current);
      if (nextBeacon.unknown) {
        setDisplayScore(null);
        return;
      }
      scoreTimer.current = setTimeout(() => {
        setDisplayScore(nextBeacon.score);
      }, SCORE_DEBOUNCE_MS);
    },
    [workspaceSlug]
  );

  const loadBeacon = useCallback(async () => {
    if (!workspaceSlug) return null;
    setLoading(true);
    const nextBeacon = await WorkspaceHealth.beacon(workspaceSlug);
    applyBeacon(nextBeacon);
    setLoading(false);
    return nextBeacon;
  }, [applyBeacon, workspaceSlug]);

  const refreshBeacon = useCallback(async () => {
    if (!workspaceSlug || cooldownRemainingMs > 0) return beacon;
    setLoading(true);
    const nextBeacon = await WorkspaceHealth.refresh(workspaceSlug);
    applyBeacon(nextBeacon);
    setLoading(false);
    return nextBeacon;
  }, [applyBeacon, beacon, cooldownRemainingMs, workspaceSlug]);

  useEffect(() => {
    if (!workspaceSlug) return;
    loadBeacon();
    const interval = setInterval(loadBeacon, HEALTH_POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(scoreTimer.current);
    };
  }, [loadBeacon, workspaceSlug]);

  useEffect(() => {
    if (cooldownRemainingMs <= 0) return;
    const tick = setInterval(() => {
      setCooldownRemainingMs((current) => Math.max(0, current - 1_000));
    }, 1_000);
    return () => clearInterval(tick);
  }, [cooldownRemainingMs]);

  const value = useMemo(
    () => ({
      beacon,
      displayScore,
      loading,
      cooldownRemainingMs,
      loadBeacon,
      refreshBeacon,
    }),
    [
      beacon,
      cooldownRemainingMs,
      displayScore,
      loadBeacon,
      loading,
      refreshBeacon,
    ]
  );

  return (
    <WorkspaceHealthContext.Provider value={value}>
      {children}
    </WorkspaceHealthContext.Provider>
  );
}

export function useWorkspaceHealth() {
  return useContext(WorkspaceHealthContext);
}
