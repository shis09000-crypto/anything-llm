import React, { useEffect, useRef, useState } from "react";
import { useLocation, useOutlet } from "react-router-dom";
import { useMotion } from "@/contexts/MotionProvider";

const ROUTE_DURATION = 700;
const ROUTE_FALLBACK_DURATION = 180;

function routeKey(location) {
  return `${location.pathname}${location.search}`;
}

function animationModeClass(prefix, mode) {
  if (mode === "full") return `motion-route-${prefix}`;
  if (mode === "fade") return `motion-route-${prefix}-fade`;
  return "motion-route-static";
}

export default function MotionRouteOutlet() {
  const outlet = useOutlet();
  const location = useLocation();
  const routeId = routeKey(location);
  const { reducedMotion, requestMotion, reportRouteMotion } = useMotion();
  const [current, setCurrent] = useState(() => ({
    key: routeId,
    outlet,
    mode: "static",
  }));
  const [exiting, setExiting] = useState([]);
  const currentRef = useRef(current);
  const exitTimersRef = useRef(new Map());

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    return () => {
      for (const timeout of exitTimersRef.current.values()) {
        window.clearTimeout(timeout);
      }
      exitTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const nextKey = routeId;
    const previous = currentRef.current;

    if (previous.key === nextKey) {
      return;
    }

    const routeMotion = requestMotion({
      category: "route",
      token: "motion-route-transition",
      duration: ROUTE_DURATION,
    });
    const exitId = `${previous.key}:${Date.now()}`;
    const mode = reducedMotion
      ? "static"
      : routeMotion.allowed
        ? "full"
        : routeMotion.reason === "budget-exceeded"
          ? "fade"
          : "static";
    const duration = mode === "fade" ? ROUTE_FALLBACK_DURATION : ROUTE_DURATION;

    reportRouteMotion({
      budgetReason: routeMotion.reason,
      duration,
      mode,
      phase: "transitioning",
      routeKey: nextKey,
      token: "motion-route-transition",
    });

    if (mode !== "static") {
      setExiting((items) => [
        ...items,
        {
          id: exitId,
          key: previous.key,
          outlet: previous.outlet,
          mode,
        },
      ]);
      const timeout = window.setTimeout(() => removeExiting(exitId), duration);
      exitTimersRef.current.set(exitId, timeout);
    }

    setCurrent({ key: nextKey, outlet, mode });
  }, [routeId, outlet, reducedMotion, requestMotion, reportRouteMotion]);

  useEffect(() => {
    const activeRoute = currentRef.current;
    if (activeRoute.key !== routeId || activeRoute.outlet === outlet) return;
    setCurrent((prev) => {
      if (prev.key !== routeId || prev.outlet === outlet) return prev;
      return { ...prev, outlet };
    });
  }, [outlet, routeId]);

  function removeExiting(exitId) {
    const timeout = exitTimersRef.current.get(exitId);
    if (timeout) window.clearTimeout(timeout);
    exitTimersRef.current.delete(exitId);
    setExiting((items) => items.filter((item) => item.id !== exitId));
    reportRouteMotion({
      duration: 0,
      mode: "static",
      phase: "settled",
      routeKey: currentRef.current.key,
      token: "motion-route-transition",
    });
  }

  return (
    <div className="motion-route-stack">
      {exiting.map((route) => (
        <div
          key={route.id}
          className={`motion-route-layer motion-route-exiting pointer-events-none ${animationModeClass(
            "exit",
            route.mode
          )}`}
          data-motion-route-key={route.key}
          data-motion-route-phase="exit"
          aria-hidden="true"
          inert=""
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) removeExiting(route.id);
          }}
        >
          {route.outlet}
        </div>
      ))}
      <div
        key={current.key}
        className={`motion-route-layer motion-route-current ${animationModeClass(
          "enter",
          current.mode
        )}`}
        data-motion-route-key={current.key}
        data-motion-route-phase={current.mode === "static" ? "static" : "enter"}
      >
        {current.outlet}
      </div>
    </div>
  );
}
