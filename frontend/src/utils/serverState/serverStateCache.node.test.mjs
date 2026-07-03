import test from "node:test";
import assert from "node:assert/strict";
import { ServerStateCache } from "./serverStateCache.js";
import { TaskScheduler } from "../tasks/taskScheduler.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function cacheWithClock(nowRef) {
  return new ServerStateCache({
    scheduler: new TaskScheduler({ maxConcurrent: 1 }),
    now: () => nowRef.value,
  });
}

test("server state cache serves fresh hits and blocks expired strict reads", () => {
  const now = { value: 1_000 };
  const cache = cacheWithClock(now);

  cache.set("workspace.list", [{ slug: "alpha" }], {
    ttlMs: 100,
    ownerScope: "user:a",
  });

  assert.deepEqual(cache.get("workspace.list", { ownerScope: "user:a" }), [
    { slug: "alpha" },
  ]);
  now.value += 150;
  assert.deepEqual(cache.get("workspace.list", { ownerScope: "user:a" }), [
    { slug: "alpha" },
  ]);
  assert.equal(
    cache.get("workspace.list", {
      allowStale: false,
      ownerScope: "user:a",
    }),
    null
  );
});

test("server state cache isolates entries by owner scope", () => {
  const now = { value: 2_000 };
  const cache = cacheWithClock(now);

  cache.set("workspace.detail:one", { slug: "one" }, { ownerScope: "user:a" });
  cache.set("workspace.detail:global", { slug: "global" });

  assert.deepEqual(
    cache.get("workspace.detail:one", { ownerScope: "user:a" }),
    { slug: "one" }
  );
  assert.equal(
    cache.get("workspace.detail:one", { ownerScope: "user:b" }),
    null
  );
  assert.equal(
    cache.get("workspace.detail:global", { ownerScope: "user:a" }),
    null
  );
});

test("server state cache dedupes in-flight refreshes", async () => {
  const now = { value: 3_000 };
  const cache = cacheWithClock(now);
  const release = deferred();
  let calls = 0;

  const fetcher = async () => {
    calls += 1;
    await release.promise;
    return { slug: "deduped" };
  };

  const first = cache.refresh("workspace.detail:dedupe", fetcher, {
    dedupeKey: "workspace.detail:dedupe",
    priority: "P0",
  });
  const second = cache.refresh("workspace.detail:dedupe", fetcher, {
    dedupeKey: "workspace.detail:dedupe",
    priority: "P0",
  });

  await wait();
  release.resolve();

  assert.deepEqual(await first, { slug: "deduped" });
  assert.deepEqual(await second, { slug: "deduped" });
  assert.equal(calls, 1);
});

test("server state cache invalidates exact keys, prefixes, and scopes", () => {
  const now = { value: 4_000 };
  const cache = cacheWithClock(now);

  cache.set("workspace.list", [{ slug: "a" }], {
    scope: { domain: "workspace-navigation" },
  });
  cache.set(
    "workspace.detail:a",
    { slug: "a" },
    {
      scope: { domain: "workspace-navigation", workspaceSlug: "a" },
    }
  );
  cache.set("reader.document:1", { id: 1 }, { scope: { domain: "reader" } });

  cache.invalidate("workspace.list");
  assert.equal(cache.get("workspace.list"), null);
  assert.deepEqual(cache.get("workspace.detail:a"), { slug: "a" });

  cache.invalidatePrefix("workspace.detail:");
  assert.equal(cache.get("workspace.detail:a"), null);

  cache.invalidateScope({ domain: "reader" });
  assert.equal(cache.get("reader.document:1"), null);
});

test("server state cache reports actual owner-scoped invalidation count", () => {
  const now = { value: 4_250 };
  const cache = cacheWithClock(now);

  cache.set("workspace.detail:a", { slug: "a" }, { ownerScope: "user:a" });
  cache.set("workspace.detail:b", { slug: "b" }, { ownerScope: "user:b" });

  assert.equal(
    cache.invalidatePrefix("workspace.detail:", { ownerScope: "user:a" }),
    1
  );
  assert.equal(cache.get("workspace.detail:a"), null);
  assert.deepEqual(cache.get("workspace.detail:b"), { slug: "b" });
});

test("server state cache snapshots expose metadata for managed pruning", () => {
  const now = { value: 4_500 };
  const cache = cacheWithClock(now);

  cache.set(
    "thread.history:workspace-a:thread-a:latest",
    { history: [{ chatId: 1 }] },
    {
      ownerScope: "user:a",
      scope: {
        domain: "thread-history",
        workspaceSlug: "workspace-a",
        threadSlug: "thread-a",
      },
      meta: { size: 128 },
    }
  );

  const entry = cache
    .snapshot()
    .entries.find((item) => item.key.startsWith("thread.history:"));

  assert.equal(entry.ownerScope, "user:a");
  assert.equal(entry.scope.domain, "thread-history");
  assert.equal(entry.meta.size, 128);
});

