import test from "node:test";
import assert from "node:assert/strict";
import { inferTaskMetadata, TASK_PRIORITIES } from "./taskRequestMetadata.js";
import {
  activateRouteScope,
  routeScopeFromPathname,
} from "./routeScopeManager.js";
import { TaskScheduler, taskScheduler } from "./taskScheduler.js";

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
  assert.equal(task.coordinationContext.center, "task");
  assert.equal(task.coordinationContext.priority, "P0");
  assert.match(task.coordinationContext.coordinationRunId, /^coordination:/);
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
    path: "/workspace/demo/suggested-messages",
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

test("infers visible thumbnail display as P1 while keeping maintenance P4", () => {
  const displayThumbnail = inferTaskMetadata({
    method: "GET",
    path: "/reader-documents/doc-1/thumbnail",
    transport: "blob",
    communicationScene: "reader-visible",
  });
  const maintenanceThumbnail = inferTaskMetadata({
    method: "GET",
    path: "/reader-documents/doc-1/thumbnail",
    transport: "blob",
    communicationScene: "reader-maintenance",
  });

  assert.equal(displayThumbnail.priority, TASK_PRIORITIES.visibleSupport);
  assert.equal(displayThumbnail.resource, "network");
  assert.equal(maintenanceThumbnail.priority, TASK_PRIORITIES.maintenance);
  assert.equal(maintenanceThumbnail.resource, "idle");
});

test("infers explicit user-intent scenes for auth account reader and upload", () => {
  const authBootstrap = inferTaskMetadata({
    method: "GET",
    path: "/system/refresh-user",
    communicationScene: "auth-bootstrap",
  });
  const accountSettings = inferTaskMetadata({
    method: "GET",
    path: "/auth/passkeys",
    communicationScene: "account-settings",
  });
  const accountSecurity = inferTaskMetadata({
    method: "POST",
    path: "/auth/passkeys/register/options",
    communicationScene: "account-security",
  });
  const uploadVisible = inferTaskMetadata({
    method: "GET",
    path: "/system/accepted-document-types",
    communicationScene: "workspace-upload-visible",
  });
  const readerDelete = inferTaskMetadata({
    method: "DELETE",
    path: "/workspace/demo/reader-documents/doc-1",
  });

  assert.equal(authBootstrap.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(accountSettings.priority, TASK_PRIORITIES.visibleSupport);
  assert.equal(accountSettings.resource, "network");
  assert.equal(accountSecurity.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(accountSecurity.protected, true);
  assert.equal(uploadVisible.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(readerDelete.priority, TASK_PRIORITIES.activeIntent);
});

test("infers foreground priority for thread create and quiz submit", () => {
  const threadCreate = inferTaskMetadata({
    method: "POST",
    path: "/workspace/demo/thread/new",
  });
  const quizSubmit = inferTaskMetadata({
    method: "POST",
    path: "/workspace/demo/quiz/quiz-1/submit",
  });

  assert.equal(threadCreate.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(threadCreate.protected, true);
  assert.equal(quizSubmit.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(quizSubmit.protected, true);
});

test("infers visible support for admin and workspace overview reads", () => {
  const adminUsers = inferTaskMetadata({
    method: "GET",
    path: "/admin/users",
  });
  const overview = inferTaskMetadata({
    method: "GET",
    path: "/workspace/demo/overview",
  });
  const supplementList = inferTaskMetadata({
    method: "GET",
    path: "/workspace/demo/workspace-supplements",
  });

  assert.equal(adminUsers.priority, TASK_PRIORITIES.visibleSupport);
  assert.equal(overview.priority, TASK_PRIORITIES.visibleSupport);
  assert.equal(supplementList.priority, TASK_PRIORITIES.visibleSupport);
});

test("infers active intent for admin security writes", () => {
  const deleteUser = inferTaskMetadata({
    method: "DELETE",
    path: "/admin/user/user-1",
  });
  const browserKey = inferTaskMetadata({
    method: "POST",
    path: "/browser-extension/api-keys/new",
  });

  assert.equal(deleteUser.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(deleteUser.protected, true);
  assert.equal(browserKey.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(browserKey.protected, true);
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

test("chat streams default to protected P0 realtime", () => {
  const stream = inferTaskMetadata({
    method: "POST",
    path: "/workspace/demo/thread/thread-a/stream-chat",
    transport: "stream",
    communicationScene: "workspace-chat",
  });

  assert.equal(stream.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(stream.policy, "realtime");
  assert.equal(stream.protected, true);
  assert.equal(stream.abortable, false);
  assert.equal(stream.resource, "realtime");
});

test("nested requests inherit active parent task intent by default", async () => {
  const scheduler = new TaskScheduler();
  const handle = scheduler.schedule(
    async () =>
      inferTaskMetadata({
        method: "GET",
        path: "/reader-documents/doc-1",
        communicationScene: "reader-open",
      }),
    {
      kind: "reader-open",
      priority: "P0",
      policy: "foreground",
      resource: "network",
      protected: true,
      abortable: false,
      intentRank: 0,
      scope: { route: "reader", surface: "reader-open" },
    }
  );

  const metadata = await handle.promise;
  assert.equal(metadata.priority, TASK_PRIORITIES.activeIntent);
  assert.equal(metadata.protected, true);
  assert.equal(metadata.abortable, false);
  assert.equal(metadata.intentRank, 0);
  assert.equal(metadata.resource, "network");
  assert.equal(metadata.scope.parentKind, "reader-open");
  assert.equal(metadata.inherited, true);
  assert.equal(metadata.inferred, false);
});

test("route scope switch preempts old non-protected workspace tasks", async () => {
  const oldScope = routeScopeFromPathname("/workspace/old/t/thread-a");
  activateRouteScope(oldScope, "test-start");

  let oldAborted = false;
  let oldP0Aborted = false;
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
  const oldP0Task = taskScheduler.schedule(
    async ({ signal }) => {
      await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            oldP0Aborted = true;
            resolve();
          },
          { once: true }
        );
      });
    },
    {
      kind: "test-old-p0",
      priority: "P0",
      scope: oldScope,
      label: "old-visible-intent",
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
  await oldP0Task.promise;
  assert.equal(oldAborted, true);
  assert.equal(oldP0Aborted, true);
  assert.equal(await protectedTask.promise, "saved");

  const snapshot = taskScheduler.snapshot();
  assert.ok(snapshot.byKind);
  assert.ok(snapshot.byScope);
  assert.ok(Array.isArray(snapshot.recentPreemptions));
  assert.equal(typeof snapshot.oldestPendingMs, "number");
  assert.equal(typeof snapshot.oldP0StaleCount, "number");
});
