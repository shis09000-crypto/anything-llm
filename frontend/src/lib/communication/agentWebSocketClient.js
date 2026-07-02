import { useEffect, useState } from "react";
import { API_BASE } from "@/utils/constants";
import {
  CODEX_DEV_AUTH_BYPASS_KEY,
  CODEX_DEV_AUTH_BYPASS_QUERY,
  isCodexDevAuthBypassEnabled,
} from "@/utils/codexDevAuthBypass";
import { requestJson } from "./apiClient";
import {
  createWebSocket,
  safeClose,
  safeSendSignedJson,
} from "./webSocketClient";
import { webSocketOriginForHttpBase } from "./transportSecurity";
import {
  debugAgentProtocolEvent,
  normalizeAgentWebSocketEvent,
  parseAgentWebSocketMessage,
} from "./agentWebSocketProtocol";
import {
  clearSigningSecretCache,
  isRecoverableSigningError,
} from "./requestSigningClient";
import { getAuthToken } from "@/utils/authTokenStorage";

export const AgentSessionState = {
  IDLE: "idle",
  CONNECTING: "connecting",
  OPEN: "open",
  RECONNECTING: "reconnecting",
  WAITING_ON_INPUT: "waiting_on_input",
  STOPPING: "stopping",
  FINALIZED: "finalized",
  CLOSED: "closed",
  FAILED: "failed",
};

export const AGENT_SESSION_START = "agentSessionStart";
export const AGENT_SESSION_END = "agentSessionEnd";

const MAX_AGENT_RECONNECT_ATTEMPTS = 5;
const AGENT_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 12_000];
const DEFAULT_AGENT_SILENCE_TIMEOUT_MS = 90_000;

const TERMINAL_STATES = new Set([
  AgentSessionState.FINALIZED,
  AgentSessionState.CLOSED,
  AgentSessionState.FAILED,
]);

let agentSessionActive = false;

export function setAgentSessionActive(value) {
  agentSessionActive = !!value;
}

export function getAgentSessionActive() {
  return agentSessionActive;
}

export function useIsAgentSessionActive() {
  const [activeSession, setActiveSession] = useState(
    () => !!getAgentSessionActive()
  );

  useEffect(() => {
    function onStart() {
      setActiveSession(true);
    }
    function onEnd() {
      setActiveSession(false);
    }
    window.addEventListener(AGENT_SESSION_START, onStart);
    window.addEventListener(AGENT_SESSION_END, onEnd);
    return () => {
      window.removeEventListener(AGENT_SESSION_START, onStart);
      window.removeEventListener(AGENT_SESSION_END, onEnd);
    };
  }, []);

  return activeSession;
}

export function agentWebSocketURI() {
  const apiBase = API_BASE === "/api" ? window.location.origin : API_BASE;
  return webSocketOriginForHttpBase(apiBase, { kind: "agent_websocket" });
}

export function agentWebSocketUrl(
  websocketUUID,
  { resume = false, lastEventSeq = 0 } = {}
) {
  const query = new URLSearchParams();
  const token = typeof window !== "undefined" ? getAuthToken() : null;
  if (token) query.set("token", token);
  if (isCodexDevAuthBypassEnabled()) {
    query.set(CODEX_DEV_AUTH_BYPASS_QUERY, CODEX_DEV_AUTH_BYPASS_KEY);
  }
  if (resume || Number(lastEventSeq) > 0) {
    query.set("resume", "1");
    query.set("lastEventSeq", String(lastEventSeq || 0));
  }
  return `${agentWebSocketURI()}/api/agent-invocation/${websocketUUID}${
    query.toString() ? `?${query.toString()}` : ""
  }`;
}

function reconnectBackoff(attempt = 1) {
  const index = Math.max(
    0,
    Math.min(attempt - 1, AGENT_RECONNECT_BACKOFF_MS.length - 1)
  );
  return AGENT_RECONNECT_BACKOFF_MS[index] + Math.floor(Math.random() * 250);
}

