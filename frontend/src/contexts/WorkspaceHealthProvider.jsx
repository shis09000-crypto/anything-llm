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
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";

const HEALTH_POLL_INTERVAL_MS = 45_000;
const SCORE_DEBOUNCE_MS = 220;
const healthCache = new Map();

const WorkspaceHealthContext = createContext(null);

export function WorkspaceHealthProvider({
  workspaceSlug,
  children,
  autoLoad = false,
  idleDelayMs = 0,
  communicationScene = "health-idle",
}) {
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
  const loadAbortRef = useRef(null);

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

  const loadBeacon = useCallback(
    async (options = {}) => {
      if (!workspaceSlug) return null;
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      const priority = options.priority || (autoLoad ? "P1" : "P4");
      const scene = options.communicationScene || communicationScene;
      setLoading(true);
      try {
        const nextBeacon = await requestPriorityQueue.schedule(
          () =>
            WorkspaceHealth.beacon(workspaceSlug, {
              signal: controller.signal,
              communicationScene: scene,
            }),
          {
            priority,
            signal: controller.signal,
            label: "workspace-health:beacon",
            dedupeKey: `workspace-health:${workspaceSlug}`,
          }
        );
        if (!controller.signal.aborted && nextBeacon) applyBeacon(nextBeacon);
        return nextBeacon;
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [applyBeacon, autoLoad, communicationScene, workspaceSlug]
  );

  const refreshBeacon = useCallback(async () => {
    if (!workspaceSlug || cooldownRemainingMs > 0) return beacon;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    try {
      const nextBeacon = await WorkspaceHealth.refresh(workspaceSlug, {
        signal: controller.signal,
        communicationScene: "settings-tab",
      });
      if (!controller.signal.aborted) applyBeacon(nextBeacon);
      return nextBeacon;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [applyBeacon, beacon, cooldownRemainingMs, workspaceSlug]);

  useEffect(() => {
    if (!workspaceSlug) return;
    if (!autoLoad && !idleDelayMs) return;
    const startLoad = () => loadBeacon({ priority: autoLoad ? "P1" : "P4" });
    const timeout = autoLoad
      ? setTimeout(startLoad, 0)
      : setTimeout(startLoad, idleDelayMs);
    const interval = setInterval(loadBeacon, HEALTH_POLL_INTERVAL_MS);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
      clearTimeout(scoreTimer.current);
      loadAbortRef.current?.abort();
    };
  }, [autoLoad, idleDelayMs, loadBeacon, workspaceSlug]);

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
