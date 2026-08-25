import { ABORT_STREAM_EVENT, dispatchThreadRename } from "@/utils/chat";
import { v4 } from "uuid";
import { getJson, postJson } from "./apiClient";
import { getJsonSse, postJsonSse } from "./streamClient";
import {
  isVisibleChatTerminalEvent,
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
  turnContext = null,
}) {
  let timeZone = null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    timeZone = null;
  }
  return {
    message,
    displayPrompt,
    attachments,
    fileAccess: { mode: fileAccessMode },
    nodeContext,
    clientTurnId,
    ...(timeZone ? { timeZone } : {}),
    ...(editContext ? { editContext } : {}),
    ...(regenerateContext ? { regenerateContext } : {}),
    ...(turnContext ? { turnContext } : {}),
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

export function chatRunClaimProbeResult(error = null) {
  if (!error) return "claimed";
  const status = Number(error?.status || error?.raw?.status || 0);
  const code = String(
    error?.code || error?.raw?.error || error?.details?.error || ""
  ).toLowerCase();
  if (status === 404 || code === "chat_stream_run_not_found") return "missing";
  return "unknown";
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
  let resolveVisibleTerminal = null;
  const visibleTerminal = new Promise((resolve) => {
    resolveVisibleTerminal = resolve;
  });
  let lastRevision = 0;
  let reconnectAttempt = 0;
  let responseId = null;
  const clientTurnId = String(body?.clientTurnId || "").trim();
  const encodedTurnId = encodeURIComponent(clientTurnId);
  const legacyRunPath = threadSlug
    ? `/workspace/${workspaceSlug}/thread/${threadSlug}/chat-runs/${encodedTurnId}`
    : `/workspace/${workspaceSlug}/chat-runs/${encodedTurnId}`;
  const responsePath = () =>
    threadSlug
      ? `/workspace/${workspaceSlug}/thread/${threadSlug}/responses/${encodeURIComponent(responseId)}`
      : `/workspace/${workspaceSlug}/responses/${encodeURIComponent(responseId)}`;
  beginChatStreamObservation(clientTurnId);

  const emitRaw = (raw) => {
    const revision = Number(raw?.sequence_number ?? raw?.runRevision);
    if (Number.isFinite(revision)) {
      lastRevision = Math.max(lastRevision, revision);
      if (
        [
          "textResponseChunk",
          "fullTextResponse",
          "response.output_text.delta",
        ].includes(raw?.type)
      ) {
        recordChatStreamRevision(clientTurnId, lastRevision);
      }
    }
    if (raw?.response_id) responseId = raw.response_id;
    if (
      ["response.completed", "response.failed", "response.incomplete"].includes(
        raw?.type
      )
    ) {
      terminalSeen = true;
      resolveVisibleTerminal?.(raw);
      resolveVisibleTerminal = null;
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
    if (responseId) {
      void postJson(
        `${responsePath()}/cancel`,
        {},
        {
          communicationScene: "workspace-chat",
          task: false,
        }
      ).catch(() => {});
    } else if (clientTurnId)
      void postJson(
        `${legacyRunPath}/cancel`,
        {},
        {
          communicationScene: "workspace-chat",
          task: false,
        }
      ).catch(() => {});
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

  const confirmRunClaim = async () => {
    let missingCount = 0;
    for (const delay of [0, 250, 750]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (stopped || ctrl.signal.aborted) return "unknown";
      try {
        const { data } = await getJson(`${legacyRunPath}/state`, {
          signal: ctrl.signal,
          communicationScene: "workspace-chat",
          task: {
            kind: "chat-stream-state",
            label: "chat:stream:claim-state",
            priority: "P0",
            policy: "interactive",
            resource: "network",
            protected: true,
            abortable: false,
          },
        });
        responseId = data?.run?.responseId || responseId;
        return "claimed";
      } catch (error) {
        const result = chatRunClaimProbeResult(error);
        if (result !== "missing") return result;
        missingCount += 1;
      }
    }
    return missingCount === 3 ? "missing" : "unknown";
  };

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
      responseId =
        response.headers?.get?.("X-Athena-Response-Id") || responseId;
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
      const foregroundTransport = postJsonSse({
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
      const claimState = await confirmRunClaim();
      if (claimState === "missing") {
        const claimError = Object.assign(
          new Error(
            "The chat request was not accepted by the runtime. Please retry."
          ),
          {
            code: "chat_stream_run_not_created",
            status: Number(error?.status || 503),
            cause: error,
          }
        );
        emitError(claimError);
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
      if (!responseId) {
        const claimState = await confirmRunClaim();
        if (claimState === "missing") {
          emitError(
            Object.assign(new Error("Responses turn was not found."), {
              code: "response_not_found",
              status: 404,
            })
          );
          break;
        }
        if (!responseId) continue;
      }
      try {
        await getJsonSse({
          ...streamOptions(
            `${responsePath()}/stream?afterSequence=${encodeURIComponent(lastRevision)}`,
            true
          ),
          headers: { "Last-Event-ID": String(lastRevision) },
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
    path: `/workspace/${workspaceSlug}/responses`,
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
    path: `/workspace/${workspaceSlug}/thread/${threadSlug}/responses`,
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
  turnContext = null,
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
    turnContext,
  });
}

export async function submitResponseAction({
  workspaceSlug,
  threadSlug = null,
  responseId,
  actionId,
  body = {},
}) {
  const base = threadSlug
    ? `/workspace/${workspaceSlug}/thread/${threadSlug}`
    : `/workspace/${workspaceSlug}`;
  return postJson(
    `${base}/responses/${encodeURIComponent(responseId)}/actions/${encodeURIComponent(actionId)}`,
    body,
    { communicationScene: "workspace-chat", task: false }
  )
    .then(({ data }) => data)
    .catch((error) => ({ success: false, error: error?.message }));
}
