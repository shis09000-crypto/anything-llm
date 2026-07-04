import { navigationLifecycle } from "../navigationLifecycle/navigationLifecycleCenter.js";
import {
  navigationReasonForScopes,
  routeScopeFromPathname,
  sameRouteScope,
} from "../navigationLifecycle/routeScope.js";

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
    return;
  }
  if (sameRouteScope(previous, activeScope)) return;

  navigationLifecycle.transition({
    fromScope: previous,
    toScope: activeScope,
    reason: navigationReasonForScopes(previous, activeScope, {
      navigationType: options.navigationType,
      explicitReason: reason === "route-change" ? null : reason,
    }),
    navigationType: options.navigationType || "PUSH",
    preferCache: true,
    immediateUi: true,
  });
}

export function currentRouteScope() {
  return (
    navigationLifecycle.currentScope() ||
    (activeScope ? { ...activeScope } : null)
  );
}
