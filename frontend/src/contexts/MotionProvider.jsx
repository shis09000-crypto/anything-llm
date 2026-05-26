import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Appearance from "@/models/appearance";

export const MOTION_DENSITIES = {
  minimal: "Minimal",
  balanced: "Balanced",
  expressive: "Expressive",
};

const MOTION_BUDGETS = {
  route: 1,
  page: 1,
  panel: 2,
  modal: 1,
  popover: 3,
  tooltip: 3,
  list: 8,
  micro: 16,
  skeleton: 12,
};

const MotionContext = createContext(null);

function prefersReducedMotion() {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

function normalizeDensity(value) {
  return Object.keys(MOTION_DENSITIES).includes(value) ? value : "balanced";
}

export function MotionProvider({ children }) {
  const [motionDensity, _setMotionDensity] = useState(() =>
    normalizeDensity(Appearance.get("motionDensity"))
  );
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const reducedMotionRef = useRef(reducedMotion);
  const [debugOpen, setDebugOpen] = useState(() => {
    if (!import.meta.env.DEV) return false;
    return localStorage.getItem("motionDebug") === "true";
  });
  const [activeMotions, setActiveMotions] = useState([]);
  const [routeDebug, setRouteDebug] = useState(null);
  const activeMotionsRef = useRef([]);

  const syncActiveMotions = useCallback((next) => {
    activeMotionsRef.current = next;
    setActiveMotions(next);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-motion-density", motionDensity);
  }, [motionDensity]);

  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-reduced-motion",
      reducedMotion
    );
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const onChange = (event) => setReducedMotion(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    function toggleDebug(event) {
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        setDebugOpen((prev) => {
          localStorage.setItem("motionDebug", String(!prev));
          return !prev;
        });
      }
    }
    document.addEventListener("keydown", toggleDebug);
    return () => document.removeEventListener("keydown", toggleDebug);
  }, []);

  const setMotionDensity = useCallback((nextDensity) => {
    const normalized = normalizeDensity(nextDensity);
    Appearance.set("motionDensity", normalized);
    _setMotionDensity(normalized);
  }, []);

  const requestMotion = useCallback(
    ({ category, token, duration = 0 }) => {
      if (reducedMotionRef.current) {
        return { allowed: false, reason: "reduced-motion" };
      }

      const current = activeMotionsRef.current;
      const limit = MOTION_BUDGETS[category] ?? 4;
      const activeInCategory = current.filter(
        (motion) => motion.category === category
      ).length;
      if (activeInCategory >= limit) {
        return { allowed: false, reason: "budget-exceeded" };
      }

      const id = `${category}:${token}:${Date.now()}:${Math.random()
        .toString(16)
        .slice(2)}`;
      const motion = {
        id,
        category,
        token,
        duration,
        startedAt: performance.now(),
        limit,
      };
      syncActiveMotions([...current, motion]);

      const timeout = window.setTimeout(
        () => {
          syncActiveMotions(
            activeMotionsRef.current.filter((item) => item.id !== id)
          );
        },
        Math.max(duration, 0) + 80
      );

      return {
        allowed: true,
        id,
        end: () => {
          window.clearTimeout(timeout);
          syncActiveMotions(
            activeMotionsRef.current.filter((item) => item.id !== id)
          );
        },
      };
    },
    [syncActiveMotions]
  );

  const reportRouteMotion = useCallback((details = null) => {
    if (!import.meta.env.DEV) return;
    setRouteDebug(details ? { ...details, updatedAt: Date.now() } : null);
  }, []);

  const value = useMemo(
    () => ({
      motionDensity,
      reducedMotion,
      reportRouteMotion,
      requestMotion,
      setMotionDensity,
    }),
    [
      motionDensity,
      reducedMotion,
      reportRouteMotion,
      requestMotion,
      setMotionDensity,
    ]
  );

  return (
    <MotionContext.Provider value={value}>
      {children}
      <MotionDebugOverlay
        activeMotions={activeMotions}
        budgets={MOTION_BUDGETS}
        debugOpen={debugOpen}
        motionDensity={motionDensity}
        reducedMotion={reducedMotion}
        routeDebug={routeDebug}
      />
    </MotionContext.Provider>
  );
}

export function useMotion() {
  const context = useContext(MotionContext);
  if (!context) {
    throw new Error("useMotion must be used within MotionProvider");
  }
  return context;
}

function MotionDebugOverlay({
  activeMotions,
  budgets,
  debugOpen,
  motionDensity,
  reducedMotion,
  routeDebug,
}) {
  if (!import.meta.env.DEV || !debugOpen) return null;

  return (
    <div className="motion-debug-overlay">
      <div className="motion-debug-title">Motion Debug</div>
      <div>density: {motionDensity}</div>
      <div>reduced: {String(reducedMotion)}</div>
      <div>active: {activeMotions.length}</div>
      {routeDebug && (
        <div className="motion-debug-route">
          <div>route: {routeDebug.phase}</div>
          <div>key: {routeDebug.routeKey}</div>
          <div>token: {routeDebug.token}</div>
          <div>duration: {routeDebug.duration}ms</div>
          <div>mode: {routeDebug.mode}</div>
          <div>budget: {routeDebug.budgetReason || "allowed"}</div>
        </div>
      )}
      {activeMotions.map((motion) => (
        <div key={motion.id} className="motion-debug-row">
          <span>{motion.category}</span>
          <span>{motion.token}</span>
          <span>{motion.duration}ms</span>
          <span>
            {
              activeMotions.filter((item) => item.category === motion.category)
                .length
            }
            /{motion.limit}
          </span>
        </div>
      ))}
      {Object.entries(budgets).map(([category, limit]) => (
        <div key={category} className="motion-debug-budget">
          {category}:{" "}
          {activeMotions.filter((item) => item.category === category).length}/
          {limit}
        </div>
      ))}
    </div>
  );
}
