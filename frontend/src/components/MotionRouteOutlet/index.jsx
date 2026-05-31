import React, { useEffect, useRef, useState } from "react";
import { useLocation, useOutlet } from "react-router-dom";
import { useMotion } from "@/contexts/MotionProvider";

const ROUTE_DURATION = 700;
const ROUTE_FALLBACK_DURATION = 180;
const WORKSPACE_CHAT_ROUTE_PATTERN = /^\/workspace\/([^/]+)(?:\/t\/[^/]+)?\/?$/;
const WORKSPACE_CHAT_SURFACE_KEY = "/workspace-chat-surface";

function rawRouteKey(location) {
  return `${location.pathname}${location.search}`;
}

function motionRouteKey(location) {
  if (WORKSPACE_CHAT_ROUTE_PATTERN.test(location.pathname))
    return WORKSPACE_CHAT_SURFACE_KEY;
  return rawRouteKey(location);
}

function threadSwitchFlickerDebugEnabled() {
  try {
    return (
      import.meta.env.DEV &&
      (window.localStorage.getItem("threadSwitchFlickerDebug") === "true" ||
        window.localStorage.getItem("workspaceSwitchFlickerDebug") === "true")
    );
  } catch {
    return false;
  }
}

function debugThreadSwitchFlicker(label, payload = {}) {
  if (!threadSwitchFlickerDebugEnabled()) return;
  console.debug("[thread-switch-flicker]", label, payload);
}

function animationModeClass(prefix, mode) {
  if (mode === "full") return `motion-route-${prefix}`;
  if (mode === "fade") return `motion-route-${prefix}-fade`;
  return "motion-route-static";
}

function isSameRouteOutlet(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.type === right.type && left.key === right.key;
}

export default function MotionRouteOutlet() {
  const outlet = useOutlet();
  const location = useLocation();
  const rawKey = rawRouteKey(location);
  const motionKey = motionRouteKey(location);
  const { reducedMotion, requestMotion, reportRouteMotion } = useMotion();
  const [current, setCurrent] = useState(() => ({
    rawKey,
    motionKey,
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
    const nextRawKey = rawKey;
    const nextMotionKey = motionKey;
    const previous = currentRef.current;

    if (previous.rawKey === nextRawKey) {
      return;
    }

    if (previous.motionKey === nextMotionKey) {
      const reason =
        nextMotionKey === WORKSPACE_CHAT_SURFACE_KEY
          ? "workspace-chat-surface"
          : "same-motion-surface";
      debugThreadSwitchFlicker("MotionRouteOutlet:skip", {
        animated: false,
        reason,
        previousRawKey: previous.rawKey,
        previousMotionKey: previous.motionKey,
        nextRawKey,
        nextMotionKey,
        routeCategory:
          nextMotionKey === WORKSPACE_CHAT_SURFACE_KEY
            ? "workspace-chat"
            : "default",
        exitingLayerCount: document.querySelectorAll(".motion-route-exiting")
          .length,
      });
      reportRouteMotion({
        animated: false,
        duration: 0,
        mode: "static",
        phase: "same-surface-skip",
        reason,
        routeKey: nextRawKey,
        motionRouteKey: nextMotionKey,
        token: "motion-route-transition",
      });
      setCurrent({
        rawKey: nextRawKey,
        motionKey: nextMotionKey,
        outlet,
        mode: "static",
      });
      return;
    }

    const routeMotion = requestMotion({
      category: "route",
      token: "motion-route-transition",
      duration: ROUTE_DURATION,
    });
    const exitId = `${previous.rawKey}:${Date.now()}`;
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
      routeKey: nextRawKey,
      motionRouteKey: nextMotionKey,
      token: "motion-route-transition",
    });
    debugThreadSwitchFlicker("MotionRouteOutlet:animate", {
      animated: mode !== "static",
      budgetReason: routeMotion.reason,
      duration,
      mode,
      previousRawKey: previous.rawKey,
      previousMotionKey: previous.motionKey,
      nextRawKey,
      nextMotionKey,
      routeCategory:
        nextMotionKey === WORKSPACE_CHAT_SURFACE_KEY
          ? "workspace-chat"
          : "default",
      exitingLayerCount: document.querySelectorAll(".motion-route-exiting")
        .length,
    });

    if (mode !== "static") {
      setExiting((items) => [
        ...items,
        {
          id: exitId,
          rawKey: previous.rawKey,
          motionKey: previous.motionKey,
          outlet: previous.outlet,
          mode,
        },
      ]);
      const timeout = window.setTimeout(() => removeExiting(exitId), duration);
      exitTimersRef.current.set(exitId, timeout);
    }

    setCurrent({
      rawKey: nextRawKey,
      motionKey: nextMotionKey,
      outlet,
      mode,
    });
  }, [
    rawKey,
    motionKey,
    outlet,
    reducedMotion,
    requestMotion,
    reportRouteMotion,
  ]);

  useEffect(() => {
    const activeRoute = currentRef.current;
    if (
      activeRoute.rawKey !== rawKey ||
      isSameRouteOutlet(activeRoute.outlet, outlet)
    )
      return;
    setCurrent((prev) => {
      if (prev.rawKey !== rawKey || isSameRouteOutlet(prev.outlet, outlet))
        return prev;
      return { ...prev, outlet };
    });
  }, [outlet, rawKey]);

  function removeExiting(exitId) {
    const timeout = exitTimersRef.current.get(exitId);
    if (timeout) window.clearTimeout(timeout);
    exitTimersRef.current.delete(exitId);
    setExiting((items) => items.filter((item) => item.id !== exitId));
    reportRouteMotion({
      duration: 0,
      mode: "static",
      phase: "settled",
      routeKey: currentRef.current.rawKey,
      motionRouteKey: currentRef.current.motionKey,
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
          data-motion-route-key={route.rawKey}
          data-motion-route-motion-key={route.motionKey}
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
        key={current.motionKey}
        className={`motion-route-layer motion-route-current ${animationModeClass(
          "enter",
          current.mode
        )}`}
        data-motion-route-key={current.rawKey}
        data-motion-route-motion-key={current.motionKey}
        data-motion-route-phase={current.mode === "static" ? "static" : "enter"}
      >
        {current.outlet}
      </div>
    </div>
  );
}
