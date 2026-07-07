export const CHAT_SECONDARY_PRELOAD_EVENT = "athena-chat-secondary-ready";

export function chatSecondaryTask(label, scope = {}) {
  return {
    label,
    kind: "chat-secondary",
    priority: "P0",
    policy: "foreground",
    intentRank: 3,
    resource: "network",
    scope: {
      route: "workspace-chat",
      surface: "chat-secondary",
      ...scope,
    },
  };
}

export function dispatchChatSecondaryPreload(detail = {}) {
  if (typeof window === "undefined") return;
  try {
    if (typeof performance !== "undefined") {
      performance.mark?.("athena:chat_secondary_preload_started");
    }
  } catch {}
  window.dispatchEvent(
    new CustomEvent(CHAT_SECONDARY_PRELOAD_EVENT, { detail })
  );
}
