import { getJsonSse } from "./streamClient";

const THREAD_TITLE_RETRY_MS = 3_000;
const WORKSPACE_SYNC_RETRY_MS = 2_000;
const SYNC_CENTER_RETRY_MS = 2_000;

export async function streamThreadTitleEvents({
  workspaceSlug,
  signal = null,
  onThreadRename = null,
  onError = null,
  onClose = null,
} = {}) {
  if (!workspaceSlug) return;

  await getJsonSse({
    path: `/workspace/${workspaceSlug}/thread-title-events`,
    signal,
    openWhenHidden: true,
    communicationScene: "workspace-navigation",
    onMessage(event) {
      if (event?.action !== "rename_thread" || !event?.thread) return;
      onThreadRename?.(event.thread);
    },
    onClose,
    retryOnError: true,
    onError(error) {
      if (signal?.aborted) return;
      onError?.(error);
      console.warn("[ThreadTitle] event stream error", error.message);
      return THREAD_TITLE_RETRY_MS;
    },
  });
}

export async function streamEmbeddingProgress({
  workspaceSlug,
  signal = null,
  onEvent = null,
  onError = null,
  onClose = null,
} = {}) {
  if (!workspaceSlug) return;

  await getJsonSse({
    path: `/workspace/${workspaceSlug}/embed-progress`,
    signal,
    openWhenHidden: true,
    communicationScene: "workspace-settings",
    onMessage(event, rawMessage) {
      onEvent?.(event, rawMessage);
    },
    onClose,
    onError(error) {
      onError?.(error);
    },
  });
}

export async function streamWorkspaceSyncEvents({
  workspaceSlug,
  signal = null,
  onEvent = null,
  onError = null,
  onClose = null,
} = {}) {
  if (!workspaceSlug) return;

  await getJsonSse({
    path: `/workspace/${workspaceSlug}/sync-events`,
    signal,
    openWhenHidden: true,
    communicationScene: "sync",
    onMessage(event, rawMessage) {
      if (
        event?.type === "heartbeat" ||
        event?.type === "workspace_sync_ready"
      ) {
        return;
      }
      onEvent?.(event, rawMessage);
    },
    onClose,
    retryOnError: true,
    onError(error) {
      if (signal?.aborted) return;
      onError?.(error);
      console.warn("[WorkspaceSync] event stream error", error.message);
      return WORKSPACE_SYNC_RETRY_MS;
    },
  });
}

export async function streamSyncCenterEvents({
  signal = null,
  onEvent = null,
  onError = null,
  onClose = null,
} = {}) {
  await getJsonSse({
    path: "/sync/events",
    signal,
    openWhenHidden: true,
    communicationScene: "sync",
    onMessage(event, rawMessage) {
      if (event?.type === "heartbeat" || event?.type === "sync_center_ready") {
        return;
      }
      onEvent?.(event, rawMessage);
    },
    onClose,
    retryOnError: true,
    onError(error) {
      if (signal?.aborted) return;
      onError?.(error);
      console.warn("[SyncCenter] event stream error", error.message);
      return SYNC_CENTER_RETRY_MS;
    },
  });
}
