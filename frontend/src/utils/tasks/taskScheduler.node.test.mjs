import test from "node:test";
import assert from "node:assert/strict";
import { TaskScheduler } from "./taskScheduler.js";

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

test("P0 tasks run before lower priority pending tasks", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 1,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
  });
  scheduler.setPaused("P2", true);

  const order = [];
  const low = scheduler.schedule(async () => order.push("low"), {
    priority: "P2",
    label: "low",
    kind: "test",
  });
  await wait();
  assert.equal(scheduler.snapshot().pending.length, 1);

  const high = scheduler.schedule(async () => order.push("high"), {
    priority: "P0",
    label: "high",
    kind: "test",
  });
  await high.promise;
  scheduler.setPaused("P2", false);
  await low.promise;

  assert.deepEqual(order, ["high", "low"]);
});

test("P0 intentRank orders current navigation before chat history", async () => {
  const scheduler = new TaskScheduler({ maxConcurrent: 1 });
  scheduler.setPaused("P0", true);

  const order = [];
  const chat = scheduler.schedule(async () => order.push("chat"), {
    priority: "P0",
    intentRank: 2,
    label: "chat-first-page",
    kind: "chat",
  });
  const sidebar = scheduler.schedule(async () => order.push("sidebar"), {
    priority: "P0",
    intentRank: 0,
    label: "sidebar-navigation",
    kind: "navigation",
  });

  await wait();
  scheduler.setPaused("P0", false);
  await Promise.all([chat.promise, sidebar.promise]);

  assert.deepEqual(order, ["sidebar", "chat"]);
  assert.equal(scheduler.snapshot().activeIntent, null);
});

test("emergency pauses pending low priority tasks until complete", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 1,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
  });
  scheduler.setPaused("P3", true);

  const order = [];
  const prefetch = scheduler.schedule(async () => order.push("prefetch"), {
    priority: "P3",
    label: "prefetch",
    kind: "test",
  });
  await wait();

  const emergency = scheduler.scheduleEmergency(async () => {
    order.push("emergency");
    await wait(5);
  });
  await emergency.promise;
  assert.equal(scheduler.snapshot().exclusiveMode.active, false);

  scheduler.setPaused("P3", false);
  await prefetch.promise;
  assert.deepEqual(order, ["emergency", "prefetch"]);
});

test("emergency aborts running lower priority abortable tasks", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 1,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
  });
  const started = deferred();
  let aborted = false;

  const low = scheduler.schedule(
    async ({ signal }) => {
      started.resolve();
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
      priority: "P2",
      label: "running-low",
      kind: "test",
    }
  );
  await started.promise;

  const emergency = scheduler.scheduleEmergency(async () => "ok", {
    label: "emergency",
  });
  await emergency.promise;
  await low.promise;

  assert.equal(aborted, true);
  assert.equal(low.promise instanceof Promise, true);
  assert.equal(
    scheduler.snapshot().aborted.some((task) => task.label === "running-low"),
    true
  );
});

test("emergency exclusive releases after deadline while task keeps running", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 1,
    backgroundMaxConcurrent: 1,
    exclusiveMaxMs: 10,
  });
  const emergencyStarted = deferred();
  const backgroundStarted = deferred();
  const never = deferred();

  const emergency = scheduler.scheduleEmergency(
    async () => {
      emergencyStarted.resolve();
      await never.promise;
    },
    {
      label: "slow-emergency",
      kind: "test",
    }
  );
  await emergencyStarted.promise;
  assert.equal(scheduler.snapshot().exclusiveMode.active, true);

  await wait(25);
  assert.equal(scheduler.snapshot().exclusiveMode.active, false);

  const background = scheduler.schedule(
    async () => {
      backgroundStarted.resolve();
      return "background";
    },
    {
      priority: "P2",
      label: "background-after-exclusive-deadline",
      kind: "test",
    }
  );
  await backgroundStarted.promise;
  assert.equal(await background.promise, "background");

  emergency.markStale("test-cleanup");
  assert.equal(await emergency.promise, null);
});

