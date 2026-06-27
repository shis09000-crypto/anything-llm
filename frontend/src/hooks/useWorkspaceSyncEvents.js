import { useCallback, useEffect, useMemo, useRef } from "react";
import { getClientIdentity } from "@/lib/communication";
import { useChatThreadDrafts } from "@/contexts/ChatThreadDraftProvider";
import { useSyncCenterEvents } from "@/hooks/useSyncCenterEvents";

const WORKSPACE_THREADS_REFRESH_EVENT = "workspaceThreadsRefresh";
const HISTORY_REFRESH_DEBOUNCE_MS = 220;

function sameThread(left = null, right = null) {
  return (left || null) === (right || null);
}

function dispatchWorkspaceThreadsRefresh(workspaceSlug) {
  if (!workspaceSlug || typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_THREADS_REFRESH_EVENT, {
      detail: { workspaceSlug },
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
      dispatchWorkspaceThreadsRefresh(event.workspaceSlug);

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
      dispatchWorkspaceThreadsRefresh(event.workspaceSlug);
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
      dispatchWorkspaceThreadsRefresh(event.workspaceSlug);
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
      if (!event?.type || event.workspaceSlug !== workspaceSlug) return;

      switch (event.type) {
        case "thread_created":
        case "thread_updated":
          dispatchWorkspaceThreadsRefresh(event.workspaceSlug);
          return;
        case "thread_deleted":
          dispatchWorkspaceThreadsRefresh(event.workspaceSlug);
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
