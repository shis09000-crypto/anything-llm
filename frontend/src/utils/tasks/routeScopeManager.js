import { navigationLifecycle } from "../navigationLifecycle/navigationLifecycleCenter.js";
import {
  extraExitScopesForRoute,
  restoreTargetForScope,
} from "../navigationLifecycle/navigationRestoreRegistry.js";
import {
  isHistoryBoundaryScope,
  navigationReasonForScopes,
  routeScopeFromPathname,
  sameRouteScope,
} from "../navigationLifecycle/routeScope.js";
import { markTaskPerformance } from "./taskScheduler.js";

let activeScope = null;

export { routeScopeFromPathname };

export function activateRouteScope(
  nextScope,
  reason = "route-change",
  options = {}
) {
  const previous = activeScope;
  activeScope = { ...(nextScope || {}) };
  if (!previous) {
    navigationLifecycle.enter(activeScope, { reason: "initial-route" });
    navigationLifecycle.restore(activeScope, {
      reason: "initial-route",
      preferCache: true,
      restoreTarget: restoreTargetForScope(activeScope),
    });
    return;
  }
  if (sameRouteScope(previous, activeScope)) {
    if (options.navigationType === "POP") {
      markTaskPerformance("navigation_same_scope_pop", {
        scope: activeScope,
        pathname: options.pathname,
      });
    }
    return;
  }

  const transitionReason = navigationReasonForScopes(previous, activeScope, {
    navigationType: options.navigationType,
    explicitReason: reason === "route-change" ? null : reason,
  });
  if (options.navigationType === "POP" && isHistoryBoundaryScope(activeScope)) {
    markTaskPerformance("navigation_history_boundary", {
      fromScope: previous,
      toScope: activeScope,
      pathname: options.pathname,
      reason: transitionReason,
    });
  }
  navigationLifecycle.transition({
    fromScope: previous,
    toScope: activeScope,
    reason: transitionReason,
    navigationType: options.navigationType || "PUSH",
    preferCache: true,
    immediateUi: true,
    restoreTarget: restoreTargetForScope(activeScope),
    extraExitScopes: extraExitScopesForRoute(previous),
  });
}

export function currentRouteScope() {
  return (
    navigationLifecycle.currentScope() ||
    (activeScope ? { ...activeScope } : null)
  );
}
