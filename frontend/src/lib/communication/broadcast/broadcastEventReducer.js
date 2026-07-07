import { clearSigningSecretCache } from "../requestSigningClient";
import { getClientIdentity } from "../clientIdentity";
import { serverStateCache } from "@/utils/serverState/serverStateCache";
import { serverStateTaskBridge } from "@/utils/serverState/serverStateTaskBridge";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { recoveryCenter } from "@/utils/recovery/recoveryCenter";
import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";
import { sensitiveSessionCenter } from "@/utils/sensitive/sensitiveSessionCenter";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";
import {
  broadcastResourceKey,
  broadcastScopeSummary,
  normalizeBroadcastEvent,
} from "./broadcastEventSchema";

const EVENT_CACHE_LIMIT = 1_000;
const seenEventIds = new Set();
const versionByResource = new Map();
const counters = {
  received: 0,
  deduped: 0,
  staleDropped: 0,
  reduced: 0,
  critical: 0,
  invalidated: 0,
  optimisticConfirmed: 0,
  syncRequired: 0,
  errors: 0,
};
const recent = [];

function remember(eventId) {
  if (!eventId) return true;
  if (seenEventIds.has(eventId)) {
    counters.deduped += 1;
    return false;
  }
  seenEventIds.add(eventId);
  if (seenEventIds.size > EVENT_CACHE_LIMIT) {
    const oldest = seenEventIds.values().next().value;
    seenEventIds.delete(oldest);
  }
  return true;
}

function isStale(event) {
  if (event.broadcastType === "sync.required") return false;
  const key = broadcastResourceKey(event);
  const current = versionByResource.get(key) || 0;
  const next = Number(event.version || 0);
  if (next && current && next < current) return true;
  versionByResource.set(key, Math.max(current, next || Date.now()));
  return false;
}

function scopeForCache(event = {}) {
  return {
    ...(event.scope?.userId ? { userId: event.scope.userId } : {}),
    ...(event.payload?.workspaceSlug
      ? { workspaceSlug: event.payload.workspaceSlug }
      : {}),
    ...(event.scope?.workspaceSlug
      ? { workspaceSlug: event.scope.workspaceSlug }
      : {}),
    ...(event.payload?.threadSlug
      ? { threadSlug: event.payload.threadSlug }
      : {}),
    ...(event.scope?.threadSlug ? { threadSlug: event.scope.threadSlug } : {}),
    ...(event.scope?.readerDocumentId
      ? { readerDocumentId: event.scope.readerDocumentId }
      : {}),
    broadcastType: event.broadcastType,
  };
}

function invalidateScope(event, reason = "broadcast") {
  counters.invalidated += 1;
  return serverStateTaskBridge.invalidateScope(scopeForCache(event), reason);
}

function invalidateWorkspace(event) {
  const workspaceSlug =
    event.payload?.workspaceSlug || event.scope?.workspaceSlug;
  if (workspaceSlug) {
    workspaceNavigationCache.invalidateWorkspaceDetail(workspaceSlug);
    workspaceNavigationCache.invalidateThreads(workspaceSlug);
  }
  workspaceNavigationCache.invalidateWorkspaces();
  invalidateScope(event, "broadcast-workspace");
}

function invalidateThread(event) {
  counters.invalidated += 1;
  const workspaceSlug =
    event.payload?.workspaceSlug || event.scope?.workspaceSlug;
  if (workspaceSlug) {
    workspaceNavigationCache.markThreadsStale(
      workspaceSlug,
      "broadcast-thread"
    );
  }
  serverStateTaskBridge.markScopeStale(
    scopeForCache(event),
    "broadcast-thread"
  );
}

function invalidateReader(event) {
  const readerDocumentId =
    event.scope?.readerDocumentId ||
    event.payload?.readerDocumentId ||
    event.resource?.id;
  if (event.broadcastType?.startsWith?.("reader.library.")) {
    serverStateCache.invalidate("reader.library");
  }
  if (readerDocumentId) {
    serverStateCache.invalidateScope({ readerDocumentId });
  }
  invalidateScope(event, "broadcast-reader");
}

function invalidateUserState(event) {
  serverStateCache.invalidatePrefix("user-state:");
  invalidateScope(event, "broadcast-user-state");
}

function refreshUserProfile(event) {
  serverStateCache.invalidatePrefix("account.avatar:");
  serverStateCache.invalidatePrefix("account.profile:");
  invalidateScope(event, "broadcast-user-profile");
  if (typeof window === "undefined") return { action: "user-profile-refresh" };
  window.dispatchEvent(
    new CustomEvent("athena-user-profile-refresh", {
      detail: {
        eventId: event.eventId,
        userId: event.scope?.userId || null,
        changedFields: Array.isArray(event.payload?.changedFields)
          ? event.payload.changedFields
          : [],
        reason: event.payload?.reason || "profile-updated",
        sourceClientId: event.sourceClientId || null,
        sourceActionId: event.sourceActionId || null,
      },
    })
  );
  return { action: "user-profile-refresh" };
}

