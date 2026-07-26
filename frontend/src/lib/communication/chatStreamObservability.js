import { postJson } from "./apiClient";

const pending = [];
const activeTurns = new Map();
let flushTimer = null;
let longTaskObserver = null;
let visibilityListenerInstalled = false;

function platform() {
  return window.matchMedia?.("(max-width: 768px)")?.matches
    ? "mobile_web"
    : "desktop_web";
}

function visibility() {
  return document.hidden ? "hidden" : "visible";
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushChatStreamObservations();
  }, 2_000);
}

export function recordChatStreamObservation(observation = {}) {
  if (typeof window === "undefined") return;
  pending.push({
    event: observation.event,
    clientTurnId: String(observation.clientTurnId || "").slice(0, 160),
    requestId: String(
      observation.requestId ||
        activeTurns.get(observation.clientTurnId)?.requestId ||
        ""
    ).slice(0, 160),
    durationMs: Math.max(
      0,
      Math.min(Number(observation.durationMs) || 0, 60_000)
    ),
    outcome: observation.outcome || "observed",
    platform: platform(),
    visibility: visibility(),
  });
  if (pending.length >= 20) {
    void flushChatStreamObservations();
  } else {
    scheduleFlush();
  }
}

export async function flushChatStreamObservations() {
  if (!pending.length) return;
  const observations = pending.splice(0, 20);
  try {
    await postJson(
      "/operations/client-chat-observations",
      { observations },
      {
        communicationScene: "chat-client-observability",
        task: false,
        timeoutMs: 5_000,
      }
    );
  } catch {
    // Client telemetry is best-effort and must never interfere with chat.
  }
  if (pending.length) scheduleFlush();
}

function ensureVisibilityListener() {
  if (visibilityListenerInstalled) return;
  visibilityListenerInstalled = true;
  document.addEventListener("visibilitychange", () => {
    for (const [clientTurnId, state] of activeTurns.entries()) {
      recordChatStreamObservation({
        event: "visibility_changed",
        clientTurnId,
      });
      if (document.hidden) {
        if (state.stallTimer) clearTimeout(state.stallTimer);
        state.stallTimer = null;
        state.unpaintedSince = 0;
      } else if (state.latestRevision > state.lastPaintedRevision) {
        state.latestReceivedAt = now();
        state.unpaintedSince = state.latestReceivedAt;
        armStallTimer(clientTurnId, state);
      }
    }
    if (document.hidden) void flushChatStreamObservations();
  });
  window.addEventListener("pagehide", () => {
    void flushChatStreamObservations();
  });
}

function ensureLongTaskObserver() {
  if (longTaskObserver || typeof PerformanceObserver === "undefined") return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      const threshold = platform() === "mobile_web" ? 120 : 80;
      for (const entry of list.getEntries()) {
        if (entry.duration < threshold) continue;
        for (const clientTurnId of activeTurns.keys()) {
          recordChatStreamObservation({
            event: "scroll_jank",
            clientTurnId,
            durationMs: entry.duration,
            outcome: "stalled",
          });
        }
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    longTaskObserver = null;
  }
}

export function beginChatStreamObservation(clientTurnId) {
  if (!clientTurnId || typeof window === "undefined") return;
  activeTurns.set(clientTurnId, {
    firstChunkSeen: false,
    firstPaintSeen: false,
    latestRevision: 0,
    lastPaintedRevision: 0,
    lastLagReportedAt: 0,
    latestReceivedAt: 0,
    unpaintedSince: 0,
    requestId: "",
    stalled: false,
    stallTimer: null,
  });
  ensureVisibilityListener();
  ensureLongTaskObserver();
}

function armStallTimer(clientTurnId, state) {
  if (
    state.stallTimer ||
    state.stalled ||
    document.hidden ||
    !state.unpaintedSince ||
    !activeTurns.has(clientTurnId)
  ) {
    return;
  }
  state.stallTimer = window.setTimeout(() => {
    state.stallTimer = null;
    if (document.hidden || !activeTurns.has(clientTurnId)) return;
    state.stalled = true;
    recordChatStreamObservation({
      event: "stream_stalled",
      clientTurnId,
      durationMs: now() - state.unpaintedSince,
      outcome: "stalled",
    });
  }, 1_000);
}

export function updateChatStreamObservationRequestId(clientTurnId, requestId) {
  const state = activeTurns.get(clientTurnId);
  if (!state) return;
  state.requestId = String(requestId || "").slice(0, 160);
}

export function recordChatStreamRevision(clientTurnId, revision = 0) {
  const state = activeTurns.get(clientTurnId);
  if (!state) return;
  const receivedAt = now();
  state.latestRevision = Math.max(state.latestRevision, Number(revision) || 0);
  state.latestReceivedAt = receivedAt;
  if (!document.hidden && !state.unpaintedSince) {
    state.unpaintedSince = receivedAt;
  }
  if (!state.firstChunkSeen) {
    state.firstChunkSeen = true;
    recordChatStreamObservation({
      event: "first_chunk_received",
      clientTurnId,
    });
  }
  armStallTimer(clientTurnId, state);
}

export function recordChatStreamPaint(clientTurnId, revision = 0) {
  const state = activeTurns.get(clientTurnId);
  if (!state || !state.latestReceivedAt) return;
  if (revision && revision < state.latestRevision) return;
  const paintedAt = now();
  const durationMs = paintedAt - state.latestReceivedAt;
  const backlogDurationMs = state.unpaintedSince
    ? paintedAt - state.unpaintedSince
    : durationMs;
  state.lastPaintedRevision = Math.max(
    state.lastPaintedRevision,
    Number(revision) || state.latestRevision
  );
  if (!state.firstPaintSeen || paintedAt - state.lastLagReportedAt >= 1_000) {
    recordChatStreamObservation({
      event: state.firstPaintSeen ? "revision_lag" : "first_content_painted",
      clientTurnId,
      durationMs,
    });
    state.lastLagReportedAt = paintedAt;
  }
  state.firstPaintSeen = true;
  if (state.stallTimer) {
    clearTimeout(state.stallTimer);
    state.stallTimer = null;
  }
  if (state.stalled) {
    state.stalled = false;
    recordChatStreamObservation({
      event: "unpainted_backlog",
      clientTurnId,
      durationMs: backlogDurationMs,
      outcome: "recovered",
    });
    recordChatStreamObservation({
      event: "stream_recovered",
      clientTurnId,
      durationMs: backlogDurationMs,
      outcome: "recovered",
    });
  }
  state.unpaintedSince = 0;
}

export function recordChatStreamReconnect(clientTurnId, phase, attempt = 0) {
  recordChatStreamObservation({
    event:
      phase === "recovered"
        ? "reconnect_recovered"
        : phase === "failed"
          ? "reconnect_failed"
          : "reconnect_started",
    clientTurnId,
    durationMs: attempt,
    outcome:
      phase === "recovered"
        ? "recovered"
        : phase === "failed"
          ? "failed"
          : "observed",
  });
}

export function endChatStreamObservation(clientTurnId) {
  const state = activeTurns.get(clientTurnId);
  if (state?.stallTimer) clearTimeout(state.stallTimer);
  activeTurns.delete(clientTurnId);
  if (activeTurns.size === 0) {
    longTaskObserver?.disconnect();
    longTaskObserver = null;
  }
  void flushChatStreamObservations();
}