test("server state cache does not let stale refresh overwrite newer values", async () => {
  const now = { value: 5_000 };
  const cache = cacheWithClock(now);
  const release = deferred();
  let commits = 0;

  const refresh = cache.refresh(
    "workspace.detail:race",
    async () => {
      await release.promise;
      return { slug: "race", title: "old" };
    },
    {
      priority: "P0",
      onCommit: () => {
        commits += 1;
      },
    }
  );

  await wait();
  cache.set("workspace.detail:race", { slug: "race", title: "new" });
  release.resolve();

  assert.deepEqual(await refresh, { slug: "race", title: "old" });
  assert.deepEqual(cache.get("workspace.detail:race"), {
    slug: "race",
    title: "new",
  });
  assert.equal(commits, 0);
});

test("server state cache calls onCommit only after a committed refresh", async () => {
  const now = { value: 5_500 };
  const cache = cacheWithClock(now);
  let commits = 0;
  let committedValue = null;

  const value = await cache.refresh(
    "workspace.detail:commit",
    async () => ({ slug: "commit", title: "fresh" }),
    {
      priority: "P0",
      onCommit: (payload) => {
        commits += 1;
        committedValue = payload;
      },
    }
  );

  assert.deepEqual(value, { slug: "commit", title: "fresh" });
  assert.equal(commits, 1);
  assert.deepEqual(committedValue, { slug: "commit", title: "fresh" });
  assert.deepEqual(cache.get("workspace.detail:commit"), {
    slug: "commit",
    title: "fresh",
  });
});

test("server state cache ensure returns fresh cache without scheduling fetcher", async () => {
  const now = { value: 6_000 };
  const cache = cacheWithClock(now);
  let calls = 0;

  cache.set("workspace.list", [{ slug: "cached" }], {
    ttlMs: 500,
    ownerScope: "user:a",
  });

  const value = await cache.ensure(
    "workspace.list",
    async () => {
      calls += 1;
      return [{ slug: "network" }];
    },
    {
      ttlMs: 500,
      ownerScope: "user:a",
      priority: "P0",
    }
  );

  assert.deepEqual(value, [{ slug: "cached" }]);
  assert.equal(calls, 0);
  assert.equal(cache.snapshot().counters.fastPathHits, 1);
});

test("server state cache ensure returns stale value and refreshes in background", async () => {
  const now = { value: 7_000 };
  const cache = cacheWithClock(now);
  const release = deferred();
  let calls = 0;

  cache.set("workspace.threads:alpha", [{ slug: "old" }], {
    ttlMs: 100,
    ownerScope: "user:a",
  });
  now.value += 250;

  const value = await cache.ensure(
    "workspace.threads:alpha",
    async () => {
      calls += 1;
      await release.promise;
      return [{ slug: "fresh" }];
    },
    {
      ttlMs: 100,
      ownerScope: "user:a",
      priority: "P0",
      staleWhileRevalidate: true,
    }
  );

  assert.deepEqual(value, [{ slug: "old" }]);
  await wait();
  assert.equal(calls, 1);
  release.resolve();
  await wait();
  assert.deepEqual(
    cache.get("workspace.threads:alpha", {
      allowStale: false,
      ttlMs: 100,
      ownerScope: "user:a",
    }),
    [{ slug: "fresh" }]
  );
});

test("server state cache ensure dedupes cache misses by server-state key", async () => {
  const now = { value: 8_000 };
  const cache = cacheWithClock(now);
  const release = deferred();
  let calls = 0;

  const fetcher = async () => {
    calls += 1;
    await release.promise;
    return { slug: "deduped" };
  };

  const first = cache.ensure("workspace.detail:dedupe", fetcher, {
    priority: "P0",
  });
  const second = cache.ensure("workspace.detail:dedupe", fetcher, {
    priority: "P0",
  });

  await wait();
  release.resolve();

  assert.deepEqual(await first, { slug: "deduped" });
  assert.deepEqual(await second, { slug: "deduped" });
  assert.equal(calls, 1);
  assert.equal(cache.snapshot().counters.refreshes, 1);
});

test("server state cache snapshot exposes cache-linked inflight details", async () => {
  const now = { value: 9_000 };
  const cache = cacheWithClock(now);
  const release = deferred();

  const pending = cache.ensure(
    "reader.documents:workspace:alpha",
    async () => {
      await release.promise;
      return [];
    },
    {
      priority: "P1",
      scope: { domain: "reader-server-state", workspaceSlug: "alpha" },
    }
  );

  await wait();
  const snapshot = cache.snapshot();
  assert.equal(snapshot.inflight.length, 1);
  assert.equal(
    snapshot.inflightDetails[0].key,
    "reader.documents:workspace:alpha"
  );
  assert.equal(snapshot.inflightDetails[0].priority, "P1");
  release.resolve();
  await pending;
});
