import { taskScheduler, scopeMatches } from "./taskScheduler.js";
let activeScope = null;

export function routeScopeFromPathname(pathname = "") {
  const path = String(pathname || "/");
  const workspaceSettings = path.match(/^\/workspace\/([^/]+)\/settings/i);
  if (workspaceSettings?.[1]) {
    return {
      route: "workspace-settings",
      surface: "workspace-settings",
      workspaceSlug: workspaceSettings[1],
    };
  }

  const workspaceThread = path.match(/^\/workspace\/([^/]+)(?:\/t\/([^/]+))?/i);
  if (workspaceThread?.[1]) {
    return {
      route: "workspace-chat",
      surface: "workspace-chat",
      workspaceSlug: workspaceThread[1],
      ...(workspaceThread[2] ? { threadSlug: workspaceThread[2] } : {}),
    };
  }

  if (path.startsWith("/settings/crypto-center")) {
    return { route: "crypto-center", surface: "crypto-center" };
  }
  if (path.startsWith("/settings")) {
    return { route: "settings", surface: "settings" };
  }
  if (path.startsWith("/login") || path.startsWith("/auth")) {
    return { route: "auth", surface: "auth" };
  }
  return { route: path || "global", surface: "route" };
}

export function activateRouteScope(nextScope, reason = "route-change") {
  const previous = activeScope;
  activeScope = { ...(nextScope || {}) };
  if (!previous) return;
  if (sameScope(previous, activeScope)) return;

  const previousRoute = previous.route;
  if (previousRoute && previousRoute !== activeScope.route) {
    taskScheduler.cancelWhere(
      (task) => task.scope?.route === previousRoute && !task.protected,
      { reason, includeRunning: true }
    );
  }

  if (
    previous.workspaceSlug &&
    previous.workspaceSlug !== activeScope.workspaceSlug
  ) {
    preemptLowPriority(
      { workspaceSlug: previous.workspaceSlug },
      "workspace-switch"
    );
  }

  if (previous.threadSlug && previous.threadSlug !== activeScope.threadSlug) {
    preemptLowPriority({ threadSlug: previous.threadSlug }, "thread-switch");
  }
}

export function currentRouteScope() {
  return activeScope ? { ...activeScope } : null;
}

function sameScope(left = {}, right = {}) {
  return (
    left.route === right.route &&
    left.workspaceSlug === right.workspaceSlug &&
    left.threadSlug === right.threadSlug
  );
}

function preemptLowPriority(scope, reason) {
  taskScheduler.cancelWhere(
    (task) => scopeMatches(task.scope, scope) && !task.protected,
    { reason, includeRunning: true }
  );
}
