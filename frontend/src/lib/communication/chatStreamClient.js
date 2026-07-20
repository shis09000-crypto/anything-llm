import { ABORT_STREAM_EVENT, dispatchThreadRename } from "@/utils/chat";
import { v4 } from "uuid";
import { postJsonSse } from "./streamClient";
import {
  normalizeChatStreamEvent,
  normalizeChatTurnEvent,
} from "./chatStreamProtocol";
import { preuploadLargeChatAttachments } from "./chatAttachmentClient";

function chatStreamBody({
  message,
  displayPrompt = null,
  attachments,
  fileAccessMode,
  nodeContext,
  clientTurnId,
  editContext = null,
  regenerateContext = null,
}) {
  return {
    message,
    displayPrompt,
    attachments,
    fileAccess: { mode: fileAccessMode },
    nodeContext,
    clientTurnId,
    ...(editContext ? { editContext } : {}),
    ...(regenerateContext ? { regenerateContext } : {}),
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
  workspaceSlug = null,
  threadSlug = null,
  onRawEvent,
  onProtocolEvent,
  onEvent,
  onOpen,
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
    const requestBody = {
      ...body,
      attachments: await preuploadLargeChatAttachments(
        workspaceSlug,
        body?.attachments || [],
        { signal: ctrl.signal }
      ),
    };
    await postJsonSse({
      path,
      body: requestBody,
      signal: ctrl.signal,
      communicationScene: "workspace-chat",
      task: {
        kind: "chat-stream",
        label: "chat:stream",
        priority: "P0",
        policy: "realtime",
        resource: "realtime",
        protected: true,
        abortable: false,
        scope: {
          route: "workspace-chat",
          surface: "chat-stream",
          workspaceSlug,
          ...(threadSlug ? { threadSlug } : {}),
        },
      },
      onOpen,
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
  onOpen,
  onError,
  onClose,
}) {
  return streamChat({
    path: `/workspace/${workspaceSlug}/stream-chat`,
    body,
    signal,
    workspaceSlug,
    onRawEvent,
    onProtocolEvent,
    onEvent,
    onOpen,
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
  onOpen,
  onError,
  onClose,
}) {
  return streamChat({
    path: `/workspace/${workspaceSlug}/thread/${threadSlug}/stream-chat`,
    body,
    signal,
    workspaceSlug,
    threadSlug,
    onRawEvent,
    onProtocolEvent,
    onEvent,
    onOpen,
    onError,
    onClose,
  });
}

export function buildChatStreamBody({
  message,
  displayPrompt = null,
  attachments = [],
  fileAccessMode = null,
  nodeContext = null,
  clientTurnId = null,
  editContext = null,
  regenerateContext = null,
}) {
  return chatStreamBody({
    message,
    displayPrompt,
    attachments,
    fileAccessMode,
    nodeContext,
    clientTurnId,
    editContext,
    regenerateContext,
  });
}
