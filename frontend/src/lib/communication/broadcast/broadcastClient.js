import { API_BASE } from "@/utils/constants";
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
import { syncV2Runtime } from "@/utils/syncV2/syncV2Runtime";
import { syncV2Client } from "../syncV2Client";
import { issueRealtimeTicket } from "../realtimeTicketClient";

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 8_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const FALLBACK_GRACE_MS = 1_500;
const SNAPSHOT_RECENT_LIMIT = 80;

const state = {
  socket: null,
  connected: false,
  connecting: false,
  reconnects: 0,
  connectedAt: null,
  lastPongAt: null,
  lastPingAt: null,
  lastPingLatencyMs: null,
  lastEventId: null,
  lastAckedEventId: null,
  lastError: null,
  fallbackActive: false,
  reconcilePromise: null,
  counters: {
    received: 0,
    acked: 0,
    replayed: 0,
    reconnects: 0,
    coalesced: 0,
    dropped: 0,
    pings: 0,
    pongs: 0,
    fullReconciles: 0,
    incrementalPatches: 0,
  },
  recent: [],
  subscriptions: [],
};
let fallbackController = null;
let fallbackGraceTimer = null;

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

function broadcastUrl(ticket = null) {
  const query = new URLSearchParams();
  if (ticket) query.set("realtimeTicket", ticket);
  if (isCodexDevAuthBypassEnabled()) {
    query.set(CODEX_DEV_AUTH_BYPASS_QUERY, CODEX_DEV_AUTH_BYPASS_KEY);
  }
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

async function handleMessage(socket, raw, onEvent) {
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
    try {
      await state.reconcilePromise;
      const syncResult = await syncV2Runtime.processBroadcastEvent(event);
      const reduced = broadcastEventReducer.reduce(event, {
        syncV2Applied: syncResult?.syncV2Applied === true,
      });
      state.counters.incrementalPatches += 1;
      if (reduced?.action === "sync-required") {
        state.counters.fullReconciles += 1;
        await syncV2Runtime.reconcile();
      }
      if (event?.coalescedCount)
        state.counters.coalesced += event.coalescedCount;
      onEvent?.(event, reduced);
      ackEvent(socket, event);
      rememberRecent({
        type: event?.broadcastType || `${event?.namespace}.${event?.type}`,
        eventId: event?.eventId,
        reduced,
      });
    } catch (error) {
      state.lastError = error?.code || error?.message || "sync_v2_apply_failed";
      safeClose(socket, 1011, "sync-apply-failed");
    }
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
  if (message.type === "broadcast.hello") {
    stopSyncV2Fallback();
    rememberRecent({
      type: "hello",
      subscriptions: message.subscriptions?.length || 0,
    });
    return;
  }
  if (message.type === "broadcast.pong") {
    const now = Date.now();
    state.lastPongAt = now;
    state.lastPingLatencyMs = state.lastPingAt
      ? Math.max(0, now - state.lastPingAt)
      : null;
    state.counters.pongs += 1;
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

function syncV2SseEnvelope(syncEvent) {
  return {
    eventId: `sync-v2-sse:${syncEvent.eventId || syncEvent.seq}`,
    namespace: "syncV2",
    type: "node.changed",
    seq: Number(syncEvent.seq),
    nodeKey: syncEvent.nodeKey,
    stateVersion: Number(syncEvent.stateVersion),
    updatedAt: syncEvent.updatedAt,
    payload: { syncV2: syncEvent },
    requiresAck: false,
  };
}

function stopSyncV2Fallback() {
  if (fallbackGraceTimer) {
    clearTimeout(fallbackGraceTimer);
    fallbackGraceTimer = null;
  }
  fallbackController?.abort();
  fallbackController = null;
  state.fallbackActive = false;
}

function scheduleSyncV2Fallback(options = {}) {
  if (fallbackGraceTimer || fallbackController) return;
  fallbackGraceTimer = setTimeout(() => {
    fallbackGraceTimer = null;
    startSyncV2Fallback(options);
  }, FALLBACK_GRACE_MS);
}

function heartbeatFor(socket) {
  let pongDeadline = null;
  const ping = () => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (
      state.lastPingAt &&
      (!state.lastPongAt || state.lastPongAt < state.lastPingAt)
    ) {
      safeClose(socket, 4000, "broadcast-pong-timeout");
      return;
    }
    state.lastPingAt = Date.now();
    state.counters.pings += 1;
    void sendControl(socket, { type: "ping", at: state.lastPingAt });
    clearTimeout(pongDeadline);
    pongDeadline = setTimeout(() => {
      if (!state.lastPongAt || state.lastPongAt < state.lastPingAt) {
        safeClose(socket, 4000, "broadcast-pong-timeout");
      }
    }, HEARTBEAT_TIMEOUT_MS);
  };
  const interval = setInterval(ping, HEARTBEAT_INTERVAL_MS);
  const visibility = () => {
    if (document.visibilityState !== "visible") return;
    const lastAlive = state.lastPongAt || state.connectedAt || 0;
    if (Date.now() - lastAlive > HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS) {
      safeClose(socket, 4000, "broadcast-stale-on-resume");
      return;
    }
    ping();
  };
  document.addEventListener("visibilitychange", visibility);
  return () => {
    clearInterval(interval);
    clearTimeout(pongDeadline);
    document.removeEventListener("visibilitychange", visibility);
  };
}

function startSyncV2Fallback({ signal = null, onEvent = null } = {}) {
  if (fallbackController || !syncV2Runtime.enabled()) return;
  const controller = new AbortController();
  fallbackController = controller;
  state.fallbackActive = true;
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  void syncV2Client
    .stream(syncV2Runtime.snapshot().cursor, {
      signal: controller.signal,
      async onReady(message) {
        // The SSE transport deliberately keeps its inline replay bounded. If
        // more than one page accumulated, finish recovery through the paged
        // REST cursor path before accepting the stream as current.
        if (message?.requiresFullSync || message?.hasMore) {
          await syncV2Runtime.reconcile({ signal: controller.signal });
        }
      },
      async onEvent(syncEvent) {
        const syncResult = await syncV2Runtime.processEvent(syncEvent, {
          signal: controller.signal,
        });
        const event = syncV2SseEnvelope(syncEvent);
        const reduced = broadcastEventReducer.reduce(event, {
          syncV2Applied: syncResult?.syncV2Applied === true,
        });
        onEvent?.(event, reduced);
      },
      onError(error) {
        state.lastError = error?.code || error?.message || "sync_v2_sse_failed";
      },
    })
    .catch((error) => {
      if (controller.signal.aborted) return;
      state.lastError = error?.code || error?.message || "sync_v2_sse_failed";
    })
    .finally(() => {
      if (fallbackController === controller) {
        fallbackController = null;
        state.fallbackActive = false;
      }
    });
}

function wireSubscriptions(socket) {
  return broadcastSubscriptionManager.subscribe((subscriptions) => {
    state.subscriptions = subscriptions;
    if (socket.readyState !== WebSocket.OPEN) return;
    void sendControl(socket, {
      type: "replaceSubscriptions",
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
    let realtimeTicket = null;
    try {
      realtimeTicket = await issueRealtimeTicket("broadcast", null, { signal });
    } catch (error) {
      state.lastError =
        error?.code || error?.message || "realtime_ticket_failed";
      state.connecting = false;
      startSyncV2Fallback({ signal, onEvent });
      await sleep(backoff(attempt), signal);
      attempt += 1;
      continue;
    }
    const socket = createWebSocket({
      url: broadcastUrl(realtimeTicket),
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
        state.connectedAt = Date.now();
        state.lastPongAt = state.connectedAt;
        state.connecting = false;
        stopSyncV2Fallback();
        state.reconcilePromise = Promise.resolve();
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
      const stopHeartbeat = heartbeatFor(socket);
      socket.addEventListener("message", (event) => {
        void handleMessage(socket, event, onEvent);
      });
      socket.addEventListener(
        "close",
        (event) => {
          stopHeartbeat();
          rememberRecent({
            type: "close",
            code: event.code,
            lifetimeMs: state.connectedAt
              ? Date.now() - state.connectedAt
              : null,
          });
          resolve("close");
        },
        { once: true }
      );
      socket.addEventListener(
        "error",
        () => {
          stopHeartbeat();
          resolve("error");
        },
        { once: true }
      );
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
    scheduleSyncV2Fallback({ signal, onEvent });
    recoveryCenter.handle(new Error("Broadcast connection closed."), {
      source: "broadcast",
      scope: { route: "broadcast" },
      retry: true,
      toast: false,
    });
    await sleep(backoff(attempt), signal);
    attempt += 1;
  }
  stopSyncV2Fallback();
}

export const broadcastClient = {
  connect: connectBroadcast,
  snapshot() {
    return {
      connected: state.connected,
      connecting: state.connecting,
      reconnects: state.reconnects,
      connectedAt: state.connectedAt,
      connectionLifetimeMs:
        state.connected && state.connectedAt
          ? Math.max(0, Date.now() - state.connectedAt)
          : null,
      lastPingAt: state.lastPingAt,
      lastPongAt: state.lastPongAt,
      lastPingLatencyMs: state.lastPingLatencyMs,
      lastEventId: state.lastEventId,
      lastAckedEventId: state.lastAckedEventId,
      lastError: state.lastError,
      fallbackActive: state.fallbackActive,
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