function dispatchDeveloperReaderCommand(event) {
  if (typeof window === "undefined") return { action: "dev-reader-ignored" };
  window.dispatchEvent(
    new CustomEvent("athena-dev-control-reader-command", {
      detail: {
        ...(event.payload || {}),
        eventId: event.eventId,
        scope: event.payload?.scope || event.scope || {},
        sourceRequestId: event.sourceRequestId || event.payload?.requestId,
      },
    })
  );
  return { action: "dev-reader-dispatch" };
}

function dispatchDeveloperNavigationCommand(event) {
  if (typeof window === "undefined")
    return { action: "dev-navigation-ignored" };
  window.dispatchEvent(
    new CustomEvent("athena-dev-control-navigation-command", {
      detail: {
        ...(event.payload || {}),
        eventId: event.eventId,
        scope: event.payload?.scope || event.scope || {},
        sourceRequestId: event.sourceRequestId || event.payload?.requestId,
      },
    })
  );
  return { action: "dev-navigation-dispatch" };
}

function handleCritical(event) {
  counters.critical += 1;
  switch (event.broadcastType) {
    case "client.revoked": {
      const currentClientId = getClientIdentity().clientId;
      const targetClientId = event.scope?.clientId || event.payload?.clientId;
      const excludedClientId = event.payload?.excludedClientId || null;
      if (
        targetClientId === currentClientId ||
        (!targetClientId &&
          event.payload?.revokedAllOthers &&
          excludedClientId !== currentClientId)
      ) {
        clearSensitiveClientSession({ includeDurableCaches: true });
      }
      return;
    }
    case "signingSecret.rotated":
      clearSigningSecretCache(event.scope?.clientId || event.payload?.clientId);
      return;
    case "sensitiveSession.revoked":
      sensitiveSessionCenter.clearScope?.({
        resourceType: event.payload?.resourceType,
        resourceId: event.payload?.resourceId,
        ownerScope: event.payload?.ownerScope,
      });
      return;
    default:
      return;
  }
}

function confirmOptimistic(event) {
  if (!event.sourceActionId) return;
  const result = optimisticActionCenter.confirmFromBroadcast?.({
    actionId: event.sourceActionId,
    event,
  });
  if (result?.confirmed) counters.optimisticConfirmed += 1;
}

function reduceNormalized(event) {
  confirmOptimistic(event);
  if (event.eventPriority === "critical") handleCritical(event);

  switch (event.broadcastType) {
    case "sync.required":
      counters.syncRequired += 1;
      invalidateScope(event, "broadcast-sync-required");
      return { action: "sync-required" };
    case "workspace.created":
    case "workspace.updated":
    case "workspace.deleted":
      invalidateWorkspace(event);
      return { action: "workspace-invalidate" };
    case "thread.created":
    case "thread.updated":
    case "thread.renamed":
    case "thread.deleted":
    case "thread.moved":
      invalidateThread(event);
      return { action: "thread-invalidate" };
    case "chat.finalized":
    case "chat.updated":
    case "chat.deleted":
      invalidateThread(event);
      return { action: "chat-invalidate" };
    case "reader.document.added":
    case "reader.document.removed":
    case "reader.library.bootstrapped":
    case "reader.library.updated":
    case "reader.library.item.updated":
    case "reader.library.item.deleted":
    case "reader.library.category.updated":
    case "reader.library.category.deleted":
    case "reader.library.reconciled":
    case "reader.postprocess.completed":
    case "reader.thumbnail.ready":
    case "reader.classification.ready":
      invalidateReader(event);
      return { action: "reader-invalidate" };
    case "developerControl.readerCommand":
      return dispatchDeveloperReaderCommand(event);
    case "developerControl.navigationCommand":
      return dispatchDeveloperNavigationCommand(event);
    case "userState.updated":
    case "userState.deleted":
      invalidateUserState(event);
      return { action: "user-state-invalidate" };
    case "user.profile.updated":
      return refreshUserProfile(event);
    case "settings.updated":
      invalidateScope(event, "broadcast-settings");
      return { action: "settings-invalidate" };
    default:
      return { action: "ignored" };
  }
}

export const broadcastEventReducer = {
  reduce(rawEvent = {}) {
    const event = normalizeBroadcastEvent(rawEvent);
    if (!event) return { ok: false, reason: "invalid-event" };
    counters.received += 1;
    if (!remember(event.eventId)) return { ok: true, deduped: true };
    if (isStale(event)) {
      counters.staleDropped += 1;
      return { ok: true, stale: true };
    }

    try {
      const result = reduceNormalized(event);
      counters.reduced += 1;
      recent.push({
        eventId: event.eventId,
        type: event.broadcastType,
        priority: event.eventPriority,
        scope: broadcastScopeSummary(event.scope),
        action: result.action,
        at: Date.now(),
      });
      if (recent.length > 80) recent.splice(0, recent.length - 80);
      return { ok: true, event, ...result };
    } catch (error) {
      counters.errors += 1;
      recoveryCenter.handle(error, {
        source: "broadcast",
        scope: scopeForCache(event),
        requestId: event.sourceRequestId,
      });
      return { ok: false, error };
    }
  },

  snapshot() {
    return {
      counters: { ...counters },
      seen: seenEventIds.size,
      versionGuards: versionByResource.size,
      recent: [...recent],
    };
  },
};

export default broadcastEventReducer;
