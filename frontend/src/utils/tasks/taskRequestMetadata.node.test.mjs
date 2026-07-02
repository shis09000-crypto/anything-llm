import test from "node:test";
import assert from "node:assert/strict";
import { inferTaskMetadata, TASK_PRIORITIES } from "./taskRequestMetadata.js";
import {
  activateRouteScope,
  routeScopeFromPathname,
} from "./routeScopeManager.js";
import { taskScheduler } from "./taskScheduler.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("infers protected P0 for high-risk security requests", () => {
  const task = inferTaskMetadata({
    method: "DELETE",
    path: "/vault/items/item-1",
    transport: "json",
  });

  assert.equal(task.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(task.protected, true);
  assert.equal(task.emergency, false);
  assert.equal(task.abortable, false);
  assert.equal(task.kind, "security");
  assert.equal(task.scope.route, "global");
});

test("P0 requests are not exclusive unless emergency is explicit", () => {
  const highRisk = inferTaskMetadata({
    method: "POST",
    path: "/request-token",
    transport: "json",
  });
  const explicitEmergency = inferTaskMetadata({
    method: "GET",
    path: "/workspace/demo/thread/thread-a",
    communicationScene: "workspace-chat-current",
    task: { priority: "P0", emergency: true },
  });

  assert.equal(highRisk.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(highRisk.emergency, false);
  assert.equal(explicitEmergency.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(explicitEmergency.emergency, true);
});

test("infers protected visible task for normal writes", () => {
  const task = inferTaskMetadata({
    method: "POST",
    path: "/workspace/demo/thread/new",
    communicationScene: "workspace-chat",
  });

  assert.equal(task.priority, TASK_PRIORITIES.visibleSupport);
  assert.equal(task.protected, true);
  assert.equal(task.abortable, false);
  assert.equal(task.scope.route, "workspace-chat");
  assert.equal(task.scope.workspaceSlug, "demo");
});

test("infers maintenance lane for thumbnail and classification requests", () => {
  const thumbnail = inferTaskMetadata({
    method: "GET",
    path: "/reader-documents/doc-1/thumbnail",
    transport: "blob",
  });
  const classification = inferTaskMetadata({
    method: "GET",
    path: "/reader-documents/doc-1/classification",
    communicationScene: "reader-maintenance",
  });

  assert.equal(thumbnail.priority, TASK_PRIORITIES.maintenance);
  assert.equal(thumbnail.protected, false);
  assert.equal(classification.priority, TASK_PRIORITIES.maintenance);
});

test("stream requests use realtime policy without becoming exclusive", () => {
  const stream = inferTaskMetadata({
    method: "GET",
    path: "/sync/events",
    transport: "stream",
    communicationScene: "sync",
  });

  assert.equal(stream.priority, TASK_PRIORITIES.backgroundContinuation);
  assert.equal(stream.policy, "realtime");
  assert.equal(stream.emergency, false);
  assert.equal(stream.protected, false);
});

test("route scope switch preempts old low-priority workspace tasks only", async () => {
  const oldScope = routeScopeFromPathname("/workspace/old/t/thread-a");
  activateRouteScope(oldScope, "test-start");

  let oldAborted = false;
  const oldTask = taskScheduler.schedule(
    async ({ signal }) => {
      await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            oldAborted = true;
            resolve();
          },
          { once: true }
        );
      });
    },
    {
      kind: "test-old",
      priority: "P3",
      scope: oldScope,
      label: "old-prefetch",
    }
  );

  const protectedTask = taskScheduler.schedule(async () => "saved", {
    kind: "test-write",
    priority: "P1",
    protected: true,
    scope: oldScope,
    label: "protected-write",
  });

  await wait();
  activateRouteScope(
    routeScopeFromPathname("/workspace/new/t/thread-b"),
    "test-switch"
  );
  await oldTask.promise;
  assert.equal(oldAborted, true);
  assert.equal(await protectedTask.promise, "saved");

  const snapshot = taskScheduler.snapshot();
  assert.ok(snapshot.byKind);
  assert.ok(snapshot.byScope);
  assert.ok(Array.isArray(snapshot.recentPreemptions));
  assert.equal(typeof snapshot.oldestPendingMs, "number");
});