test("aborted running task releases its lane immediately", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 1,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
  });
  const started = deferred();
  const never = deferred();

  const low = scheduler.schedule(
    async ({ signal }) => {
      started.resolve();
      signal.addEventListener("abort", () => {}, { once: true });
      await never.promise;
    },
    {
      priority: "P2",
      label: "stuck-low",
      kind: "test",
    }
  );
  await started.promise;
  assert.equal(scheduler.snapshot().lanes.background, 1);

  const emergency = scheduler.scheduleEmergency(async () => "ok", {
    label: "emergency",
  });
  await emergency.promise;
  await low.promise;

  assert.equal(scheduler.snapshot().lanes.background, 0);
  assert.equal(scheduler.snapshot().running.length, 0);
});

test("stale running task releases its lane even when it cannot abort", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 1,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
  });
  const started = deferred();
  const never = deferred();

  const handle = scheduler.schedule(
    async () => {
      started.resolve();
      await never.promise;
    },
    {
      priority: "P2",
      label: "nonabortable-low",
      kind: "test",
      abortable: false,
    }
  );
  await started.promise;
  assert.equal(scheduler.snapshot().lanes.background, 1);

  handle.markStale("manual-stale");
  await handle.promise;

  assert.equal(scheduler.snapshot().lanes.background, 0);
  assert.equal(scheduler.snapshot().running.length, 0);
  assert.equal(
    scheduler
      .snapshot()
      .stale.some((task) => task.label === "nonabortable-low"),
    true
  );
});

test("higher priority background task preempts lower priority lane occupant", async () => {
  const scheduler = new TaskScheduler({
    backgroundMaxConcurrent: 1,
  });
  const maintenanceStarted = deferred();
  const visibleStarted = deferred();
  const never = deferred();
  let maintenanceAborted = false;

  const maintenance = scheduler.schedule(
    async ({ signal }) => {
      maintenanceStarted.resolve();
      signal.addEventListener(
        "abort",
        () => {
          maintenanceAborted = true;
        },
        { once: true }
      );
      await never.promise;
    },
    {
      priority: "P4",
      label: "maintenance-refresh",
      kind: "test",
    }
  );
  await maintenanceStarted.promise;
  assert.equal(scheduler.snapshot().lanes.background, 1);

  const visible = scheduler.schedule(
    async () => {
      visibleStarted.resolve();
      return "visible";
    },
    {
      priority: "P2",
      label: "visible-reader-refresh",
      kind: "test",
    }
  );
  await visibleStarted.promise;

  assert.equal(await visible.promise, "visible");
  assert.equal(await maintenance.promise, null);
  assert.equal(maintenanceAborted, true);
  assert.equal(scheduler.snapshot().lanes.background, 0);
});

test("P0 network task preempts lower priority work across occupied lanes", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 1,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
  });
  const never = deferred();
  const started = {
    main: deferred(),
    background: deferred(),
    prefetch: deferred(),
    active: deferred(),
  };
  const aborted = {
    main: false,
    background: false,
    prefetch: false,
  };

  const main = scheduler.schedule(
    async ({ signal }) => {
      started.main.resolve();
      signal.addEventListener(
        "abort",
        () => {
          aborted.main = true;
        },
        { once: true }
      );
      await never.promise;
    },
    { priority: "P1", label: "visible-main", kind: "test" }
  );
  const background = scheduler.schedule(
    async ({ signal }) => {
      started.background.resolve();
      signal.addEventListener(
        "abort",
        () => {
          aborted.background = true;
        },
        { once: true }
      );
      await never.promise;
    },
    { priority: "P2", label: "background-fetch", kind: "test" }
  );
  const prefetch = scheduler.schedule(
    async ({ signal }) => {
      started.prefetch.resolve();
      signal.addEventListener(
        "abort",
        () => {
          aborted.prefetch = true;
        },
        { once: true }
      );
      await never.promise;
    },
    { priority: "P3", label: "prefetch-fetch", kind: "test" }
  );

  await Promise.all([
    started.main.promise,
    started.background.promise,
    started.prefetch.promise,
  ]);
  assert.equal(scheduler.snapshot().lanes.resources.network, 3);

  const active = scheduler.schedule(
    async () => {
      started.active.resolve();
      return "active";
    },
    {
      priority: "P0",
      intentRank: 0,
      label: "active-intent",
      kind: "test",
    }
  );

  await started.active.promise;
  assert.equal(await active.promise, "active");
  assert.equal(aborted.main, true);
  assert.equal(aborted.background || aborted.prefetch, true);

  scheduler.cancelScope({}, "test-cleanup");
  await Promise.all([main.promise, background.promise, prefetch.promise]);
});

