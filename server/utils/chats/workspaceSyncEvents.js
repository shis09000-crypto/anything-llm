const {
  publishSyncEvent,
  subscribeToSyncEvents,
} = require("../syncCenter");

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
    userId: event.scope?.userId ?? null,
    threadId: event.scope?.threadId ?? null,
    threadSlug: payload.threadSlug || null,
    chatId: event.resource?.kind === "chat" ? event.resource?.id ?? null : null,
    publicChatId: event.resource?.publicId ?? null,
    senderClientId: event.origin?.clientId || null,
    clientTurnId: payload.clientTurnId || null,
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

function publishWorkspaceSyncEvent(event = {}) {
  if (!event?.workspaceId || !event?.workspaceSlug || !event?.type) return null;

  const mapped = workspaceTypeToSyncType(event.type);
  const payload = publishSyncEvent({
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
    },
    payload: {
      workspaceSlug: String(event.workspaceSlug),
      threadSlug: event.threadSlug || null,
      clientTurnId: event.clientTurnId || null,
      hasMessage: !!event.message,
      error: event.error || null,
    },
    createdAt: event.createdAt,
  });

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
