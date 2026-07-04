import test from "node:test";
import assert from "node:assert/strict";
import { TaskScheduler } from "../tasks/taskScheduler.js";
import { DeferredCleanupQueue } from "./deferredCleanupQueue.js";
import { NavigationSnapshotStore } from "./navigationSnapshot.js";
import { NavigationLifecycleCenter } from "./navigationLifecycleCenter.js";
import { routeScopeFromPathname } from "./routeScope.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function createCenter({
  scheduler = new TaskScheduler({ maxConcurrent: 1 }),
} = {}) {
  const sensitiveCalls = [];
  const recoveryCalls = [];
  return {
    scheduler,
    sensitiveCalls,
    recoveryCalls,
    center: new NavigationLifecycleCenter({
      scheduler,
      cleanupQueue: new DeferredCleanupQueue(),
      snapshots: new NavigationSnapshotStore(),
      sensitive: {
        revokeScope: (...args) => {
          sensitiveCalls.push(args);
          return Promise.resolve({ success: true });
        },
      },
      recovery: {
        handle: (...args) => {
          recoveryCalls.push(args);
          return { classification: "silent" };
        },
      },
    }),
  };
}

test("transition marks UI swapped before deferred cleanup runs", async () => {
  const { center } = createCenter();
  const order = [];

  const { transition } = center.transition({
    fromScope: { route: "reader", surface: "reader" },
    toScope: { route: "workspace-chat", workspaceSlug: "alpha" },
    reason: "close-reader",
    immediateUi: true,
    deferredCleanup: () => order.push("cleanup"),
  });

  order.push("after-transition");
  assert.equal(typeof transition.uiSwappedAt, "number");
  assert.deepEqual(order, ["after-transition"]);

  await wait(10);
  assert.deepEqual(order, ["after-transition", "cleanup"]);
});

test("leave aborts old non-protected tasks and keeps protected work", async () => {
  const scheduler = new TaskScheduler({ maxConcurrent: 2 });
  const { center } = createCenter({ scheduler });
  let aborted = false;

  const oldTask = scheduler.schedule(
    async ({ signal }) => {
      await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true }
        );
      });
    },
    {
      kind: "reader",
      priority: "P3",
      scope: { route: "reader", surface: "reader-preload" },
      label: "reader-preload",
    }
  );
  const protectedTask = scheduler.schedule(async () => "kept", {
    kind: "chat",
    priority: "P0",
    protected: true,
    scope: { route: "reader" },
    label: "protected-stream",
  });

  await wait();
  const result = center.leave({ route: "reader" }, { reason: "close-reader" });
  await oldTask.promise;

  assert.equal(aborted, true);
  assert.equal(result.cancelled >= 1, true);
  assert.equal(await protectedTask.promise, "kept");
});

test("sensitive scope leave revokes through sensitive session center", () => {
  const { center, sensitiveCalls } = createCenter();
  center.leave(
    {
      kind: "sensitive",
      route: "vault",
      resourceType: "vault-secret",
      resourceId: "secret-1",
      ownerScope: "user-a",
    },
    { reason: "close-sensitive-viewer" }
  );

  assert.equal(sensitiveCalls.length, 1);
  assert.deepEqual(sensitiveCalls[0][0], {
    resourceType: "vault-secret",
    resourceId: "secret-1",
    ownerScope: "user-a",
  });
});

test("page hidden aborts low-priority work and pauses prefetch lanes", async () => {
  const scheduler = new TaskScheduler({ maxConcurrent: 3 });
  const { center } = createCenter({ scheduler });
  let lowPriorityAborted = false;

  const lowPriorityTask = scheduler.schedule(
    async ({ signal }) => {
      await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            lowPriorityAborted = true;
            resolve();
          },
          { once: true }
        );
      });
    },
    {
      kind: "prefetch",
      priority: "P3",
      scope: { route: "crypto-center" },
      label: "crypto-prefetch",
    }
  );
  const protectedTask = scheduler.schedule(async () => "kept", {
    kind: "chat",
    priority: "P0",
    protected: true,
    scope: { route: "workspace-chat" },
    label: "protected-chat-stream",
  });

  await wait();
  const result = center.pageEvent("hidden", { reason: "visibility-hidden" });
  await lowPriorityTask.promise;

  assert.equal(lowPriorityAborted, true);
  assert.equal(result.cancelled >= 1, true);
  assert.equal(await protectedTask.promise, "kept");
  assert.equal(center.snapshot().pageState.visible, false);
  assert.deepEqual(scheduler.stats().pausedPriorities.sort(), ["P3", "P4"]);
});

test("pagehide revokes active sensitive scope and pageshow resumes paused work", async () => {
  const scheduler = new TaskScheduler({ maxConcurrent: 2 });
  const { center, sensitiveCalls } = createCenter({ scheduler });
  center.enter({
    kind: "sensitive",
    route: "vault",
    resourceType: "vault-secret",
    resourceId: "secret-2",
    ownerScope: "user-a",
  });

  const backgroundTask = scheduler.schedule(
    async ({ signal }) => {
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
    },
    {
      kind: "background",
      priority: "P2",
      scope: { route: "settings" },
      label: "settings-background",
    }
  );

  await wait();
  const pagehideResult = center.pageEvent("pagehide", { reason: "pagehide" });
  await backgroundTask.promise;

  assert.equal(pagehideResult.cancelled >= 1, true);
  assert.equal(sensitiveCalls.length, 1);
  assert.deepEqual(sensitiveCalls[0][0], {
    resourceType: "vault-secret",
    resourceId: "secret-2",
    ownerScope: "user-a",
  });
  assert.deepEqual(scheduler.stats().pausedPriorities.sort(), [
    "P2",
    "P3",
    "P4",
  ]);

  center.pageEvent("pageshow", { reason: "pageshow-bfcache" });
  assert.deepEqual(scheduler.stats().pausedPriorities, []);
  assert.equal(center.snapshot().pageState.visible, true);
});

test("route scope parser classifies first batch lifecycle routes", () => {
  assert.deepEqual(routeScopeFromPathname("/settings/crypto-center"), {
    kind: "route",
    route: "crypto-center",
    surface: "crypto-center",
  });
  assert.deepEqual(routeScopeFromPathname("/workspace/ws-a/t/thread-b"), {
    kind: "route",
    route: "workspace-chat",
    surface: "workspace-chat",
    workspaceSlug: "ws-a",
    threadSlug: "thread-b",
  });
  assert.deepEqual(routeScopeFromPathname("/workspace/ws-a/settings"), {
    kind: "route",
    route: "workspace-settings",
    surface: "workspace-settings",
    workspaceSlug: "ws-a",
  });
});
