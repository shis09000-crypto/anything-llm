import { API_BASE } from "@/utils/constants";
import { getAuthToken } from "@/utils/authTokenStorage";
import { getStoredAuthUser } from "@/utils/authUserStorage";
import { getAppEnvironment } from "@/utils/appEnvironment";
import {
  CODEX_DEV_AUTH_BYPASS_KEY,
  CODEX_DEV_AUTH_BYPASS_QUERY,
  isCodexDevAuthBypassEnabled,
} from "@/utils/codexDevAuthBypass";
import {
  createCommunicationRequestId,
  getClientIdentity,
} from "../clientIdentity";
import { webSocketOriginForHttpBase } from "../transportSecurity";
import {
  createWebSocket,
  safeClose,
  safeSendSignedJson,
} from "../webSocketClient";
import { recordCommunicationEvent } from "../communicationMetrics";
import { recoveryCenter } from "@/utils/recovery/recoveryCenter";
import { broadcastEventReducer } from "./broadcastEventReducer";
import { broadcastSubscriptionManager } from "./broadcastSubscriptionManager";

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 8_000;
const SNAPSHOT_RECENT_LIMIT = 80;

const state = {
  socket: null,
  connected: false,
  connecting: false,
  reconnects: 0,
  lastEventId: null,
  lastAckedEventId: null,
  lastError: null,
  counters: {
    received: 0,
    acked: 0,
    replayed: 0,
    reconnects: 0,
    coalesced: 0,
    dropped: 0,
  },
  recent: [],
  subscriptions: [],
};

function wsBase() {
  const apiBase = API_BASE === "/api" ? window.location.origin : API_BASE;
  return webSocketOriginForHttpBase(apiBase, { kind: "broadcast_websocket" });
}

function storageKey() {
  const user = getStoredAuthUser();
  const client = getClientIdentity();
  return [
    "athena_broadcast_last_ack_v1",
    getAppEnvironment(),
    user?.authUserId || user?.id || user?.username || "anonymous",
    client.clientId || "legacy",
  ].join(":");
}

function readLastAckedEventId() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(storageKey());
  } catch {
    return null;
  }
}

function writeLastAckedEventId(eventId) {
  if (!eventId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(), eventId);
  } catch {}
}

function broadcastUrl() {
  const query = new URLSearchParams();
  const token = getAuthToken();
  if (token) query.set("token", token);
  if (isCodexDevAuthBypassEnabled()) {
    query.set(CODEX_DEV_AUTH_BYPASS_QUERY, CODEX_DEV_AUTH_BYPASS_KEY);
  }
  const lastEventId = state.lastAckedEventId || readLastAckedEventId();
  if (lastEventId) query.set("lastEventId", lastEventId);
  return `${wsBase()}/api/realtime/broadcast${
    query.toString() ? `?${query.toString()}` : ""
  }`;
}

