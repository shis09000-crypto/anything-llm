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

test("stress: reader open can become the newest intent while chat first page is loading", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 2,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
  });
  const events = [];
  let releaseChat = null;

  const chatFirstPage = scheduler.scheduleEmergency(
    async () => {
      events.push("chat:first-page:start");
      await new Promise((resolve) => {
        releaseChat = resolve;
      });
      events.push("chat:first-page:done");
      return "chat";
    },
    {
      kind: "workspace-first-page",
      label: "chat first page",
      intentRank: 2,
      scope: { route: "workspace-chat", workspaceSlug: "w1", threadSlug: "t1" },
    }
  );
  await wait();

  const readerOpen = scheduler.scheduleEmergency(
    async () => {
      events.push("reader:open:start");
      return "reader";
    },
    {
      kind: "reader",
      label: "reader open document",
      intentRank: 0,
      scope: { route: "workspace-chat", surface: "reader-open" },
    }
  );

  assert.equal(await readerOpen.promise, "reader");
  assert.equal(events.includes("reader:open:start"), true);
  assert.equal(events.includes("chat:first-page:done"), false);
  releaseChat();
  assert.equal(await chatFirstPage.promise, "chat");
});

test("stress: protected workspace overview survives sequential navigation emergencies", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 2,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
  });
  const events = [];
  let releaseWorkspaces = null;
  let releaseOverview = null;

  const workspaces = scheduler.scheduleEmergency(
    () =>
      new Promise((resolve) => {
        releaseWorkspaces = resolve;
        events.push("workspaces:start");
      }),
    {
      kind: "navigation",
      label: "navigation:workspaces",
    }
  );
  await wait();

  const overview = scheduler.schedule(
    ({ signal }) =>
      new Promise((resolve) => {
        releaseOverview = resolve;
        events.push("overview:start");
        signal.addEventListener(
          "abort",
          () => {
            events.push("overview:abort");
            resolve(null);
          },
          { once: true }
        );
      }),
    {
      kind: "workspace-overview",
      label: "workspace-overview:get",
      priority: "P1",
      policy: "visible",
      protected: true,
      abortable: false,
      scope: { route: "workspace-chat", surface: "workspace-overview" },
    }
  );
  await wait();

  releaseWorkspaces("workspaces");
  await workspaces.promise;
  const threads = scheduler.scheduleEmergency(async () => "threads", {
    kind: "navigation",
    label: "navigation:threads",
  });
  await threads.promise;

  releaseOverview("overview");
  assert.equal(await overview.promise, "overview");
  assert.equal(events.includes("overview:abort"), false);
  assert.equal(
    scheduler
      .snapshot()
      .aborted.some((task) => task.label === "workspace-overview:get"),
    false
  );
});
