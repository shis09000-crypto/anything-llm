import { useEffect, useRef, useState } from "react";
import { cryptoHubFetch } from "@/hooks/cryptoHub/useCryptoHubQuery";
import { useCryptoHubWatchedConnection } from "@/hooks/cryptoHub/useCryptoHubWatchdog";
import { streamOpenFuturesPositions } from "@/lib/communication/crypto/cryptoHubStreamClient";
import type {
  OpenFuturesPositionItem,
  OpenFuturesConnectionStatus,
  OpenFuturesPositionsResponse,
  OpenFuturesPositionsSummary,
} from "./openFuturesPositionsTypes";

type DataMode = "mock" | "gate-api";

const STREAM_RENDER_THROTTLE_MS = 500;
const STREAM_RECONNECT_MS = 1_500;

const emptySummary: OpenFuturesPositionsSummary = {
  totalUnrealizedPnlUsd: "0.00",
  weightedPnlPct: "0.00",
  totalMarginUsd: "0.00",
  accountEquityUsd: "0.00",
  marginRatioPct: "0.00",
};

function connectionStatusFromPayload(
  payload: OpenFuturesPositionsResponse
): OpenFuturesConnectionStatus {
  if (payload.safeErrorMessage) return "degraded";
  if (payload.connectionStatus) return payload.connectionStatus;
  if (payload.wsStatus === "connected") return "connected";
  if (payload.wsStatus === "connecting" || payload.wsStatus === "fallback") {
    return "degraded";
  }
  return "disconnected";
}