function isMeaningfulAgentEvent(event = {}) {
  if (!event) return false;
  if (
    [
      "assistant_delta",
      "assistant_final",
      "assistant_patch",
      "assistant_error",
    ].includes(event.type)
  ) {
    return true;
  }
  if (event.type !== "timeline_event") return false;
  return [
    "thought",
    "tool_call",
    "tool_result",
    "approval_request",
    "approval_result",
  ].includes(event.event?.type);
}

function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

export function getAgentSessionSnapshot(agentSession) {
  if (!agentSession || typeof agentSession.getState !== "function") return null;
  try {
    return agentSession.getState() || null;
  } catch {
    return null;
  }
}

export function canReuseAgentSessionForInvocation(agentSession, websocketUUID) {
  if (!agentSession || !websocketUUID) return false;
  const snapshot = getAgentSessionSnapshot(agentSession);
  if (snapshot?.websocketUUID !== websocketUUID) return false;
  if (TERMINAL_STATES.has(snapshot?.state)) return false;
  if (
    typeof agentSession.isTerminal === "function" &&
    agentSession.isTerminal()
  ) {
    return false;
  }
  return true;
}

function stateAllowsSend(state) {
  return [AgentSessionState.OPEN, AgentSessionState.WAITING_ON_INPUT].includes(
    state
  );
}

function stateAllowsReconnect(state) {
  return [
    AgentSessionState.CONNECTING,
    AgentSessionState.OPEN,
    AgentSessionState.RECONNECTING,
    AgentSessionState.WAITING_ON_INPUT,
  ].includes(state);
}

function stateAllowsFinalize(state) {
  return [AgentSessionState.OPEN, AgentSessionState.WAITING_ON_INPUT].includes(
    state
  );
}

async function fetchAgentInvocationState(websocketUUID) {
  if (!websocketUUID) return null;
  const { data } = await requestJson(
    `/agent-invocation/${websocketUUID}/state`
  );
  return data?.state || null;
}

export async function respondToClarificationViaHttp(
  websocketUUID,
  requestId,
  payload = {}
) {
  if (!websocketUUID) return { ok: false, reason: "missing_websocket_uuid" };
  if (!requestId) return { ok: false, reason: "missing_request_id" };

  try {
    const { data } = await requestJson(
      `/agent-invocation/${websocketUUID}/clarification-response`,
      {
        method: "POST",
        body: {
          requestId,
          skipped: !!payload.skipped,
          answers: Array.isArray(payload.answers) ? payload.answers : [],
        },
        timeoutMs: 10_000,
      }
    );
    if (data?.success) {
      return { ok: true, reason: null, transport: "http_fallback" };
    }
    return {
      ok: false,
      reason: data?.error || "clarification_http_failed",
      error: data,
      transport: "http_fallback",
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error?.raw?.error ||
        error?.code ||
        error?.message ||
        "clarification_http_failed",
      error,
      transport: "http_fallback",
    };
  }
}

