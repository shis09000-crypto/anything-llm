import { useCallback, useEffect, useMemo, useRef } from "react";
import { getClientIdentity } from "@/lib/communication";
import { useChatThreadDrafts } from "@/contexts/ChatThreadDraftProvider";
import { useSyncCenterEvents } from "@/hooks/useSyncCenterEvents";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { dispatchWorkspacesRefresh } from "@/utils/workspaceEvents";
import { recordCommunicationEvent } from "@/lib/communication/communicationMetrics";

const WORKSPACE_THREADS_REFRESH_EVENT = "workspaceThreadsRefresh";
const HISTORY_REFRESH_DEBOUNCE_MS = 220;
const THREADS_REFRESH_DEDUP_MS = 900;
const recentThreadsRefreshes = new Map();

function sameThread(left = null, right = null) {
  return (left || null) === (right || null);
}

function eventCreatedAtMs(event = {}) {
  const value = event?.createdAt ? Date.parse(event.createdAt) : NaN;
  return Number.isFinite(value) ? value : Date.now();
}

function isOlderThan(updatedAt = 0, event = {}) {
  if (!updatedAt) return false;
  return eventCreatedAtMs(event) <= updatedAt;
}

function dispatchWorkspaceThreadsRefresh(workspaceSlug, detail = {}) {
  if (!workspaceSlug || typeof window === "undefined") return;
  const key = [
    workspaceSlug,
    detail.threadSlug || "__workspace__",
    detail.eventId || detail.createdAt || "__no_event__",
    detail.reason || "refresh",
  ].join(":");
  const now = Date.now();
  const lastAt = recentThreadsRefreshes.get(key) || 0;
  if (now - lastAt < THREADS_REFRESH_DEDUP_MS) return;
  recentThreadsRefreshes.set(key, now);
  if (recentThreadsRefreshes.size > 100) {
    for (const [entryKey, entryAt] of recentThreadsRefreshes) {
      if (now - entryAt > THREADS_REFRESH_DEDUP_MS) {
        recentThreadsRefreshes.delete(entryKey);
      }
    }
  }
  recordCommunicationEvent({
    type: "workspace-threads-refresh-dispatch",
    method: "EVENT",
    path: WORKSPACE_THREADS_REFRESH_EVENT,
    communicationScene: "workspace-navigation",
    durationMs: 0,
    requestBytes: 0,
    responseBytes: 0,
    ok: true,
    workspaceSlug,
    threadSlug: detail.threadSlug || null,
    reason: detail.reason || "refresh",
    source: detail.source || null,
    eventId: detail.eventId || null,
  });
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_THREADS_REFRESH_EVENT, {
      detail: { workspaceSlug, ...detail },
    })
  );
}

