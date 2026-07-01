import assert from "node:assert/strict";
import test from "node:test";

import {
  clearRouteAuthCache,
  readRouteAuthCache,
  resolveRouteAuthCache,
  routeAuthCacheKey,
  routeAuthCacheStats,
} from "./routeAuthCache.js";

test("route auth cache dedupes concurrent validation", async () => {
  clearRouteAuthCache();
  let calls = 0;
  let now = 1_000;
  const loader = async () => {
    calls += 1;
    return { isAuthd: true, mode: "multi" };
  };

  const [first, second] = await Promise.all([
    resolveRouteAuthCache("auth:token:stored-user", loader, {
      now: () => now,
    }),
    resolveRouteAuthCache("auth:token:stored-user", loader, {
      now: () => now,
    }),
  ]);

  assert.equal(calls, 1);
  assert.equal(first.isAuthd, true);
  assert.equal(second.isAuthd, true);
  assert.equal(routeAuthCacheStats(now).cached, true);
});

test("route auth cache serves fresh TTL hits without reloading", async () => {
  clearRouteAuthCache();
  let calls = 0;
  let now = 2_000;
  const key = "auth:fresh-token:stored-user";

  await resolveRouteAuthCache(
    key,
    async () => {
      calls += 1;
      return { isAuthd: true, mode: "single-password" };
    },
    { now: () => now }
  );

  now += 10_000;
  const cached = await resolveRouteAuthCache(
    key,
    async () => {
      calls += 1;
      return { isAuthd: false, mode: "should-not-run" };
    },
    { now: () => now }
  );

  assert.equal(calls, 1);
  assert.equal(cached.cached, true);
  assert.equal(cached.isAuthd, true);
});

test("route auth cache expires by TTL and respects token key changes", async () => {
  clearRouteAuthCache();
  let now = 3_000;
  let calls = 0;
  const key = "auth:old-token:stored-user";

  await resolveRouteAuthCache(
    key,
    async () => {
      calls += 1;
      return { isAuthd: true, mode: "multi" };
    },
    { now: () => now, ttlMs: 100 }
  );

  now += 200;
  const expired = readRouteAuthCache(key, { now, ttlMs: 100 });
  assert.equal(expired, null);

  await resolveRouteAuthCache(
    "auth:new-token:stored-user",
    async () => {
      calls += 1;
      return { isAuthd: true, mode: "multi" };
    },
    { now: () => now, ttlMs: 100 }
  );

  assert.equal(calls, 2);
});

test("route auth cache skips non-cacheable results and can be cleared", async () => {
  clearRouteAuthCache();
  let now = 4_000;
  const key = "auth:token:stored-user";

  await resolveRouteAuthCache(
    key,
    async () => ({
      isAuthd: false,
      mode: "settings-unavailable",
      cacheable: false,
    }),
    { now: () => now }
  );

  assert.equal(readRouteAuthCache(key, { now }), null);

  await resolveRouteAuthCache(
    key,
    async () => ({ isAuthd: true, mode: "multi" }),
    { now: () => now }
  );
  assert.equal(Boolean(readRouteAuthCache(key, { now })), true);

  clearRouteAuthCache();
  assert.equal(readRouteAuthCache(key, { now }), null);
});

test("route auth cache key follows token, user, and dev bypass inputs", () => {
  assert.equal(
    routeAuthCacheKey({ authToken: "abc", hasUser: true }),
    "auth:abc:stored-user"
  );
  assert.equal(
    routeAuthCacheKey({ authToken: "", hasUser: false }),
    "auth:no-token:no-user"
  );
  assert.equal(routeAuthCacheKey({ codexDevAuthBypass: true }), "codex-dev");
});