test("render resource tasks do not occupy network lanes", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 1,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
    resourceBudgets: { render: 1 },
  });
  const events = [];
  const networkStarted = deferred();
  const renderStarted = deferred();
  const never = deferred();

  scheduler.schedule(
    async () => {
      events.push("network:start");
      networkStarted.resolve();
      await never.promise;
    },
    { priority: "P0", resource: "network", kind: "network" }
  );
  await networkStarted.promise;

  const render = scheduler.schedule(
    async () => {
      events.push("render:start");
      renderStarted.resolve();
      return "render";
    },
    { priority: "P1", resource: "render", kind: "render" }
  );
  await renderStarted.promise;
  assert.equal(await render.promise, "render");
  assert.deepEqual(events, ["network:start", "render:start"]);
});

test("realtime tasks stay cancellable without occupying finite lanes", async () => {
  const scheduler = new TaskScheduler({
    maxConcurrent: 1,
    backgroundMaxConcurrent: 1,
    prefetchMaxConcurrent: 1,
  });
  const realtimeStarted = deferred();
  const backgroundStarted = deferred();
  const never = deferred();

  const realtime = scheduler.schedule(
    async ({ signal }) => {
      realtimeStarted.resolve();
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
    },
    {
      priority: "P2",
      policy: "realtime",
      label: "realtime-stream",
      kind: "test",
    }
  );
  await realtimeStarted.promise;

  const background = scheduler.schedule(
    async () => {
      backgroundStarted.resolve();
      await never.promise;
    },
    {
      priority: "P2",
      label: "background-fetch",
      kind: "test",
    }
  );
  await backgroundStarted.promise;

  assert.equal(scheduler.snapshot().running.length, 2);
  assert.equal(scheduler.snapshot().lanes.background, 1);

  scheduler.cancelScope({}, "test-cleanup");
  await realtime.promise;
  await background.promise;
  assert.equal(scheduler.snapshot().running.length, 0);
});

test("dedupeKey returns the existing handle", async () => {
  const scheduler = new TaskScheduler();
  let runs = 0;
  const first = scheduler.schedule(
    async () => {
      runs += 1;
      await wait(5);
      return "first";
    },
    { dedupeKey: "same", label: "first" }
  );
  const second = scheduler.schedule(async () => "second", {
    dedupeKey: "same",
    label: "second",
  });

  assert.equal(first.id, second.id);
  assert.equal(await second.promise, "first");
  assert.equal(runs, 1);
});

test("stale pending task resolves null and never runs", async () => {
  const scheduler = new TaskScheduler({ maxConcurrent: 1 });
  scheduler.setPaused("P4", true);
  let ran = false;
  const handle = scheduler.schedule(
    async () => {
      ran = true;
      return "ran";
    },
    { priority: "P4", label: "maintenance", kind: "test" }
  );

  handle.markStale("test-stale");
  assert.equal(await handle.promise, null);
  scheduler.setPaused("P4", false);
  await wait();

  assert.equal(ran, false);
  assert.equal(
    scheduler.snapshot().stale.some((task) => task.label === "maintenance"),
    true
  );
});
