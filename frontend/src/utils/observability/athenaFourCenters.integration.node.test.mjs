import test from "node:test";
import assert from "node:assert/strict";
import { optimisticActionCenter } from "../optimistic/optimisticActionCenter.js";
import { recoveryCenter } from "../recovery/recoveryCenter.js";
import { serverStateCache } from "../serverState/serverStateCache.js";
import { TaskScheduler, taskScheduler } from "../tasks/taskScheduler.js";

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

function uniqueKey(prefix) {
  return `${prefix}:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2)}`;
}

test.beforeEach(() => {
  serverStateCache.clear();
  recoveryCenter.resetForTests();
});

test("four centers: optimistic reader delete blocks refresh, then recovery rolls back and exposes retry", async () => {
  const key = uniqueKey("reader.library.integration");
  const releaseServerCall = deferred();
  const initialLibrary = {
    books: [
      { id: "book-a", title: "Alpha" },
      { id: "book-b", title: "Beta" },
    ],
  };
  serverStateCache.set(key, initialLibrary, {
    scope: { domain: "reader", surface: "bookshelf" },
  });

  const action = optimisticActionCenter.run({
    type: "reader.delete",
    scope: { surface: "reader-bookshelf", readerDocumentId: "book-a" },
    targetKeys: [key],
    tombstone: true,
    retryable: true,
    optimisticPatch: {
      "*": (current) => ({
        ...current,
        books: current.books.filter((book) => book.id !== "book-a"),
      }),
    },
    serverCall: async () => {
      await releaseServerCall.promise;
      throw new Error("Failed to fetch");
    },
  });

  assert.deepEqual(
    serverStateCache.get(key).books.map((book) => book.id),
    ["book-b"]
  );

  await serverStateCache.refresh(key, async () => initialLibrary, {
    priority: "P2",
    scope: { domain: "reader", surface: "bookshelf" },
  });

  assert.deepEqual(
    serverStateCache.get(key).books.map((book) => book.id),
    ["book-b"]
  );
  assert.equal(serverStateCache.meta(key).meta.optimisticStatus, "pending");

  releaseServerCall.resolve();
  const outcome = await action.promise;

  assert.equal(outcome.ok, false);
  assert.equal(outcome.rolledBack, true);
  assert.equal(outcome.recovery.classification, "rollback");
  assert.equal(outcome.recovery.shouldRetry, true);
  assert.equal(outcome.recovery.recoveryAction, "retry");
  assert.deepEqual(serverStateCache.get(key), initialLibrary);

  const cacheSnapshot = serverStateCache.snapshot();
  const optimisticSnapshot = optimisticActionCenter.snapshot();
  const recoverySnapshot = recoveryCenter.snapshot();

  assert.ok(cacheSnapshot.counters.droppedStaleWrites >= 1);
  assert.equal(optimisticSnapshot.recent.at(-1).status, "rolled-back");
  assert.equal(recoverySnapshot.byClassification.rollback, 1);
});

test("four centers: cache fast path serves visible workspace state without scheduling network", async () => {
  const key = uniqueKey("workspace.list.integration");
  let fetches = 0;
  serverStateCache.set(key, [{ slug: "cached-workspace" }], {
    ttlMs: 5_000,
    scope: { domain: "workspace-navigation" },
    ownerScope: "integration-user",
  });
  const beforeScheduled = taskScheduler.snapshot().counters.scheduled;
  const start = Date.now();

  const value = await serverStateCache.ensure(
    key,
    async () => {
      fetches += 1;
      return [{ slug: "network-workspace" }];
    },
    {
      ttlMs: 5_000,
      ownerScope: "integration-user",
      priority: "P0",
      intentRank: 0,
      scope: { domain: "workspace-navigation" },
    }
  );

  assert.deepEqual(value, [{ slug: "cached-workspace" }]);
  assert.equal(fetches, 0);
  assert.ok(Date.now() - start < 50);
  assert.equal(taskScheduler.snapshot().counters.scheduled, beforeScheduled);
  assert.ok(serverStateCache.snapshot().counters.fastPathHits >= 1);
});

test("four centers: rapid user intent preempts background work while protected chat survives", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 1,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
  });
  const events = [];

  const background = scheduler.schedule(
    async ({ signal }) => {
      events.push("background:start");
      await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            events.push("background:abort");
            resolve();
          },
          { once: true }
        );
      });
    },
    {
      kind: "reader-maintenance",
      label: "reader thumbnail patrol",
      priority: "P4",
      resource: "network",
      scope: { route: "reader", readerDocumentId: "old-book" },
    }
  );

  const chat = scheduler.schedule(
    async () => {
      events.push("chat:start");
      await wait(8);
      events.push("chat:done");
      return "chat-ok";
    },
    {
      kind: "chat-stream",
      label: "protected chat stream",
      priority: "P0",
      policy: "realtime",
      resource: "realtime",
      protected: true,
      abortable: false,
      scope: { route: "workspace-chat", threadSlug: "active-thread" },
    }
  );

  await wait();
  const readerOpen = scheduler.scheduleEmergency(
    async () => {
      events.push("reader:target");
      return "reader-visible";
    },
    {
      kind: "reader-open",
      label: "reader target page",
      intentRank: 0,
      scope: { route: "workspace-chat", surface: "reader" },
    }
  );

  assert.equal(await readerOpen.promise, "reader-visible");
  assert.equal(await chat.promise, "chat-ok");
  await background.promise;

  const snapshot = scheduler.snapshot();
  assert.equal(events.includes("reader:target"), true);
  assert.equal(events.includes("chat:done"), true);
  assert.equal(events.includes("background:abort"), true);
  assert.equal(snapshot.exclusiveMode.active, false);
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.pending.length, 0);
  assert.ok(
    snapshot.aborted.some((task) => task.kind === "reader-maintenance")
  );
});

test("four centers: stale optimistic action silently rolls back without user-facing error", async () => {
  const key = uniqueKey("thread.rename.integration");
  const release = deferred();
  serverStateCache.set(key, { title: "old title" });

  const action = optimisticActionCenter.run({
    type: "thread.rename",
    scope: { workspaceSlug: "w1", threadSlug: "t1" },
    targetKeys: [key],
    optimisticPatch: {
      "*": { title: "new title" },
    },
    priority: "P2",
    protected: false,
    abortable: false,
    serverCall: async () => {
      await release.promise;
      return { title: "server title" };
    },
  });

  taskScheduler.markScopeStale(
    { workspaceSlug: "w1", threadSlug: "t1" },
    "integration-thread-switch"
  );
  release.resolve();
  const outcome = await action.promise;

  assert.equal(outcome.stale, true);
  assert.equal(outcome.rolledBack, true);
  assert.equal(outcome.recovery.classification, "silent");
  assert.deepEqual(serverStateCache.get(key), { title: "old title" });
  assert.equal(recoveryCenter.snapshot().byClassification.silent >= 1, true);
  assert.equal(recoveryCenter.snapshot().toastCount, 0);
});
