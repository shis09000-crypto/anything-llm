import test from "node:test";
import assert from "node:assert/strict";
import { TaskScheduler } from "./taskScheduler.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function holdUntilAbort(label, events) {
  return ({ signal }) =>
    new Promise((resolve) => {
      events.push(`${label}:start`);
      signal.addEventListener(
        "abort",
        () => {
          events.push(`${label}:abort`);
          resolve(null);
        },
        { once: true }
      );
    });
}

test("stress: current intent preempts stale workspace and reader background work", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 1,
    backgroundMaxConcurrent: 2,
    prefetchMaxConcurrent: 1,
  });
  const events = [];

  const oldWorkspace = scheduler.schedule(
    holdUntilAbort("old-workspace", events),
    {
      kind: "workspace-prefetch",
      priority: "P3",
      scope: { route: "workspace-chat", workspaceSlug: "old" },
      label: "old workspace prefetch",
    }
  );
  const oldReader = scheduler.schedule(holdUntilAbort("old-reader", events), {
    kind: "reader-next-pages",
    priority: "P3",
    scope: { route: "reader", readerDocumentId: "old-book" },
    label: "old reader pages",
  });
  await wait();

  scheduler.cancelWhere(
    (task) =>
      ["P2", "P3", "P4"].includes(task.priority) &&
      !task.protected &&
      (task.scope.workspaceSlug === "old" ||
        task.scope.readerDocumentId === "old-book"),
    { reason: "stress-switch", includeRunning: true }
  );

  const current = scheduler.scheduleEmergency(
    async () => {
      events.push("current:intent");
      return "ready";
    },
    {
      kind: "workspace-first-screen",
      scope: { route: "workspace-chat", workspaceSlug: "new" },
      label: "current intent",
    }
  );

  assert.equal(await current.promise, "ready");
  await oldWorkspace.promise;
  await oldReader.promise;
  assert.equal(events.includes("old-workspace:abort"), true);
  assert.equal(events.includes("current:intent"), true);
  assert.equal(events.includes("old-reader:start"), false);
  assert.deepEqual(events.slice(-1), ["current:intent"]);
});

test("stress: protected chat stream survives emergency and background work pauses", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 2,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
  });
  const events = [];

  const chatStream = scheduler.schedule(
    async () => {
      events.push("chat:start");
      await wait(10);
      events.push("chat:done");
      return "sent";
    },
    {
      kind: "chat-stream",
      priority: "P0",
      protected: true,
      scope: { route: "workspace-chat", threadSlug: "active" },
      label: "protected chat stream",
    }
  );
  const maintenance = scheduler.schedule(
    async () => events.push("maintenance"),
    {
      kind: "thumbnail-maintenance",
      priority: "P4",
      scope: { route: "reader" },
      label: "thumbnail patrol",
    }
  );

  const emergency = scheduler.scheduleEmergency(
    async () => {
      events.push("settings:current");
      return "tab";
    },
    {
      kind: "settings-tab",
      scope: { route: "settings" },
      label: "settings tab",
    }
  );

  assert.equal(await emergency.promise, "tab");
  assert.equal(await chatStream.promise, "sent");
  await maintenance.promise;
  assert.equal(events.includes("chat:done"), true);
  assert.equal(events.includes("maintenance"), true);
  assert.equal(scheduler.snapshot().exclusiveMode.active, false);
});
