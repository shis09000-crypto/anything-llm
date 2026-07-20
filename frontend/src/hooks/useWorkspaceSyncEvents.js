import { useCallback, useEffect, useMemo, useRef } from "react";
import { getClientIdentity } from "@/lib/communication/clientIdentity";
import { useChatThreadDrafts } from "@/contexts/ChatThreadDraftProvider";
import { useSyncCenterEvents } from "@/hooks/useSyncCenterEvents";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import {
  dispatchThreadCreateVisual,
  dispatchThreadDeleteVisual,
  dispatchThreadPatchVisual,
  dispatchWorkspaceCreateVisual,
  dispatchWorkspaceDeleteVisual,
  dispatchWorkspacePatchVisual,
} from "@/utils/workspaceEvents";

const HISTORY_REFRESH_DEBOUNCE_MS = 220;

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
      workspaceName: payload.workspaceName || payload.name || null,
      userId: event.scope?.userId ?? null,
      threadId: event.scope?.threadId ?? null,
      threadSlug: payload.threadSlug || null,
      threadName: payload.threadName || payload.name || payload.title || null,
      threadType: payload.threadType || null,
      chatModel: payload.chatModel || null,
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
            if (event.workspaceSlug) {
              dispatchWorkspaceCreateVisual({
                workspace: {
                  id: event.workspaceId || event.workspaceSlug,
                  slug: event.workspaceSlug,
                  name: event.workspaceName || event.workspaceSlug,
                  createdAt: event.createdAt,
                  lastUpdatedAt: event.createdAt,
                },
                source: "sync-center",
                eventId: event.eventId,
              });
            }
            return;
          case "updated":
          case "workspace_updated":
            if (event.workspaceSlug) {
              workspaceNavigationCache.markWorkspaceDetailStale(
                event.workspaceSlug,
                "sync-center-workspace-soft-stale"
              );
              dispatchWorkspacePatchVisual({
                workspace: {
                  id: event.workspaceId || event.workspaceSlug,
                  slug: event.workspaceSlug,
                  ...(event.workspaceName ? { name: event.workspaceName } : {}),
                  lastUpdatedAt: event.createdAt,
                },
                source: "sync-center",
                eventId: event.eventId,
              });
            }
            return;
          case "deleted":
          case "workspace_deleted":
            if (event.workspaceSlug) {
              dispatchWorkspaceDeleteVisual({
                workspaceSlug: event.workspaceSlug,
                source: "sync-center",
                eventId: event.eventId,
              });
            }
            return;
          default:
            return;
        }
      }

      if (event.workspaceSlug !== workspaceSlug) return;

      switch (event.type) {
        case "thread_created":
          if (event.threadSlug) {
            dispatchThreadCreateVisual({
              workspaceSlug: event.workspaceSlug,
              thread: {
                id: event.threadId || event.threadSlug,
                slug: event.threadSlug,
                name: event.threadName || "新线程",
                title: event.threadName || "",
                thread_type: "chat",
                createdAt: event.createdAt,
                lastUpdatedAt: event.createdAt,
              },
              source: "sync-center",
              eventId: event.eventId,
            });
            return;
          }
          return;
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
          workspaceNavigationCache.markThreadsStale(
            event.workspaceSlug,
            "sync-center-thread"
          );
          if (event.threadSlug) {
            dispatchThreadPatchVisual({
              workspaceSlug: event.workspaceSlug,
              threadSlug: event.threadSlug,
              thread: {
                id: event.threadId || event.threadSlug,
                slug: event.threadSlug,
                ...(event.threadName ? { name: event.threadName } : {}),
                ...(event.threadName ? { title: event.threadName } : {}),
                ...(event.threadType ? { thread_type: event.threadType } : {}),
                ...(event.chatModel ? { chatModel: event.chatModel } : {}),
                lastUpdatedAt: event.createdAt,
              },
              source: "sync-center",
              eventId: event.eventId,
            });
            if (event.chatModel && typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("athena-thread-model-updated", {
                  detail: {
                    workspaceSlug: event.workspaceSlug,
                    threadSlug: event.threadSlug,
                    chatModel: event.chatModel,
                  },
                })
              );
            }
          }
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
          dispatchThreadDeleteVisual({
            workspaceSlug: event.workspaceSlug,
            threadSlug: event.threadSlug,
            source: "sync-center",
            eventId: event.eventId,
          });
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
          if (workspaceSlug) {
            dispatchWorkspaceCreateVisual({
              workspace: {
                id: event.scope?.workspaceId || workspaceSlug,
                slug: workspaceSlug,
                name: payload.workspaceName || workspaceSlug,
                createdAt: event.createdAt,
                lastUpdatedAt: event.createdAt,
              },
              source: "sync-center",
              eventId: event.eventId,
            });
          }
          return;
        case "updated":
        case "workspace_updated":
          if (workspaceSlug) {
            workspaceNavigationCache.markWorkspaceDetailStale(
              workspaceSlug,
              "sync-center-workspace-soft-stale"
            );
            dispatchWorkspacePatchVisual({
              workspace: {
                id: event.scope?.workspaceId || workspaceSlug,
                slug: workspaceSlug,
                ...(payload.workspaceName || payload.name
                  ? { name: payload.workspaceName || payload.name }
                  : {}),
                lastUpdatedAt: event.createdAt,
              },
              source: "sync-center",
              eventId: event.eventId,
            });
          }
          return;
        case "deleted":
        case "workspace_deleted":
          dispatchWorkspaceDeleteVisual({
            workspaceSlug,
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
      if (event.type === "created" || event.type === "thread_created") {
        dispatchThreadCreateVisual({
          workspaceSlug,
          thread: {
            id: event.scope?.threadId || payload.threadSlug,
            slug: payload.threadSlug,
            name: payload.threadName || payload.name || "新线程",
            title: payload.threadName || payload.name || "",
            thread_type: "chat",
            createdAt: event.createdAt,
            lastUpdatedAt: event.createdAt,
          },
          source: "sync-center",
          eventId: event.eventId,
        });
        return;
      }
      if (event.type === "deleted" || event.type === "thread_deleted") {
        dispatchThreadDeleteVisual({
          workspaceSlug,
          threadSlug: payload.threadSlug,
          source: "sync-center",
          eventId: event.eventId,
        });
        return;
      }
      workspaceNavigationCache.markThreadsStale(
        workspaceSlug,
        "sync-center-thread"
      );
      if (payload.threadSlug) {
        dispatchThreadPatchVisual({
          workspaceSlug,
          threadSlug: payload.threadSlug,
          thread: {
            id: event.scope?.threadId || payload.threadSlug,
            slug: payload.threadSlug,
            ...(payload.threadName || payload.name || payload.title
              ? {
                  name: payload.threadName || payload.name || payload.title,
                  title: payload.title || payload.threadName || payload.name,
                }
              : {}),
            ...(payload.threadType ? { thread_type: payload.threadType } : {}),
            lastUpdatedAt: event.createdAt,
          },
          source: "sync-center",
          eventId: event.eventId,
        });
      }
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
