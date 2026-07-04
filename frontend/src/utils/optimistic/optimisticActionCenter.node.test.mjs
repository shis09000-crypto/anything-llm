import test from "node:test";
import assert from "node:assert/strict";
import { optimisticActionCenter } from "./optimisticActionCenter.js";
import { serverStateCache } from "../serverState/serverStateCache.js";
import { taskScheduler } from "../tasks/taskScheduler.js";

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

test("optimistic action confirms successful scheduled work", async () => {
  const action = optimisticActionCenter.run({
    type: "test.success",
    scope: { surface: "optimistic-test-success" },
    serverCall: async () => ({ saved: true }),
  });

  const outcome = await action.promise;
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, { saved: true });
  assert.equal(
    optimisticActionCenter
      .snapshot()
      .active.some((item) => item.id === action.actionId),
    false
  );
});

test("optimistic action rolls back failed cache mutation", async () => {
  serverStateCache.clear();
  serverStateCache.set("optimistic.item", { title: "old" });

  const action = optimisticActionCenter.run({
    type: "test.rollback",
    scope: { surface: "optimistic-test-rollback" },
    targetKeys: ["optimistic.item"],
    optimisticPatch: {
      "*": { title: "new" },
    },
    serverCall: async () => {
      throw new Error("save failed");
    },
  });

  assert.deepEqual(serverStateCache.get("optimistic.item"), { title: "new" });

  const outcome = await action.promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.rolledBack, true);
  assert.equal(outcome.recovery?.classification, "rollback");
  assert.equal(outcome.recovery?.rollbackExecuted, true);
  assert.deepEqual(serverStateCache.get("optimistic.item"), { title: "old" });
});

test("optimistic action does not confirm when its scheduled task is stale", async () => {
  const started = deferred();
  const release = deferred();
  const action = optimisticActionCenter.run({
    type: "test.stale",
    scope: { surface: "optimistic-test-stale" },
    priority: "P2",
    protected: false,
    abortable: false,
    serverCall: async () => {
      started.resolve();
      await release.promise;
      return { shouldNotConfirm: true };
    },
  });

  await started.promise;
  taskScheduler.markScopeStale(
    { surface: "optimistic-test-stale" },
    "test-stale"
  );

  const outcome = await action.promise;
  release.resolve();
  await wait();

  assert.equal(outcome.ok, false);
  assert.equal(outcome.stale, true);
  assert.equal(
    optimisticActionCenter
      .snapshot()
      .recent.some(
        (item) => item.id === action.actionId && item.status === "stale"
      ),
    true
  );
});

test("optimistic cache mutation is not overwritten by older server-state refresh", async () => {
  serverStateCache.clear();
  serverStateCache.set("optimistic.race", { title: "initial" });
  const releaseRefresh = deferred();

  const refresh = serverStateCache.refresh(
    "optimistic.race",
    async () => {
      await releaseRefresh.promise;
      return { title: "old-refresh" };
    },
    { priority: "P2" }
  );

  await wait();

  const action = optimisticActionCenter.run({
    type: "test.cache-race",
    scope: { surface: "optimistic-test-cache-race" },
    targetKeys: ["optimistic.race"],
    optimisticPatch: {
      "*": { title: "optimistic" },
    },
    serverCall: async () => ({ ok: true }),
  });

  await action.promise;
  releaseRefresh.resolve();
  await refresh;

  assert.deepEqual(serverStateCache.get("optimistic.race"), {
    title: "optimistic",
  });
});

test("pending optimistic cache mutation blocks newer server-state refresh until confirmed", async () => {
  serverStateCache.clear();
  serverStateCache.set("optimistic.pending-race", { title: "initial" });
  const releaseAction = deferred();

  const action = optimisticActionCenter.run({
    type: "test.pending-cache-race",
    scope: { surface: "optimistic-test-pending-cache-race" },
    targetKeys: ["optimistic.pending-race"],
    optimisticPatch: {
      "*": { title: "optimistic-pending" },
    },
    serverCall: async () => {
      await releaseAction.promise;
      return { ok: true };
    },
  });

  assert.deepEqual(serverStateCache.get("optimistic.pending-race"), {
    title: "optimistic-pending",
  });

  await serverStateCache.refresh(
    "optimistic.pending-race",
    async () => ({ title: "server-refresh" }),
    { priority: "P2" }
  );

  assert.deepEqual(serverStateCache.get("optimistic.pending-race"), {
    title: "optimistic-pending",
  });
  assert.equal(
    serverStateCache.meta("optimistic.pending-race").meta.optimisticStatus,
    "pending"
  );

  releaseAction.resolve();
  await action.promise;

  assert.equal(
    serverStateCache.meta("optimistic.pending-race").meta.optimisticStatus,
    "confirmed"
  );
});

test("stale optimistic action rolls back silently through recovery center", async () => {
  serverStateCache.clear();
  serverStateCache.set("optimistic.stale-rollback", { title: "old" });
  const started = deferred();
  const release = deferred();

  const action = optimisticActionCenter.run({
    type: "test.stale-rollback",
    scope: { surface: "optimistic-test-stale-rollback" },
    targetKeys: ["optimistic.stale-rollback"],
    optimisticPatch: {
      "*": { title: "new" },
    },
    priority: "P2",
    protected: false,
    abortable: false,
    serverCall: async () => {
      started.resolve();
      await release.promise;
      return { shouldNotConfirm: true };
    },
  });

  await started.promise;
  taskScheduler.markScopeStale(
    { surface: "optimistic-test-stale-rollback" },
    "test-stale-rollback"
  );
  release.resolve();

  const outcome = await action.promise;

  assert.equal(outcome.ok, false);
  assert.equal(outcome.stale, true);
  assert.equal(outcome.rolledBack, true);
  assert.equal(outcome.recovery.classification, "silent");
  assert.deepEqual(serverStateCache.get("optimistic.stale-rollback"), {
    title: "old",
  });
});

test("retryable optimistic failure records recovery and exposes retry handle", async () => {
  serverStateCache.clear();
  serverStateCache.set("optimistic.retry", { title: "old" });
  let calls = 0;

  const action = optimisticActionCenter.run({
    type: "test.retry",
    scope: { surface: "optimistic-test-retry" },
    targetKeys: ["optimistic.retry"],
    optimisticPatch: {
      "*": { title: "new" },
    },
    retryable: true,
    serverCall: async () => {
      calls += 1;
      if (calls === 1) throw new Error("Failed to fetch");
      return { saved: true };
    },
  });

  const failed = await action.promise;
  assert.equal(failed.ok, false);
  assert.equal(failed.recovery.classification, "rollback");
  assert.equal(failed.recovery.shouldRetry, true);
  assert.equal(failed.recovery.recoveryAction, "retry");
  assert.equal(action.snapshot().retryAvailable, true);
  assert.deepEqual(serverStateCache.get("optimistic.retry"), { title: "old" });

  const retry = action.retry();
  assert.ok(retry);
  const retried = await retry.promise;

  assert.equal(retried.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(serverStateCache.get("optimistic.retry"), { title: "new" });
});
