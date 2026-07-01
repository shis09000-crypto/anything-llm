import {
  isPersistentSettingsRoute,
  SETTINGS_SOFT_SURFACE_KEY,
} from "./settingsRoutes.js";

export const WORKSPACE_CHAT_ROUTE_PATTERN =
  /^\/workspace\/([^/]+)(?:\/t\/[^/]+)?\/?$/;
export const WORKSPACE_CHAT_SURFACE_KEY = "/workspace-chat-surface";

const HEAVY_FULLSCREEN_ROUTE_PATTERNS = [
  /^\/settings\/crypto-center\/?$/,
  /^\/settings\/agents\/builder(?:\/|$)/,
];

export function rawRouteKey(location = {}) {
  return `${location.pathname || "/"}${location.search || ""}`;
}

export function motionRouteKey(location = {}) {
  const pathname = location.pathname || "/";
  if (WORKSPACE_CHAT_ROUTE_PATTERN.test(pathname))
    return WORKSPACE_CHAT_SURFACE_KEY;
  if (isPersistentSettingsRoute(pathname)) return SETTINGS_SOFT_SURFACE_KEY;
  return rawRouteKey(location);
}

export function isHeavyFullscreenRoute(pathname = "") {
  const normalized = normalizePathname(pathname);
  return HEAVY_FULLSCREEN_ROUTE_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  );
}

export function routeCategoryForMotionKey(motionKey = "") {
  if (motionKey === WORKSPACE_CHAT_SURFACE_KEY) return "workspace-chat";
  if (motionKey === SETTINGS_SOFT_SURFACE_KEY) return "settings";
  return "default";
}

export function routeTransitionPolicy({
  navigationType = "PUSH",
  previous,
  next,
} = {}) {
  const previousRawKey = previous?.rawKey || "";
  const nextRawKey = next?.rawKey || "";
  const previousMotionKey = previous?.motionKey || "";
  const nextMotionKey = next?.motionKey || "";
  const previousPathname = previous?.pathname || "";
  const nextPathname = next?.pathname || "";

  if (previousRawKey === nextRawKey) {
    return {
      skipTransition: true,
      skipExitLayer: true,
      phase: "same-route-skip",
      reason: "same-route",
    };
  }

  if (previousMotionKey === nextMotionKey) {
    return {
      skipTransition: true,
      skipExitLayer: true,
      phase: "same-surface-skip",
      reason:
        nextMotionKey === WORKSPACE_CHAT_SURFACE_KEY
          ? "workspace-chat-surface"
          : "same-motion-surface",
    };
  }

  const touchesHeavyFullscreen =
    isHeavyFullscreenRoute(previousPathname) ||
    isHeavyFullscreenRoute(nextPathname);

  if (navigationType === "POP") {
    return {
      skipTransition: true,
      skipExitLayer: true,
      phase: "pop-skip",
      reason: touchesHeavyFullscreen ? "heavy-fullscreen-pop" : "history-pop",
    };
  }

  return {
    skipTransition: false,
    skipExitLayer: isHeavyFullscreenRoute(previousPathname),
    phase: "transitioning",
    reason: touchesHeavyFullscreen ? "heavy-fullscreen-route" : "route-change",
  };
}

function normalizePathname(pathname = "") {
  const pathOnly =
    String(pathname || "")
      .split("?")[0]
      .split("#")[0] || "/";
  if (pathOnly.length > 1 && pathOnly.endsWith("/")) {
    return pathOnly.slice(0, -1);
  }
  return pathOnly;
}