export function useWorkspaceSyncEvents({
  workspaceSlug,
  activeThreadSlug = null,
  enabled = true,
  onThreadDeleted = null,
} = {}) {
  const chatDrafts = useChatThreadDrafts();
  const clientId = useMemo(() => getClientIdentity().clientId, []);
  const refreshTimersRef = useRef(new Map());

  const scheduleHistoryRefresh = useCallback(
    ({ threadSlug = null, reason = "workspace-sync" } = {}) => {
      if (!workspaceSlug) return;
      const key = `${workspaceSlug}:${threadSlug || "__workspace__"}`;
      const existing = refreshTimersRef.current.get(key);
      if (existing) window.clearTimeout(existing);

      const timer = window.setTimeout(() => {
        refreshTimersRef.current.delete(key);
        chatDrafts.refreshLatestHistory?.({
          workspaceSlug,
          threadSlug,
          reason,
          limit: 40,
        });
      }, HISTORY_REFRESH_DEBOUNCE_MS);
      refreshTimersRef.current.set(key, timer);
    },
    [chatDrafts, workspaceSlug]
  );

  const handlePromptSubmitted = useCallback(
    (event) => {
      const threadSlug = event.threadSlug || null;

      if (event.senderClientId === clientId) return;
      if (!sameThread(threadSlug, activeThreadSlug)) return;
      if (!event.message) return;

      chatDrafts.startLocalTurn({
        workspaceSlug: event.workspaceSlug,
        threadSlug,
        prompt: event.message,
        turnId: event.clientTurnId || undefined,
      });
    },
    [activeThreadSlug, chatDrafts, clientId]
  );

  const handleChatFinished = useCallback(
    (event) => {
      const threadSlug = event.threadSlug || null;
      if (sameThread(threadSlug, activeThreadSlug)) {
        scheduleHistoryRefresh({
          threadSlug,
          reason: `workspace-sync:${event.type}`,
        });
      }
    },
    [activeThreadSlug, scheduleHistoryRefresh]
  );

  const handleChatFailed = useCallback(
    (event) => {
      const threadSlug = event.threadSlug || null;
      if (!sameThread(threadSlug, activeThreadSlug) || !event.clientTurnId)
        return;

      const chatKey = chatDrafts.getChatKey(event.workspaceSlug, threadSlug);
      chatDrafts.failAssistantTurn(
        chatKey,
        event.clientTurnId,
        event.error || "Chat failed."
      );
    },
    [activeThreadSlug, chatDrafts]
  );

  const workspaceEventFromSyncEvent = useCallback((event = {}) => {
    const payload = event.payload || {};
    const type =
      event.namespace === "chat"
        ? event.type.startsWith("agent_")
          ? event.type
          : `chat_${event.type}`
        : event.namespace === "thread"
          ? `thread_${event.type}`
          : event.type;
    return {
      eventId: event.eventId,
      namespace: event.namespace || null,
      type,
      workspaceId: event.scope?.workspaceId ?? null,
      workspaceSlug: payload.workspaceSlug || null,
      userId: event.scope?.userId ?? null,
      threadId: event.scope?.threadId ?? null,
      threadSlug: payload.threadSlug || null,
      chatId: event.resource?.kind === "chat" ? event.resource?.id : null,
      publicChatId: event.resource?.publicId || null,
      senderClientId: event.origin?.clientId || null,
      clientTurnId: payload.clientTurnId || null,
      message: payload.message || null,
      error: payload.error || null,
      createdAt: event.createdAt,
    };
  }, []);

  const handleWorkspaceEvent = useCallback(
    (event) => {
      event = workspaceEventFromSyncEvent(event);
      if (!event?.type) return;

      if (event.namespace === "workspace") {
        const workspacesMeta = workspaceNavigationCache.getWorkspacesMeta();
        if (isOlderThan(workspacesMeta.updatedAt, event)) return;
        switch (event.type) {
          case "created":
          case "workspace_created":
            return;
          case "updated":
          case "workspace_updated":
            if (event.workspaceSlug) {
              workspaceNavigationCache.invalidateWorkspaceDetail(
                event.workspaceSlug
              );
            }
            return;
          case "deleted":
          case "workspace_deleted":
            if (event.workspaceSlug) {
              workspaceNavigationCache.invalidateWorkspaceDetail(
                event.workspaceSlug
              );
              workspaceNavigationCache.invalidateThreads(event.workspaceSlug);
            }
            return;
          default:
            return;
        }
      }

      if (event.workspaceSlug !== workspaceSlug) return;

      switch (event.type) {
        case "thread_created":
        case "thread_updated":
          if (
            isOlderThan(
              workspaceNavigationCache.getThreadsMeta(event.workspaceSlug)
                .updatedAt,
              event
            )
          ) {
            return;
          }
          workspaceNavigationCache.invalidateThreads(event.workspaceSlug);
          return;
        case "thread_deleted":
          if (
            isOlderThan(
              workspaceNavigationCache.getThreadsMeta(event.workspaceSlug)
                .updatedAt,
              event
            )
          ) {
            return;
          }
          workspaceNavigationCache.invalidateThreads(event.workspaceSlug);
          if (sameThread(event.threadSlug, activeThreadSlug)) {
            onThreadDeleted?.(event);
          }
          return;
        case "chat_prompt_submitted":
          handlePromptSubmitted(event);
          return;
        case "chat_finalized":
        case "chat_updated":
        case "chat_deleted":
        case "agent_intervention_requested":
        case "agent_intervention_resolved":
          handleChatFinished(event);
          return;
        case "chat_failed":
          handleChatFailed(event);
          return;
        default:
          return;
      }
    },
    [
      activeThreadSlug,
      handleChatFailed,
      handleChatFinished,
      handlePromptSubmitted,
      onThreadDeleted,
      workspaceSlug,
      workspaceEventFromSyncEvent,
    ]
  );

  const syncHandlers = useMemo(
    () => ({
      "chat.*": handleWorkspaceEvent,
      "thread.*": handleWorkspaceEvent,
      "workspace.*": handleWorkspaceEvent,
    }),
    [handleWorkspaceEvent]
  );

  useSyncCenterEvents({
    handlers: syncHandlers,
    enabled: enabled && !!workspaceSlug,
  });

  useEffect(() => {
    return () => {
      refreshTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      refreshTimersRef.current.clear();
    };
  }, []);
}