function backoff(attempt = 0) {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function rememberRecent(entry) {
  state.recent.push({ ...entry, at: Date.now() });
  if (state.recent.length > SNAPSHOT_RECENT_LIMIT) {
    state.recent.splice(0, state.recent.length - SNAPSHOT_RECENT_LIMIT);
  }
}

async function sendControl(socket, payload) {
  return safeSendSignedJson(socket, {
    requestId: createCommunicationRequestId(),
    ...payload,
  });
}

function sendHello(socket) {
  state.subscriptions = broadcastSubscriptionManager.scopes();
  return sendControl(socket, {
    type: "hello",
    lastEventId: state.lastAckedEventId || readLastAckedEventId(),
    subscriptions: state.subscriptions,
  });
}

function ackEvent(socket, event) {
  if (!event?.eventId || event.requiresAck === false) return;
  state.lastEventId = event.eventId;
  state.lastAckedEventId = event.eventId;
  writeLastAckedEventId(event.eventId);
  state.counters.acked += 1;
  void sendControl(socket, {
    type: "ack",
    eventId: event.eventId,
  });
}

function handleMessage(socket, raw, onEvent) {
  let message = null;
  try {
    message = JSON.parse(raw.data);
  } catch {
    state.counters.dropped += 1;
    return;
  }
  if (!message || typeof message !== "object") return;

  if (message.type === "broadcast.event") {
    const event = message.event;
    state.counters.received += 1;
    const reduced = broadcastEventReducer.reduce(event);
    if (event?.coalescedCount) state.counters.coalesced += event.coalescedCount;
    onEvent?.(event, reduced);
    ackEvent(socket, event);
    rememberRecent({
      type: event?.broadcastType || `${event?.namespace}.${event?.type}`,
      eventId: event?.eventId,
      reduced,
    });
    return;
  }

  if (message.type === "broadcast.replayStart") {
    rememberRecent({ type: "replay-start", count: message.count || 0 });
    return;
  }
  if (message.type === "broadcast.replayEnd") {
    state.counters.replayed += Number(message.count || 0);
    rememberRecent({ type: "replay-end", count: message.count || 0 });
    return;
  }
  if (message.type === "broadcast.ready") {
    void sendHello(socket);
    return;
  }
  if (message.type === "broadcast.error") {
    state.lastError = message.error || message.code || "broadcast_error";
    recoveryCenter.handle(new Error(state.lastError), {
      source: "broadcast",
      scope: { route: "broadcast" },
      requestId: message.requestId,
    });
  }
}

function wireSubscriptions(socket) {
  return broadcastSubscriptionManager.subscribe((subscriptions) => {
    state.subscriptions = subscriptions;
    if (socket.readyState !== WebSocket.OPEN) return;
    void sendControl(socket, {
      type: "subscribe",
      subscriptions,
    });
  });
}

export async function connectBroadcast({ signal = null, onEvent = null } = {}) {
  if (typeof window === "undefined") return;
  state.lastAckedEventId = readLastAckedEventId();
  let attempt = 0;
  while (!signal?.aborted) {
    state.connecting = true;
    const socket = createWebSocket({
      url: broadcastUrl(),
      task: {
        kind: "broadcast-websocket",
        priority: "P1",
        policy: "visible",
        resource: "realtime",
        protected: true,
        abortable: true,
        scope: { route: "broadcast", surface: "broadcast" },
      },
    });
    state.socket = socket;
    const unsubscribeSubscriptions = wireSubscriptions(socket);

    const closed = new Promise((resolve) => {
      socket.addEventListener("open", () => {
        attempt = 0;
        state.connected = true;
        state.connecting = false;
        recordCommunicationEvent({
          type: "broadcast-open",
          method: "WS",
          path: "/realtime/broadcast",
          communicationScene: "sync",
          durationMs: 0,
          requestBytes: 0,
          responseBytes: 0,
          ok: true,
        });
      });
      socket.addEventListener("message", (event) =>
        handleMessage(socket, event, onEvent)
      );
      socket.addEventListener("close", () => resolve("close"), { once: true });
      socket.addEventListener("error", () => resolve("error"), { once: true });
      signal?.addEventListener(
        "abort",
        () => {
          safeClose(socket, 1000, "broadcast-abort");
          resolve("abort");
        },
        { once: true }
      );
    });

    const reason = await closed;
    unsubscribeSubscriptions();
    state.connected = false;
    state.connecting = false;
    if (signal?.aborted || reason === "abort") break;

    state.counters.reconnects += 1;
    state.reconnects += 1;
    recoveryCenter.handle(new Error("Broadcast connection closed."), {
      source: "broadcast",
      scope: { route: "broadcast" },
      retry: true,
      toast: false,
    });
    await sleep(backoff(attempt), signal);
    attempt += 1;
  }
}

export const broadcastClient = {
  connect: connectBroadcast,
  snapshot() {
    return {
      connected: state.connected,
      connecting: state.connecting,
      reconnects: state.reconnects,
      lastEventId: state.lastEventId,
      lastAckedEventId: state.lastAckedEventId,
      lastError: state.lastError,
      counters: { ...state.counters },
      subscriptions: broadcastSubscriptionManager.snapshot(),
      reducer: broadcastEventReducer.snapshot(),
      recent: [...state.recent],
    };
  },
};

if (typeof window !== "undefined") {
  const expose = () => {
    const enabled =
      import.meta.env?.DEV ||
      window.localStorage?.getItem?.("athenaRuntimeObserver") === "true" ||
      window.localStorage?.getItem?.("athenaBroadcastDebug") === "true";
    if (!enabled) return;
    window.__athenaBroadcastCenter = {
      snapshot: () => broadcastClient.snapshot(),
      setVisibleScopes: (scopes = []) =>
        broadcastSubscriptionManager.setVisibleScopes(scopes),
    };
  };
  expose();
}

export default broadcastClient;
