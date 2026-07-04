export function routeScopeFromPathname(pathname = "") {
  const path = normalizePathname(pathname);
  const workspaceSettings = path.match(/^\/workspace\/([^/]+)\/settings/i);
  if (workspaceSettings?.[1]) {
    return {
      kind: "route",
      route: "workspace-settings",
      surface: "workspace-settings",
      workspaceSlug: workspaceSettings[1],
    };
  }

  const workspaceThread = path.match(/^\/workspace\/([^/]+)(?:\/t\/([^/]+))?/i);
  if (workspaceThread?.[1]) {
    return {
      kind: "route",
      route: "workspace-chat",
      surface: "workspace-chat",
      workspaceSlug: workspaceThread[1],
      ...(workspaceThread[2] ? { threadSlug: workspaceThread[2] } : {}),
    };
  }

  if (path.startsWith("/settings/crypto-center")) {
    return {
      kind: "route",
      route: "crypto-center",
      surface: "crypto-center",
    };
  }
  if (path.startsWith("/settings")) {
    return { kind: "route", route: "settings", surface: "settings" };
  }
  if (path.startsWith("/login") || path.startsWith("/auth")) {
    return { kind: "route", route: "auth", surface: "auth" };
  }
  return { kind: "route", route: path || "global", surface: "route" };
}

export function sameRouteScope(left = {}, right = {}) {
  return (
    left?.route === right?.route &&
    left?.workspaceSlug === right?.workspaceSlug &&
    left?.threadSlug === right?.threadSlug
  );
}

export function routeScopeKey(scope = {}) {
  if (!scope || typeof scope !== "object") return "global";
  return [
    scope.kind ? `kind:${scope.kind}` : null,
    scope.route ? `route:${scope.route}` : null,
    scope.surface ? `surface:${scope.surface}` : null,
    scope.workspaceSlug ? `workspace:${scope.workspaceSlug}` : null,
    scope.threadSlug ? `thread:${scope.threadSlug}` : null,
    scope.readerDocumentId ? `reader:${scope.readerDocumentId}` : null,
  ]
    .filter(Boolean)
    .join("|");
}

export function navigationReasonForScopes(
  fromScope = null,
  toScope = null,
  { navigationType = "PUSH", explicitReason = null } = {}
) {
  if (explicitReason) return explicitReason;
  if (navigationType === "POP") return "back";
  if (!fromScope?.route && toScope?.route) return "enter";
  if (
    fromScope?.route === "crypto-center" &&
    toScope?.route !== "crypto-center"
  )
    return "close-crypto";
  if (
    fromScope?.route !== "crypto-center" &&
    toScope?.route === "crypto-center"
  )
    return "open-crypto";
  if (
    fromScope?.route?.includes("settings") &&
    toScope?.route === "workspace-chat"
  )
    return "close-settings";
  if (
    fromScope?.route !== toScope?.route &&
    toScope?.route?.includes("settings")
  )
    return "open-settings";
  if (
    fromScope?.workspaceSlug &&
    toScope?.workspaceSlug &&
    fromScope.workspaceSlug !== toScope.workspaceSlug
  ) {
    return "workspace-switch";
  }
  if (
    fromScope?.threadSlug &&
    toScope?.threadSlug &&
    fromScope.threadSlug !== toScope.threadSlug
  ) {
    return "thread-switch";
  }
  if (fromScope?.route !== toScope?.route) return "route-change";
  return "restore";
}

export function normalizePathname(pathname = "") {
  const pathOnly =
    String(pathname || "")
      .split("?")[0]
      .split("#")[0] || "/";
  if (pathOnly.length > 1 && pathOnly.endsWith("/")) {
    return pathOnly.slice(0, -1);
  }
  return pathOnly;
}