export function useWorkspaceNavigationSyncInvalidation({
  enabled = true,
} = {}) {
  const handleNavigationEvent = useCallback((event = {}) => {
    const payload = event.payload || {};
    const workspaceSlug = payload.workspaceSlug || null;
    const isWorkspaceEvent = event.namespace === "workspace";
    const isThreadEvent = event.namespace === "thread";

    if (isWorkspaceEvent) {
      const workspacesMeta = workspaceNavigationCache.getWorkspacesMeta();
      if (isOlderThan(workspacesMeta.updatedAt, event)) return;
      switch (event.type) {
        case "created":
        case "workspace_created":
          dispatchWorkspacesRefresh(null, {
            force: true,
            source: "sync-center",
            createdAt: event.createdAt,
            eventId: event.eventId,
          });
          return;
        case "updated":
        case "workspace_updated":
          if (workspaceSlug) {
            workspaceNavigationCache.invalidateWorkspaceDetail(workspaceSlug);
          }
          dispatchWorkspacesRefresh(null, {
            force: true,
            source: "sync-center",
            createdAt: event.createdAt,
            eventId: event.eventId,
          });
          return;
        case "deleted":
        case "workspace_deleted":
          if (workspaceSlug) {
            workspaceNavigationCache.invalidateWorkspaceDetail(workspaceSlug);
            workspaceNavigationCache.invalidateThreads(workspaceSlug);
          }
          dispatchWorkspacesRefresh(null, {
            force: true,
            source: "sync-center",
            createdAt: event.createdAt,
            eventId: event.eventId,
          });
          return;
        default:
          return;
      }
    }

    if (isThreadEvent && workspaceSlug) {
      const threadsMeta =
        workspaceNavigationCache.getThreadsMeta(workspaceSlug);
      if (isOlderThan(threadsMeta.updatedAt, event)) return;
      workspaceNavigationCache.invalidateThreads(workspaceSlug);
      dispatchWorkspaceThreadsRefresh(workspaceSlug, {
        force: false,
        source: "sync-center",
        createdAt: event.createdAt,
        eventId: event.eventId,
        threadSlug: payload.threadSlug || null,
        reason: event.type || "thread",
      });
    }
  }, []);

  const syncHandlers = useMemo(
    () => ({
      "thread.*": handleNavigationEvent,
      "workspace.*": handleNavigationEvent,
    }),
    [handleNavigationEvent]
  );

  useSyncCenterEvents({
    handlers: syncHandlers,
    enabled,
  });
}
