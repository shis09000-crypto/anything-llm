import { getJsonSse } from "./streamClient";

const THREAD_TITLE_RETRY_MS = 3_000;

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
    onMessage(event, rawMessage) {
      onEvent?.(event, rawMessage);
    },
    onClose,
    onError(error) {
      onError?.(error);
    },
  });
}