export function createAgentWebSocketSession({
  websocketUUID,
  chatKey = null,
  turnId = null,
  initialLastEventSeq = 0,
  initialRetryCount = 0,
  workspaceSlug = null,
  threadSlug = null,
  prompt = "",
  displayPrompt = prompt,
  attachments = [],
  fileAccessMode = null,
  nodeContext = null,
  agentProvider = null,
  agentModel = null,
  agentModelTier = null,
  silenceTimeoutMs = DEFAULT_AGENT_SILENCE_TIMEOUT_MS,
  reconnectAttemptStartedAt = null,
  reconnectDueAt = null,
  getInterruptedContext,
  onEvent,
  onProtocolEvent,
  onState,
  onReconnectOffer,
  onFinal,
  onError,
  onClose,
} = {}) {
  let socket = null;
  let silenceTimer = null;
  let reconnectTimer = null;
  let emittedStop = false;
  let emittedTurnFinal = false;
  let emittedFinalWithChatId = false;
  let emittedFailure = false;
  let emittedClose = false;

  const session = {
    current: AgentSessionState.IDLE,
    previousState: null,
    retryCount: Number(initialRetryCount) || 0,
    maxRetries: MAX_AGENT_RECONNECT_ATTEMPTS,
    lastEventSeq: Number(initialLastEventSeq) || 0,
    lastMeaningfulOutputAt: Date.now(),
    websocketUUID,
    chatKey,
    turnId,
    workspaceSlug,
    threadSlug,
    originalPrompt: prompt || "",
    displayPrompt: displayPrompt || prompt || "",
    attachments: attachments || [],
    fileAccessMode,
    nodeContext,
    agentProvider,
    agentModel,
    agentModelTier,
    silenceTimeoutMs: silenceTimeoutMs || DEFAULT_AGENT_SILENCE_TIMEOUT_MS,
    reconnectAttemptStartedAt,
    reconnectDueAt,
    finalChatId: null,
    finalPublicChatId: null,
    closeReason: null,
    failureReason: null,
  };

  function snapshot(extra = {}) {
    return {
      state: session.current,
      previousState: session.previousState,
      retryCount: session.retryCount,
      maxRetries: session.maxRetries,
      lastEventSeq: session.lastEventSeq,
      websocketUUID: session.websocketUUID,
      chatKey: session.chatKey,
      turnId: session.turnId,
      workspaceSlug: session.workspaceSlug,
      threadSlug: session.threadSlug,
      agentProvider: session.agentProvider,
      agentModel: session.agentModel,
      agentModelTier: session.agentModelTier,
      silenceTimeoutMs: session.silenceTimeoutMs,
      reconnectAttemptStartedAt: session.reconnectAttemptStartedAt,
      reconnectDueAt: session.reconnectDueAt,
      finalChatId: session.finalChatId,
      finalPublicChatId: session.finalPublicChatId,
      ...extra,
    };
  }

  function setGlobalActiveForState(next) {
    const active = [
      AgentSessionState.CONNECTING,
      AgentSessionState.OPEN,
      AgentSessionState.RECONNECTING,
      AgentSessionState.WAITING_ON_INPUT,
      AgentSessionState.STOPPING,
    ].includes(next);
    const previous = getAgentSessionActive();
    setAgentSessionActive(active);
    if (active && !previous) {
      window.dispatchEvent(new CustomEvent(AGENT_SESSION_START));
    } else if (!active && previous) {
      window.dispatchEvent(new CustomEvent(AGENT_SESSION_END));
    }
  }

  function transition(next, reason, patch = {}) {
    const current = session.current;
    if (
      current === AgentSessionState.FINALIZED &&
      next !== AgentSessionState.CLOSED
    )
      return false;
    if (
      current === AgentSessionState.STOPPING &&
      next !== AgentSessionState.CLOSED
    )
      return false;
    if ([AgentSessionState.CLOSED, AgentSessionState.FAILED].includes(current))
      return false;

    session.previousState = current;
    session.current = next;
    Object.assign(session, patch);
    setGlobalActiveForState(next);
    onState?.(snapshot({ previousState: current, reason }));
    return true;
  }

  function updateState(reason, patch = {}) {
    Object.assign(session, patch);
    onState?.(snapshot({ reason }));
  }

  function clearSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  function clearReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function clearTimers() {
    clearSilenceTimer();
    clearReconnectTimer();
  }

  function isTerminal() {
    return isTerminalState(session.current);
  }

  function canSend() {
    return stateAllowsSend(session.current) && !isTerminal() && socket;
  }

  function canReconnect() {
    return stateAllowsReconnect(session.current) && !isTerminal();
  }

  function canFinalize() {
    return stateAllowsFinalize(session.current) && !emittedTurnFinal;
  }

  function scheduleSilenceTimer() {
    clearSilenceTimer();
    if (
      session.current === AgentSessionState.WAITING_ON_INPUT ||
      isTerminal() ||
      session.current === AgentSessionState.STOPPING
    ) {
      return;
    }

    silenceTimer = setTimeout(() => {
      if (
        session.current === AgentSessionState.WAITING_ON_INPUT ||
        isTerminal() ||
        session.current === AgentSessionState.STOPPING
      ) {
        return;
      }
      socket?.close();
    }, session.silenceTimeoutMs || DEFAULT_AGENT_SILENCE_TIMEOUT_MS);
  }

  function emitEvent(event) {
    if (!event) return null;
    if (event.protocolEvent) onProtocolEvent?.(event.protocolEvent, event);
    return onEvent?.(event);
  }

  function emitReconnectThought() {
    emitEvent({
      type: "timeline_event",
      event: {
        type: "thought",
        content: `Agent connection interrupted. Reconnecting ${session.retryCount}/${MAX_AGENT_RECONNECT_ATTEMPTS}...`,
      },
    });
  }

  function offerReconnect(reason) {
    if (emittedFailure || isTerminal()) return false;
    emittedFailure = true;
    clearTimers();
    transition(AgentSessionState.FAILED, "max_retries_exceeded", {
      failureReason: reason,
      reconnectAttemptStartedAt: null,
      reconnectDueAt: null,
    });
    const interruptedContext =
      getInterruptedContext?.(reason, snapshot({ reason })) || null;
    onReconnectOffer?.(reason, interruptedContext, snapshot());
    return true;
  }

  function scheduleReconnect(reason) {
    if (!canReconnect()) return false;
    if (session.retryCount >= MAX_AGENT_RECONNECT_ATTEMPTS) {
      return offerReconnect(reason);
    }

    session.retryCount += 1;
    const delay = reconnectBackoff(session.retryCount);
    const startedAt = Date.now();
    transition(AgentSessionState.RECONNECTING, "reconnect_scheduled", {
      reconnectAttemptStartedAt: startedAt,
      reconnectDueAt: startedAt + delay,
      closeReason: reason,
    });
    emitReconnectThought();
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      connect({ forceReconnect: true });
    }, delay);
    return true;
  }

  function handleFinal(normalized) {
    if (!canFinalize()) return null;
    emittedTurnFinal = true;
    const applied = emitEvent(normalized);
    const chatId = applied?.chatId || normalized?.chatId || session.finalChatId;
    const publicChatId =
      applied?.publicChatId ||
      normalized?.publicChatId ||
      session.finalPublicChatId;
    session.finalChatId = chatId || session.finalChatId;
    session.finalPublicChatId = publicChatId || session.finalPublicChatId;
    emittedFinalWithChatId = !!session.finalChatId;
    clearTimers();
    updateState("assistant_turn_final", {
      finalChatId: session.finalChatId,
      finalPublicChatId: session.finalPublicChatId,
      reconnectAttemptStartedAt: null,
      reconnectDueAt: null,
    });
    onFinal?.(session.finalChatId, normalized, applied, snapshot());
    return applied;
  }

  function handlePatch(normalized) {
    const applied = emitEvent(normalized);
    const chatId =
      normalized?.patch?.chatId ||
      applied?.patch?.chatId ||
      applied?.chatId ||
      null;
    const publicChatId =
      normalized?.patch?.publicChatId ||
      applied?.patch?.publicChatId ||
      applied?.publicChatId ||
      null;

    if (!chatId && !publicChatId) return applied;

    session.finalChatId = chatId || session.finalChatId;
    session.finalPublicChatId = publicChatId || session.finalPublicChatId;
    updateState("assistant_chat_id_patch", {
      finalChatId: session.finalChatId,
      finalPublicChatId: session.finalPublicChatId,
    });

    if (emittedTurnFinal && !emittedFinalWithChatId) {
      emittedFinalWithChatId = true;
      onFinal?.(session.finalChatId, normalized, applied, snapshot());
    }

    return applied;
  }

  function handleMessage(event) {
    const raw = parseAgentWebSocketMessage(event);
    const normalized = normalizeAgentWebSocketEvent(raw);
    debugAgentProtocolEvent(raw, normalized);
    if (!normalized) return;

    if (["agent_replay_start", "agent_replay_end"].includes(normalized.type)) {
      return;
    }

    const seq = Number(normalized.seq || raw?.seq || 0);
    if (seq && seq <= (session.lastEventSeq || 0)) return;
    if (seq) {
      session.lastEventSeq = seq;
      updateState("event_seq", { lastEventSeq: seq });
    }

    if (normalized.type === "agent_waiting_on_input") {
      emittedTurnFinal = false;
      emittedFinalWithChatId = false;
      transition(AgentSessionState.WAITING_ON_INPUT, "waiting_on_input");
      clearSilenceTimer();
      return;
    }

    const isClarificationRequest =
      normalized.type === "timeline_event" &&
      normalized.event?.type === "clarification_request";
    if (isClarificationRequest) {
      emittedTurnFinal = false;
      emittedFinalWithChatId = false;
      transition(AgentSessionState.WAITING_ON_INPUT, "clarification_request");
      clearSilenceTimer();
    }

    if (normalized.type === "assistant_final") {
      handleFinal(normalized);
      return;
    }

    if (normalized.type === "assistant_patch") {
      handlePatch(normalized);
      return;
    }

    emitEvent(normalized);

    if (normalized.type === "assistant_error") {
      const signingErrorCode =
        normalized?.protocolEvent?.raw?.code || normalized?.code || null;
      if (isRecoverableSigningError(signingErrorCode)) {
        clearSigningSecretCache();
      }
      if (
        session.current !== AgentSessionState.STOPPING &&
        session.current !== AgentSessionState.FINALIZED
      ) {
        safeClose(socket);
      }
      return;
    }

    if (isMeaningfulAgentEvent(normalized)) {
      session.lastMeaningfulOutputAt = Date.now();
      updateState("meaningful_event", {
        reconnectAttemptStartedAt: null,
        reconnectDueAt: null,
      });
      scheduleSilenceTimer();
    }
  }

  function handleClose() {
    clearSilenceTimer();
    socket = null;

    if (session.current === AgentSessionState.STOPPING) {
      transition(AgentSessionState.CLOSED, "stopped");
      onClose?.(snapshot({ reason: "stopped" }));
      return;
    }

    if (session.current === AgentSessionState.FINALIZED) {
      transition(AgentSessionState.CLOSED, "finalized");
      onClose?.(snapshot({ reason: "finalized" }));
      return;
    }

    if (session.current === AgentSessionState.FAILED) {
      onClose?.(snapshot({ reason: "failed" }));
      return;
    }

    if (session.current === AgentSessionState.CLOSED) {
      if (!emittedClose) onClose?.(snapshot({ reason: "closed" }));
      emittedClose = true;
      return;
    }

    if (emittedTurnFinal) {
      transition(AgentSessionState.FINALIZED, "assistant_final_close", {
        finalChatId: session.finalChatId,
      });
      transition(AgentSessionState.CLOSED, "finalized");
      onClose?.(snapshot({ reason: "finalized" }));
      return;
    }

    scheduleReconnect(
      session.closeReason || "Agent websocket closed before a final response."
    );
  }

  function handleError(error) {
    if (
      session.current === AgentSessionState.STOPPING ||
      session.current === AgentSessionState.FINALIZED ||
      isTerminal()
    ) {
      return;
    }
    session.closeReason = "Agent websocket connection failed.";
    onError?.(error, snapshot({ reason: session.closeReason }));
    safeClose(socket);
  }

  async function connect({ forceReconnect = false } = {}) {
    if (
      !websocketUUID ||
      isTerminal() ||
      session.current === AgentSessionState.STOPPING
    ) {
      return false;
    }
    if (socket && !forceReconnect) return true;
    clearSilenceTimer();

    if (session.current === AgentSessionState.RECONNECTING) {
      transition(AgentSessionState.CONNECTING, "reconnect_connecting");
    } else {
      transition(AgentSessionState.CONNECTING, "connect");
    }

    socket = createWebSocket({
      url: agentWebSocketUrl(websocketUUID, {
        resume: session.lastEventSeq > 0 || session.retryCount > 0,
        lastEventSeq: session.lastEventSeq,
      }),
      task: {
        kind: "agent-websocket",
        priority: "P0",
        protected: true,
        abortable: false,
        scope: {
          route: "workspace-chat",
          surface: "agent",
          websocketUUID,
        },
      },
    });

    socket.addEventListener("open", () => {
      transition(AgentSessionState.OPEN, "socket_open", {
        reconnectAttemptStartedAt: null,
        reconnectDueAt: null,
      });
      fetchAgentInvocationState(websocketUUID)
        .then((state) => {
          if (!state || isTerminal()) return;
          updateState("invocation_state", {
            agentProvider: state.provider || session.agentProvider || null,
            agentModel: state.model || session.agentModel || null,
            agentModelTier: state.modelTier || session.agentModelTier || null,
            silenceTimeoutMs:
              Number(state.silenceTimeoutMs) > 0
                ? Number(state.silenceTimeoutMs)
                : session.silenceTimeoutMs,
          });
          scheduleSilenceTimer();
        })
        .catch(() => scheduleSilenceTimer());
    });
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);
    scheduleSilenceTimer();
    return true;
  }

  async function sendPayload(payload) {
    if (!canSend()) {
      return { ok: false, reason: isTerminal() ? session.current : "not_open" };
    }
    const result = await safeSendSignedJson(socket, payload);
    if (!result.ok) return result;
    if (session.current === AgentSessionState.WAITING_ON_INPUT) {
      emittedTurnFinal = false;
      emittedFinalWithChatId = false;
      transition(AgentSessionState.OPEN, "client_input_sent");
    }
    scheduleSilenceTimer();
    return result;
  }

  async function stop(reason = "user_stop") {
    if (emittedStop || isTerminal()) {
      return {
        ok: false,
        reason: emittedStop ? "already_stopped" : session.current,
      };
    }
    emittedStop = true;
    const canNotifyBackend = socket?.readyState === WebSocket.OPEN;
    transition(AgentSessionState.STOPPING, reason);
    clearTimers();
    emitEvent({
      type: "stop_generation",
      content: "Generation stopped by user.",
    });
    if (canNotifyBackend) {
      await safeSendSignedJson(socket, {
        type: "awaitingFeedback",
        feedback: "/exit",
      });
    }
    safeClose(socket);
    if (!socket) {
      transition(AgentSessionState.CLOSED, "stopped");
      onClose?.(snapshot({ reason: "stopped" }));
    }
    return { ok: true };
  }

  function close(reason = "manual_close") {
    clearTimers();
    if (!isTerminal() && session.current !== AgentSessionState.STOPPING) {
      transition(AgentSessionState.CLOSED, reason);
    }
    safeClose(socket);
    if (!emittedClose) {
      emittedClose = true;
      onClose?.(snapshot({ reason }));
    }
  }

  async function sendFeedback({
    feedback,
    attachments: nextAttachments = [],
    fileAccessMode: nextMode = null,
    nodeContext: nextNodeContext = null,
  } = {}) {
    return sendPayload({
      type: "awaitingFeedback",
      feedback,
      attachments: nextAttachments,
      fileAccess: { mode: nextMode },
      nodeContext: nextNodeContext,
    });
  }

  async function respondToApproval(requestId, approved) {
    if (!requestId) return { ok: false, reason: "missing_request_id" };
    return sendPayload({
      type: "toolApprovalResponse",
      requestId,
      approved: !!approved,
    });
  }

  async function respondToClarification(requestId, payload = {}) {
    if (!requestId) return { ok: false, reason: "missing_request_id" };
    return sendPayload({
      type: "clarificationResponse",
      requestId,
      skipped: !!payload.skipped,
      answers: Array.isArray(payload.answers) ? payload.answers : [],
    });
  }

  function reconnect(reason = "manual_reconnect") {
    return scheduleReconnect(reason);
  }

  const controller = {
    stop,
    close,
    sendFeedback,
    respondToApproval,
    respondToClarification,
    reconnect,
    getState: () => snapshot(),
    isTerminal,
    isOpen: () => stateAllowsSend(session.current),
  };

  connect();
  return controller;
}
