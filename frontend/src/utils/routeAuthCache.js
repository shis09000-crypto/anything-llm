export const ROUTE_AUTH_CACHE_TTL_MS = 5 * 60 * 1000;

let routeAuthCache = null;
let routeAuthInflight = null;

export function routeAuthCacheKey({
  authToken = "",
  hasUser = false,
  codexDevAuthBypass = false,
} = {}) {
  if (codexDevAuthBypass) return "codex-dev";
  return [
    "auth",
    authToken ? String(authToken) : "no-token",
    hasUser ? "stored-user" : "no-user",
  ].join(":");
}

export function readRouteAuthCache(
  key,
  { now = Date.now(), ttlMs = ROUTE_AUTH_CACHE_TTL_MS, allowStale = false } = {}
) {
  if (!key || routeAuthCache?.key !== key) return null;
  if (!allowStale && now - routeAuthCache.storedAt > ttlMs) return null;
  return routeAuthCache.value;
}

export function preserveRouteAuthOnTransient(key, result) {
  if (!result?.authUnavailable) return result;
  const stale = readRouteAuthCache(key, { allowStale: true });
  if (!stale?.isAuthd) return result;
  return {
    ...stale,
    authUnavailable: false,
    reconnecting: true,
    mode: `${stale.mode || "authenticated"}-reconnecting`,
    cacheable: false,
  };
}

export function clearRouteAuthCache() {
  routeAuthCache = null;
  routeAuthInflight = null;
}

export function resolveRouteAuthCache(
  key,
  loader,
  { now = Date.now, ttlMs = ROUTE_AUTH_CACHE_TTL_MS } = {}
) {
  const startedAt = now();
  const cached = readRouteAuthCache(key, { now: startedAt, ttlMs });
  if (cached) return Promise.resolve({ ...cached, cached: true });

  if (routeAuthInflight?.key === key) return routeAuthInflight.promise;

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      const normalized = value || {
        isAuthd: false,
        shouldRedirectToOnboarding: false,
        multiUserMode: false,
        authUnavailable: false,
      };

      if (normalized.cacheable !== false) {
        routeAuthCache = {
          key,
          storedAt: now(),
          value: normalized,
        };
      }

      return normalized;
    })
    .finally(() => {
      if (routeAuthInflight?.key === key) routeAuthInflight = null;
    });

  routeAuthInflight = { key, promise, startedAt };
  return promise;
}

export function routeAuthCacheStats(now = Date.now()) {
  return {
    cached: Boolean(routeAuthCache),
    cacheKey: routeAuthCache?.key || null,
    cacheAgeMs: routeAuthCache ? now - routeAuthCache.storedAt : null,
    inflightKey: routeAuthInflight?.key || null,
  };
}
