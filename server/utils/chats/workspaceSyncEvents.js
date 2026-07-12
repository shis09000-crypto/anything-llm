const { publishSyncEvent, subscribeToSyncEvents } = require("../syncCenter");

function normalizeUserId(userId = null) {
  if (userId === null || userId === undefined || userId === "") return null;
  const parsed = Number(userId);
  return Number.isFinite(parsed) ? parsed : null;
}

function workspaceTypeToSyncType(type = "") {
  switch (type) {
    case "chat_prompt_submitted":
      return { namespace: "chat", type: "prompt_submitted", kind: "chat" };
    case "chat_finalized":
      return { namespace: "chat", type: "finalized", kind: "chat" };
    case "chat_updated":
      return { namespace: "chat", type: "updated", kind: "chat" };
    case "chat_deleted":
      return { namespace: "chat", type: "deleted", kind: "chat" };
    case "chat_failed":
      return { namespace: "chat", type: "failed", kind: "chat" };
    case "thread_created":
      return { namespace: "thread", type: "created", kind: "thread" };
    case "thread_updated":
      return { namespace: "thread", type: "updated", kind: "thread" };
    case "thread_deleted":
      return { namespace: "thread", type: "deleted", kind: "thread" };
    case "workspace_created":
      return { namespace: "workspace", type: "created", kind: "workspace" };
    case "workspace_updated":
      return { namespace: "workspace", type: "updated", kind: "workspace" };
    case "workspace_deleted":
      return { namespace: "workspace", type: "deleted", kind: "workspace" };
    case "workspace_delete_requested":
      return {
        namespace: "workspace",
        type: "delete.requested",
        kind: "workspace",
      };
    case "workspace_delete_failed":
      return {
        namespace: "workspace",
        type: "delete.failed",
        kind: "workspace",
      };
    case "agent_intervention_requested":
      return {
        namespace: "chat",
        type: "agent_intervention_requested",
        kind: "chat",
      };
    case "agent_intervention_resolved":
      return {
        namespace: "chat",
        type: "agent_intervention_resolved",
        kind: "chat",
      };
    default:
      return { namespace: "workspace", type, kind: "workspace" };
  }
}

function syncTypeToWorkspaceType(event = {}) {
  const signature = `${event.namespace}.${event.type}`;
  switch (signature) {
    case "chat.prompt_submitted":
      return "chat_prompt_submitted";
    case "chat.finalized":
      return "chat_finalized";
    case "chat.updated":
      return "chat_updated";
    case "chat.deleted":
      return "chat_deleted";
    case "chat.failed":
      return "chat_failed";
    case "thread.created":
      return "thread_created";
    case "thread.updated":
      return "thread_updated";
    case "thread.deleted":
      return "thread_deleted";
    case "workspace.created":
      return "workspace_created";
    case "workspace.updated":
      return "workspace_updated";
    case "workspace.deleted":
      return "workspace_deleted";
    case "workspace.delete.requested":
      return "workspace_delete_requested";
    case "workspace.delete.failed":
      return "workspace_delete_failed";
    case "chat.agent_intervention_requested":
      return "agent_intervention_requested";
    case "chat.agent_intervention_resolved":
      return "agent_intervention_resolved";
    default:
      return event.type;
  }
}

function workspaceEventFromSyncEvent(event = {}) {
  const payload = event.payload || {};
  return {
    eventId: event.eventId,
    type: syncTypeToWorkspaceType(event),
    workspaceId: event.scope?.workspaceId ?? null,
    workspaceSlug: payload.workspaceSlug || null,
    workspaceName: payload.workspaceName || null,
    userId: event.scope?.userId ?? null,
    threadId: event.scope?.threadId ?? null,
    threadSlug: payload.threadSlug || null,
    threadName: payload.threadName || payload.title || null,
    threadType: payload.threadType || null,
    chatModel: payload.chatModel || null,
    deleteIntentId: payload.deleteIntentId || null,
    chatId: event.resource?.kind === "chat" ? event.resource?.id ?? null : null,
    publicChatId: event.resource?.publicId ?? null,
    senderClientId: event.origin?.clientId || null,
    clientTurnId: payload.clientTurnId || null,
    startingChatId: payload.startingChatId || null,
    targetChatId: payload.targetChatId || null,
    mutationKind: payload.mutationKind || null,
    historyRevision: payload.historyRevision ?? null,
    historyFingerprint: payload.historyFingerprint || null,
    message: payload.message || null,
    error: payload.error || null,
    createdAt: event.createdAt,
  };
}

function visibilityForWorkspaceEvent(mapped = {}) {
  if (mapped.namespace === "thread") return "workspace";
  if (mapped.namespace === "workspace") return "workspace";
  return undefined;
}

function publishWorkspaceSyncEvent(event = {}, options = {}) {
  if (!event?.workspaceId || !event?.workspaceSlug || !event?.type) return null;

  const mapped = workspaceTypeToSyncType(event.type);
  const payload = publishSyncEvent(
    {
      eventId: event.eventId,
      namespace: mapped.namespace,
      type: mapped.type,
      scope: {
        userId: normalizeUserId(event.userId),
        workspaceId: Number(event.workspaceId),
        threadId:
          event.threadId === null || event.threadId === undefined
            ? null
            : Number(event.threadId),
      },
      resource: {
        kind: mapped.kind,
        id: event.chatId || event.threadId || event.workspaceId || null,
        publicId: event.publicChatId || null,
      },
      visibility: visibilityForWorkspaceEvent(mapped),
      origin: {
        clientId: event.senderClientId || null,
        requestId: event.requestId || null,
        actionId: event.sourceActionId || null,
      },
      payload: {
        workspaceSlug: String(event.workspaceSlug),
        workspaceName: event.workspaceName || null,
        threadSlug: event.threadSlug || null,
        threadName: event.threadName || null,
        title: event.title || event.threadName || null,
        threadType: event.threadType || null,
        chatModel: event.chatModel || null,
        deleteIntentId: event.deleteIntentId || null,
        clientTurnId: event.clientTurnId || null,
        startingChatId: event.startingChatId || null,
        targetChatId: event.targetChatId || null,
        mutationKind: event.mutationKind || null,
        historyRevision: event.historyRevision ?? null,
        historyFingerprint: event.historyFingerprint || null,
        hasMessage: !!event.message,
        error: event.error || null,
      },
      createdAt: event.createdAt,
    },
    options
  );

  return payload ? workspaceEventFromSyncEvent(payload) : null;
}

function subscribeToWorkspaceSyncEvents(handler) {
  return subscribeToSyncEvents((event) => {
    const workspaceEvent = workspaceEventFromSyncEvent(event);
    if (!workspaceEvent.workspaceId || !workspaceEvent.workspaceSlug) return;
    handler(workspaceEvent);
  });
}

module.exports = {
  publishWorkspaceSyncEvent,
  subscribeToWorkspaceSyncEvents,
  workspaceEventFromSyncEvent,
  _internals: {
    syncTypeToWorkspaceType,
    workspaceTypeToSyncType,
  },
};
