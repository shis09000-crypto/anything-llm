import { ABORT_STREAM_EVENT, dispatchThreadRename } from "@/utils/chat";
import { v4 } from "uuid";
import { postJsonSse } from "./streamClient";
import {
  normalizeChatStreamEvent,
  normalizeChatTurnEvent,
} from "./chatStreamProtocol";

function chatStreamBody({ message, attachments, fileAccessMode, nodeContext }) {
  return {
    message,
    attachments,
    fileAccess: { mode: fileAccessMode },
    nodeContext,
  };
}

function abortRawEvent() {
  return { id: v4(), type: "stopGeneration" };
}

function errorRawEvent(error) {
  return {
    id: v4(),
    type: "abort",
    textResponse: null,
    sources: [],
    close: true,
    error:
      error?.message ||
      error?.details?.message ||
      "An error occurred while streaming response. Unknown Error.",
    apiError: error,
  };
}

async function streamChat({
  path,
  body,
  signal = null,
  onRawEvent,
  onProtocolEvent,
  onEvent,
  onError,
  onClose,
} = {}) {
  const ctrl = new AbortController();
  let stopped = false;
  let emittedStop = false;
  let emittedError = false;

  const emitRaw = (raw) => {
    if (raw?.action === "rename_thread") dispatchThreadRename(raw.thread);
    onRawEvent?.(raw);
    const protocolEvent = normalizeChatStreamEvent(raw);
    onProtocolEvent?.(protocolEvent, raw);
    onEvent?.(normalizeChatTurnEvent(raw), protocolEvent, raw);
  };

  const emitStop = () => {
    if (emittedStop) return;
    emittedStop = true;
    emitRaw(abortRawEvent());
  };

  const emitError = (error) => {
    if (stopped || emittedStop || emittedError) return;
    emittedError = true;
    const raw = errorRawEvent(error);
    onError?.(error, raw);
    emitRaw(raw);
  };

  const abortStream = () => {
    stopped = true;
    ctrl.abort();
    emitStop();
  };

  const externalAbort = () => {
    stopped = true;
    ctrl.abort();
  };

  signal?.addEventListener?.("abort", externalAbort, { once: true });
  window.addEventListener(ABORT_STREAM_EVENT, abortStream);

  try {
    await postJsonSse({
      path,
      body,
      signal: ctrl.signal,
      onMessage(raw) {
        if (stopped) return;
        emitRaw(raw);
      },
      onError(error) {
        emitError(error);
      },
      onClose() {
        onClose?.();
      },
    });
  } catch (error) {
    if (!stopped && !ctrl.signal.aborted) emitError(error);
  } finally {
    window.removeEventListener(ABORT_STREAM_EVENT, abortStream);
    signal?.removeEventListener?.("abort", externalAbort);
  }
}

export async function streamWorkspaceChat({
  workspaceSlug,
  body,
  signal,
  onRawEvent,
  onProtocolEvent,
  onEvent,
  onError,
  onClose,
}) {
  return streamChat({
    path: `/workspace/${workspaceSlug}/stream-chat`,
    body,
    signal,
    onRawEvent,
    onProtocolEvent,
    onEvent,
    onError,
    onClose,
  });
}

export async function streamWorkspaceThreadChat({
  workspaceSlug,
  threadSlug,
  body,
  signal,
  onRawEvent,
  onProtocolEvent,
  onEvent,
  onError,
  onClose,
}) {
  return streamChat({
    path: `/workspace/${workspaceSlug}/thread/${threadSlug}/stream-chat`,
    body,
    signal,
    onRawEvent,
    onProtocolEvent,
    onEvent,
    onError,
    onClose,
  });
}

export function buildChatStreamBody({
  message,
  attachments = [],
  fileAccessMode = null,
  nodeContext = null,
}) {
  return chatStreamBody({ message, attachments, fileAccessMode, nodeContext });
}
