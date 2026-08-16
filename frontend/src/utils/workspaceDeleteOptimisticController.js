import showToast from "@/utils/toast";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import {
  WORKSPACE_DELETE_ANIMATION_MS,
  dispatchWorkspaceCreateVisual,
  dispatchWorkspaceDeleteVisual,
  dispatchWorkspacesRestoreVisual,
} from "@/utils/workspaceEvents";
import { clearLastVisitedWorkspace } from "@/utils/lastVisitedWorkspace";

const pendingDeletes = new Map();
const pendingBySlug = new Map();
const pendingCreates = new Map();
const visualFinalizeTimers = new Map();
let deleteSequence = 0;
let createSequence = 0;
const DELETE_FINALIZE_TIMEOUT_MS = 2 * 60 * 1_000;

function createWorkspaceIntentId() {
  createSequence += 1;
  return `workspace-create:${Date.now().toString(36)}:${createSequence}`;
}

function createDeleteIntentId(workspaceSlug = "workspace") {
  deleteSequence += 1;
  return `workspace-delete:${workspaceSlug}:${Date.now().toString(
    36
  )}:${deleteSequence}`;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function workspaceSlugFromEvent(event = {}) {
  return event.payload?.workspaceSlug || event.scope?.workspaceSlug || null;
}

function deleteIntentIdFromEvent(event = {}) {
  return event.payload?.deleteIntentId || event.deleteIntentId || null;
}

function snapshotWorkspace(workspaceSlug = null) {
  if (!workspaceSlug) return null;
  return {
    workspaces: workspaceNavigationCache.getWorkspaces(),
    detail: workspaceNavigationCache.getWorkspaceDetail(workspaceSlug),
    threads: workspaceNavigationCache.getThreads(workspaceSlug),
  };
}

function snapshotWorkspaces() {
  return workspaceNavigationCache.getWorkspaces();
}

function createOptimisticWorkspace(data = {}, createIntentId = null) {
  const now = new Date().toISOString();
  const name = String(data?.name || "").trim() || "New Workspace";
  const slugSeed = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const slug = `optimistic-${slugSeed || "workspace"}-${Date.now().toString(
    36
  )}`;
  return {
    id: `optimistic:${createIntentId || slug}`,
    name,
    slug,
    optimistic: true,
    createdAt: now,
    lastUpdatedAt: now,
  };
}

function applyWorkspaceCreate(workspace, detail = {}) {
  if (!workspace?.slug) return;
  const current = workspaceNavigationCache.getWorkspaces({ allowStale: true });
  if (Array.isArray(current)) {
    const withoutDuplicates = current.filter(
      (existing) =>
        existing?.slug !== workspace.slug &&
        existing?.slug !== detail.replaceSlug &&
        existing?.id !== workspace.id
    );
    workspaceNavigationCache.setWorkspaces([workspace, ...withoutDuplicates]);
  }
  if (!workspace.optimistic) {
    workspaceNavigationCache.setWorkspaceDetail(workspace.slug, workspace);
  }
  dispatchWorkspaceCreateVisual({
    workspace,
    replaceSlug: detail.replaceSlug || null,
    animate: detail.animate !== false,
    createIntentId: detail.createIntentId || null,
    source: detail.source || "workspace-create",
  });
}

function rollbackWorkspaceCreate(optimisticWorkspace, snapshot, detail = {}) {
  if (Array.isArray(snapshot)) {
    workspaceNavigationCache.setWorkspaces(snapshot);
    dispatchWorkspacesRestoreVisual({
      workspaces: snapshot,
      deletedWorkspaceSlug: optimisticWorkspace?.slug || null,
      createIntentId: detail.createIntentId || null,
      source: detail.source || "workspace-create-rollback",
    });
    return;
  }
  if (optimisticWorkspace?.slug) {
    applyWorkspaceDelete(optimisticWorkspace.slug, {
      animate: true,
      source: detail.source || "workspace-create-rollback",
    });
  }
}

function registerWorkspaceCreate({ data = {}, source = "local" } = {}) {
  const createIntentId = createWorkspaceIntentId();
  const optimisticWorkspace = createOptimisticWorkspace(data, createIntentId);
  const snapshot = snapshotWorkspaces();
  const actionId = `workspace.create:${createIntentId}`;

  const handle = optimisticActionCenter.run({
    actionId,
    type: "workspace.create",
    scope: {
      route: source === "local" ? "workspace-create" : "broadcast",
      surface: "workspace-create",
      optimisticWorkspaceSlug: optimisticWorkspace.slug,
    },
    priority: "P0",
    policy: "foreground",
    intentRank: 0,
    protected: true,
    abortable: false,
    immediate: true,
    label: "optimistic:workspace-create",
    dedupeKey: `optimistic:workspace-create:${createIntentId}`,
    optimisticPatch: () => {
      pendingCreates.set(createIntentId, {
        createIntentId,
        optimisticWorkspace,
        snapshot,
      });
      applyWorkspaceCreate(optimisticWorkspace, {
        createIntentId,
        source,
      });
    },
    rollbackPatch: () => {
      pendingCreates.delete(createIntentId);
      rollbackWorkspaceCreate(optimisticWorkspace, snapshot, {
        createIntentId,
        source,
      });
    },
    confirmPatch: ({ result }) => {
      const workspace = result?.workspace;
      if (!workspace?.slug) return;
      pendingCreates.delete(createIntentId);
      applyWorkspaceCreate(workspace, {
        replaceSlug: optimisticWorkspace.slug,
        animate: false,
        createIntentId,
        source: `${source}-confirm`,
      });
    },
    serverCall: async ({ signal }) => {
      const { default: Workspace } = await import("@/models/workspace");
      const result = await Workspace.new(data, {
        signal,
        communicationScene: "workspace-navigation",
        task: false,
      });
      if (!result?.workspace?.slug) {
        throw new Error(result?.message || "workspace create failed");
      }
      return result;
    },
  });

  return { handle, optimisticWorkspace, createIntentId };
}

export function requestWorkspaceCreate(data = {}) {
  return registerWorkspaceCreate({ data, source: "local" });
}

export function handleWorkspaceCreated(event = {}) {
  const workspaceSlug =
    event.payload?.workspaceSlug || event.scope?.workspaceSlug;
  if (!workspaceSlug) return null;
  const workspace = {
    id: event.scope?.workspaceId || event.resource?.id || workspaceSlug,
    slug: workspaceSlug,
    name: event.payload?.workspaceName || event.payload?.name || workspaceSlug,
    createdAt: event.createdAt,
    lastUpdatedAt: event.createdAt,
  };
  applyWorkspaceCreate(workspace, {
    source: "broadcast",
    animate: true,
  });
  return { created: true, workspaceSlug };
}

function applyWorkspaceDelete(workspaceSlug, detail = {}) {
  if (!workspaceSlug) return;
  clearLastVisitedWorkspace(workspaceSlug);
  const existingTimer = visualFinalizeTimers.get(workspaceSlug);
  if (existingTimer) globalThis.clearTimeout?.(existingTimer);
  dispatchWorkspaceDeleteVisual({
    workspaceSlug,
    animate: detail.animate !== false,
    deleteIntentId: detail.deleteIntentId || null,
    source: detail.source || "workspace-delete",
  });
  const timer = globalThis.setTimeout?.(
    () => {
      visualFinalizeTimers.delete(workspaceSlug);
      workspaceNavigationCache.removeWorkspace(workspaceSlug);
    },
    detail.animate === false ? 0 : WORKSPACE_DELETE_ANIMATION_MS
  );
  if (timer) visualFinalizeTimers.set(workspaceSlug, timer);
}

function rollbackWorkspaceDelete(workspaceSlug, snapshot, detail = {}) {
  if (!workspaceSlug || !snapshot) return;
  const existingTimer = visualFinalizeTimers.get(workspaceSlug);
  if (existingTimer) {
    globalThis.clearTimeout?.(existingTimer);
    visualFinalizeTimers.delete(workspaceSlug);
  }
  if (Array.isArray(snapshot.workspaces)) {
    workspaceNavigationCache.setWorkspaces(snapshot.workspaces);
  }
  if (snapshot.detail) {
    workspaceNavigationCache.setWorkspaceDetail(workspaceSlug, snapshot.detail);
  }
  if (Array.isArray(snapshot.threads)) {
    workspaceNavigationCache.setThreads(workspaceSlug, snapshot.threads);
  }
  if (Array.isArray(snapshot.workspaces)) {
    dispatchWorkspacesRestoreVisual({
      workspaces: snapshot.workspaces,
      workspace: snapshot.detail || null,
      restoredWorkspaceSlug: workspaceSlug,
      deleteIntentId: detail.deleteIntentId || null,
      source: detail.source || "workspace-delete-rollback",
    });
  } else if (snapshot.detail) {
    dispatchWorkspaceCreateVisual({
      workspace: snapshot.detail,
      animate: true,
      source: detail.source || "workspace-delete-rollback",
    });
  }
}

function clearPending(entry) {
  if (!entry) return;
  if (entry.timeoutId) globalThis.clearTimeout?.(entry.timeoutId);
  pendingDeletes.delete(entry.deleteIntentId);
  if (pendingBySlug.get(entry.workspaceSlug) === entry.deleteIntentId) {
    pendingBySlug.delete(entry.workspaceSlug);
  }
}

function pendingEntryFor(event = {}) {
  const deleteIntentId = deleteIntentIdFromEvent(event);
  if (deleteIntentId && pendingDeletes.has(deleteIntentId)) {
    return pendingDeletes.get(deleteIntentId);
  }
  const workspaceSlug = workspaceSlugFromEvent(event);
  const intentForSlug = pendingBySlug.get(workspaceSlug);
  return intentForSlug ? pendingDeletes.get(intentForSlug) : null;
}

function registerWorkspaceDelete({
  workspaceSlug,
  workspace = null,
  deleteIntentId = createDeleteIntentId(workspaceSlug),
  source = "local",
  serverCall,
} = {}) {
  if (!workspaceSlug || typeof serverCall !== "function") return null;

  const existingIntent = pendingBySlug.get(workspaceSlug);
  if (existingIntent && pendingDeletes.has(existingIntent)) {
    return pendingDeletes.get(existingIntent)?.handle || null;
  }

  const snapshot = snapshotWorkspace(workspaceSlug);
  const deferred = createDeferred();
  const actionId = `workspace.delete:${deleteIntentId}`;
  const entry = {
    actionId,
    deleteIntentId,
    workspaceSlug,
    snapshot,
    source,
    deferred,
    handle: null,
    accepted: false,
    failureNotified: false,
    timeoutId: null,
  };
  pendingDeletes.set(deleteIntentId, entry);
  pendingBySlug.set(workspaceSlug, deleteIntentId);

  entry.timeoutId = globalThis.setTimeout?.(() => {
    if (!pendingDeletes.has(deleteIntentId)) return;
    deferred.resolve({ timeout: true, deleteIntentId, workspaceSlug });
  }, DELETE_FINALIZE_TIMEOUT_MS);

  const handle = optimisticActionCenter.run({
    actionId,
    type: "workspace.delete",
    scope: {
      route: source === "local" ? "workspace-settings" : "broadcast",
      surface: "workspace-delete",
      workspaceSlug,
    },
    priority: "P0",
    policy: "foreground",
    intentRank: 0,
    protected: true,
    abortable: false,
    tombstone: true,
    label: "optimistic:workspace-delete",
    dedupeKey: `optimistic:workspace-delete:${workspaceSlug}`,
    optimisticPatch: () => {
      applyWorkspaceDelete(workspaceSlug, {
        deleteIntentId,
        source,
        workspace,
      });
    },
    rollbackPatch: () => {
      rollbackWorkspaceDelete(workspaceSlug, snapshot, {
        deleteIntentId,
        source,
      });
    },
    serverCall: async ({ signal }) => {
      await serverCall({
        signal,
        actionId,
        deleteIntentId,
        workspaceSlug,
      });
      entry.accepted = true;
      return deferred.promise;
    },
  });

  entry.handle = handle;
  void handle.promise.then((outcome) => {
    clearPending(entry);
    if (!outcome.ok && source === "local" && !entry.failureNotified) {
      showToast("Workspace could not be deleted!", "error", { clear: true });
    }
  });
  return handle;
}

export function requestWorkspaceDelete({ workspace } = {}) {
  const workspaceSlug = workspace?.slug;
  if (!workspaceSlug) return null;
  return registerWorkspaceDelete({
    workspace,
    workspaceSlug,
    source: "local",
    serverCall: async ({ signal, deleteIntentId, actionId }) => {
      const { default: Workspace } = await import("@/models/workspace");
      const success = await Workspace.delete(workspaceSlug, {
        signal,
        communicationScene: "workspace-navigation",
        task: false,
        deleteIntentId,
        sourceActionId: actionId,
      });
      if (!success) throw new Error("workspace delete was not accepted");
      return true;
    },
  });
}

export function handleWorkspaceDeleteRequested(event = {}) {
  const workspaceSlug = workspaceSlugFromEvent(event);
  if (!workspaceSlug) return null;
  const deleteIntentId =
    deleteIntentIdFromEvent(event) || createDeleteIntentId(workspaceSlug);
  return registerWorkspaceDelete({
    workspaceSlug,
    deleteIntentId,
    source: "broadcast",
    serverCall: () => Promise.resolve(true),
  });
}

export function confirmWorkspaceDelete(event = {}) {
  const workspaceSlug = workspaceSlugFromEvent(event);
  if (!workspaceSlug) return null;
  const entry = pendingEntryFor(event);
  if (!entry) {
    applyWorkspaceDelete(workspaceSlug, {
      deleteIntentId: deleteIntentIdFromEvent(event),
      source: "broadcast-confirm",
      animate: true,
    });
    return { confirmed: false, removed: true };
  }
  entry.deferred.resolve({
    event,
    deleteIntentId: entry.deleteIntentId,
    workspaceSlug,
  });
  return { confirmed: true, deleteIntentId: entry.deleteIntentId };
}

export function failWorkspaceDelete(event = {}) {
  const workspaceSlug = workspaceSlugFromEvent(event);
  if (!workspaceSlug) return null;
  const entry = pendingEntryFor(event);
  const errorCode = event.payload?.errorCode || "workspace_delete_failed";
  const error = new Error(errorCode);
  if (!entry) {
    showToast("Workspace could not be deleted!", "error", { clear: true });
    return { rolledBack: false, reason: "missing-pending-delete" };
  }
  entry.failureNotified = true;
  entry.deferred.reject(error);
  showToast("Workspace could not be deleted!", "error", { clear: true });
  return { rolledBack: true, deleteIntentId: entry.deleteIntentId };
}