export function useOpenFuturesPositionsData({
  mode,
  mockPositions,
  mockSummary,
}: {
  mode: DataMode;
  mockPositions: OpenFuturesPositionItem[];
  mockSummary: OpenFuturesPositionsSummary;
}) {
  const [positions, setPositions] = useState(mockPositions);
  const [summary, setSummary] = useState(mockSummary);
  const [status, setStatus] =
    useState<OpenFuturesConnectionStatus>("connected");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(mode === "mock");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(() =>
    Date.now()
  );
  const [lastRestFetchAt, setLastRestFetchAt] = useState<number | null>(null);
  const [lastWsMessageAt, setLastWsMessageAt] = useState<number | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const shouldStreamRef = useRef(false);
  const pendingStreamPayloadRef = useRef<OpenFuturesPositionsResponse | null>(
    null
  );
  const streamFlushRafRef = useRef<number | null>(null);
  const streamFlushTimerRef = useRef<number | null>(null);
  const lastStreamFlushAtRef = useRef(0);

  function applyPayload(payload: OpenFuturesPositionsResponse) {
    setPositions(Array.isArray(payload.positions) ? payload.positions : []);
    setSummary(payload.summary || emptySummary);
    setLastUpdatedAt(payload.asOf || Date.now());
    setLastRestFetchAt(payload.lastRestFetchAt || null);
    setLastWsMessageAt(payload.lastWsMessageAt || null);
    setStatus(connectionStatusFromPayload(payload));
    setError(payload.safeErrorMessage || null);
  }

  function clearStreamRenderQueue() {
    pendingStreamPayloadRef.current = null;
    if (streamFlushRafRef.current !== null) {
      window.cancelAnimationFrame(streamFlushRafRef.current);
      streamFlushRafRef.current = null;
    }
    if (streamFlushTimerRef.current !== null) {
      window.clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
  }

  function flushStreamPayload() {
    streamFlushRafRef.current = null;
    streamFlushTimerRef.current = null;
    if (document.visibilityState === "hidden") return;

    const payload = pendingStreamPayloadRef.current;
    pendingStreamPayloadRef.current = null;
    if (!payload) return;
    applyPayload(payload);
    lastStreamFlushAtRef.current = Date.now();
  }

  function scheduleStreamPayload(payload: OpenFuturesPositionsResponse) {
    if (document.visibilityState === "hidden") return;
    pendingStreamPayloadRef.current = payload;
    if (streamFlushRafRef.current !== null) return;

    const elapsed = Date.now() - lastStreamFlushAtRef.current;
    const delay = Math.max(0, STREAM_RENDER_THROTTLE_MS - elapsed);
    if (delay > 0) {
      if (streamFlushTimerRef.current !== null) return;
      streamFlushTimerRef.current = window.setTimeout(() => {
        streamFlushTimerRef.current = null;
        streamFlushRafRef.current =
          window.requestAnimationFrame(flushStreamPayload);
      }, delay);
      return;
    }

    streamFlushRafRef.current =
      window.requestAnimationFrame(flushStreamPayload);
  }

  function clearReconnectTimer() {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  function stopStream({ keepIntent = false } = {}) {
    if (!keepIntent) shouldStreamRef.current = false;
    clearReconnectTimer();
    clearStreamRenderQueue();
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
  }

  function scheduleReconnect() {
    if (!shouldStreamRef.current || mode !== "gate-api") return;
    if (document.visibilityState === "hidden") return;
    if (reconnectTimerRef.current !== null) return;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      startStream();
    }, STREAM_RECONNECT_MS);
  }

  async function loadSnapshot() {
    if (mode !== "gate-api") return null;
    setLoading(true);
    try {
      const payload = await cryptoHubFetch<OpenFuturesPositionsResponse>(
        "/open-futures-positions"
      );

      applyPayload(payload);
      setHasLoadedOnce(true);
      return payload;
    } catch (requestError) {
      setStatus("disconnected");
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Gate futures positions request failed."
      );
      setHasLoadedOnce(true);
      return null;
    } finally {
      setLoading(false);
    }
  }

  function startStream() {
    if (mode !== "gate-api") return;
    if (document.visibilityState === "hidden") return;
    if (streamAbortRef.current) return;

    const controller = new AbortController();
    streamAbortRef.current = controller;
    shouldStreamRef.current = true;

    streamOpenFuturesPositions({
      signal: controller.signal,
      onData(payload: OpenFuturesPositionsResponse) {
        if (!payload) return;
        if (payload.success === false) {
          setStatus("disconnected");
          setError(
            payload.safeErrorMessage || "Gate futures positions stream failed."
          );
          return;
        }
        scheduleStreamPayload(payload);
      },
      onClose() {
        if (controller.signal.aborted) return;
        streamAbortRef.current = null;
        scheduleReconnect();
      },
      onError(error) {
        if (controller.signal.aborted) return;
        throw error;
      },
    }).catch(() => {
      if (controller.signal.aborted) return;
      streamAbortRef.current = null;
      scheduleReconnect();
    });
  }

  async function refresh() {
    if (mode === "mock") {
      setPositions(mockPositions);
      setSummary(mockSummary);
      setStatus("connected");
      setError(null);
      setLastUpdatedAt(Date.now());
      setLastRestFetchAt(null);
      setLastWsMessageAt(null);
      return;
    }

    await loadSnapshot();
  }

  function forceHubWatchdogReconnect() {
    if (mode !== "gate-api") return;
    stopStream({ keepIntent: true });
    loadSnapshot().then(() => startStream());
  }

  useCryptoHubWatchedConnection({
    key: "openFuturesPositions.stream",
    active: mode === "gate-api",
    status,
    lastConnectedAt: lastUpdatedAt,
    reconnect: forceHubWatchdogReconnect,
  });

  useEffect(() => {
    stopStream();
    setError(null);

    if (mode === "mock") {
      setLoading(false);
      setHasLoadedOnce(true);
      setPositions(mockPositions);
      setSummary(mockSummary);
      setStatus("connected");
      setLastUpdatedAt(Date.now());
      setLastRestFetchAt(null);
      setLastWsMessageAt(null);
      return;
    }

    shouldStreamRef.current = true;
    setHasLoadedOnce(false);
    setPositions([]);
    setSummary(emptySummary);
    loadSnapshot().then(() => startStream());
  }, [mode, mockPositions, mockSummary]);

  useEffect(() => {
    return () => stopStream();
  }, []);

  useEffect(() => {
    if (mode !== "gate-api") return;

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        stopStream({ keepIntent: true });
        return;
      }
      loadSnapshot().then(() => startStream());
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [mode]);

  return {
    positions,
    summary,
    status,
    error,
    loading,
    hasLoadedOnce,
    lastUpdatedAt,
    lastRestFetchAt,
    lastWsMessageAt,
    refresh,
  };
}
