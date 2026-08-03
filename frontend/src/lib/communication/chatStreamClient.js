import { ABORT_STREAM_EVENT, dispatchThreadRename } from "@/utils/chat";
import { v4 } from "uuid";
import { postJson } from "./apiClient";
import { getJsonSse, postJsonSse } from "./streamClient";
import {
  normalizeChatStreamEvent,
  normalizeChatTurnEvent,
} from "./chatStreamProtocol";
import { preuploadLargeChatAttachments } from "./chatAttachmentClient";
import {
  beginChatStreamObservation,
  endChatStreamObservation,
  recordChatStreamReconnect,
  recordChatStreamRevision,
  updateChatStreamObservationRequestId,
} from "./chatStreamObservability";

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

function connectionRawEvent(state) {
  return {
    id: v4(),
    type: "streamReconnectState",
    state,
    close: false,
  };
}

export function shouldReconnectInitialChatPost(error) {
  const status = Number(error?.status || error?.raw?.status || 0);
  if (!status) return true;
  if (status >= 500 || [408, 409, 425, 429].includes(status)) return true;
  return false;
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
  let terminalSeen = false;
  let lastRevision = 0;
  let reconnectAttempt = 0;
  const clientTurnId = String(body?.clientTurnId || "").trim();
  const encodedTurnId = encodeURIComponent(clientTurnId);
  const runPath = threadSlug
    ? `/workspace/${workspaceSlug}/thread/${threadSlug}/chat-runs/${encodedTurnId}`
    : `/workspace/${workspaceSlug}/chat-runs/${encodedTurnId}`;
  beginChatStreamObservation(clientTurnId);

  const emitRaw = (raw) => {
    if (Number.isFinite(Number(raw?.runRevision))) {
      lastRevision = Math.max(lastRevision, Number(raw.runRevision));
      if (["textResponseChunk", "fullTextResponse"].includes(raw?.type)) {
        recordChatStreamRevision(clientTurnId, lastRevision);
      }
    }
    if (
      raw?.close === true ||
      ["abort", "stopGeneration"].includes(raw?.type)
    ) {
      terminalSeen = true;
    }
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
    if (clientTurnId) {
      void postJson(
        `${runPath}/cancel`,
        {},
        {
          communicationScene: "workspace-chat",
          task: false,
        }
      ).catch(() => {});
    }
    ctrl.abort();
    emitStop();
  };

  const externalAbort = () => {
    stopped = true;
    ctrl.abort();
  };

  signal?.addEventListener?.("abort", externalAbort, { once: true });
  window.addEventListener(ABORT_STREAM_EVENT, abortStream);

  const waitForReconnect = (attempt) =>
    new Promise((resolve) => {
      if (ctrl.signal.aborted) return resolve();
      const delay = Math.min(500 * 2 ** Math.min(attempt, 5), 10_000);
      let timeout = null;
      const finish = () => {
        if (timeout) clearTimeout(timeout);
        window.removeEventListener("online", finish);
        document.removeEventListener("visibilitychange", onVisibility);
        resolve();
      };
      const onVisibility = () => {
        if (!document.hidden) finish();
      };
      window.addEventListener("online", finish, { once: true });
      document.addEventListener("visibilitychange", onVisibility);
      timeout = setTimeout(finish, delay);
    });

  const streamOptions = (streamPath, reconnecting = false) => ({
    path: streamPath,
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
    onOpen(response) {
      updateChatStreamObservationRequestId(
        clientTurnId,
        response.headers?.get?.("X-Request-Id") ||
          response.headers?.get?.("X-Athena-Request-Id")
      );
      if (reconnecting) {
        recordChatStreamReconnect(clientTurnId, "recovered", reconnectAttempt);
        emitRaw(connectionRawEvent("connected"));
      }
      reconnectAttempt = 0;
      onOpen?.(response);
    },
    onMessage(raw) {
      if (stopped) return;
      emitRaw(raw);
    },
    onError() {
      // The durable server-side run owns generation. A transport failure only
      // detaches this subscriber; the reconnect loop below resumes by revision.
    },
    onClose() {
      onClose?.();
    },
  });

  try {
    const requestBody = {
      ...body,
      attachments: await preuploadLargeChatAttachments(
        workspaceSlug,
        body?.attachments || [],
        { signal: ctrl.signal }
      ),
    };
    try {
      await postJsonSse({
        ...streamOptions(path),
        body: requestBody,
      });
    } catch (error) {
      // A transport or recoverable server failure may happen after the durable
      // run was claimed, so reconnecting by clientTurnId remains safe. A
      // definitive client/auth rejection cannot have created the run and must
      // terminate instead of polling a nonexistent run forever.
      if (!shouldReconnectInitialChatPost(error)) {
        emitError(error);
        return;
      }
    }

    if (!terminalSeen && !stopped && !ctrl.signal.aborted) {
      emitRaw(connectionRawEvent("reconnecting"));
    }
    while (!stopped && !ctrl.signal.aborted && !terminalSeen) {
      recordChatStreamReconnect(clientTurnId, "started", reconnectAttempt + 1);
      await waitForReconnect(reconnectAttempt++);
      if (stopped || ctrl.signal.aborted || terminalSeen) break;
      try {
        await getJsonSse({
          ...streamOptions(
            `${runPath}/stream?afterRevision=${encodeURIComponent(lastRevision)}`,
            true
          ),
        });
      } catch {
        emitRaw(connectionRawEvent("reconnecting"));
        if (reconnectAttempt >= 3) {
          recordChatStreamReconnect(clientTurnId, "failed", reconnectAttempt);
        }
        // Keep the answer in "reconnecting" state. Only a terminal server
        // event may fail or cancel the turn.
      }
    }
  } catch (error) {
    if (!stopped && !ctrl.signal.aborted) emitError(error);
  } finally {
    endChatStreamObservation(clientTurnId);
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
