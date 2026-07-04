import { useEffect, useMemo } from "react";
import { navigationLifecycle } from "./navigationLifecycleCenter.js";

export function useNavigationLifecycle(scope = {}, options = {}) {
  const scopeKey = JSON.stringify(scope || {});
  const stableScope = useMemo(() => {
    try {
      return JSON.parse(scopeKey);
    } catch {
      return {};
    }
  }, [scopeKey]);

  useEffect(() => {
    if (options.enabled === false) return;
    navigationLifecycle.enter(stableScope, {
      reason: options.enterReason || "component-enter",
    });
    return () => {
      navigationLifecycle.leave(stableScope, {
        reason: options.leaveReason || "component-leave",
        deferredCleanup: options.deferredCleanup,
        saveSnapshot: options.saveSnapshot,
        extraScopes: options.extraScopes,
      });
    };
  }, [
    stableScope,
    options.enabled,
    options.enterReason,
    options.leaveReason,
    options.deferredCleanup,
    options.saveSnapshot,
    options.extraScopes,
  ]);

  return navigationLifecycle;
}
