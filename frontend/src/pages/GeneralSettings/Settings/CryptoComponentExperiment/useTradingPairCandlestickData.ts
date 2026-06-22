import { useEffect, useRef, useState } from "react";
import { cryptoHubFetch } from "@/hooks/cryptoHub/useCryptoHubQuery";
import { useCryptoHubWatchedConnection } from "@/hooks/cryptoHub/useCryptoHubWatchdog";
import { streamMarketCandles } from "@/lib/communication/crypto/cryptoHubStreamClient";
import { generateMockCandles } from "./tradingPairMockCandles";
import type {
  TradingPairCandle,
  TradingPairCandlesResponse,
  TradingPairCandlesStreamEvent,
  TradingPairCandlestickRange,
  TradingPairVisibleWindow,
} from "./tradingPairCandlestickTypes";
import type {
  TradingPairConnectionStatus,
  TradingPairDataMode,
  TradingPairMarketType,
} from "./tradingPairDetailTypes";

const MAX_CACHED_CANDLES = 720;
const STREAM_RENDER_THROTTLE_MS = 250;
const STREAM_RECONNECT_MS = 1_500;

type CandleCache = Record<string, TradingPairCandle[]>;
type CandleDirection = "initial" | "history" | "snapshot";

function cacheKey({
  pair,
  range,
  market,
}: {
  pair: string;
  range: TradingPairCandlestickRange;
  market: TradingPairMarketType;
}) {
  return `${pair}:${range}:${market}`;
}

function viewKey({
  mode,
  pair,
  range,
  market,
}: {
  mode: TradingPairDataMode;
  pair: string;
  range: TradingPairCandlestickRange;
  market: TradingPairMarketType;
}) {
  return `${mode}:${cacheKey({ pair, range, market })}`;
}

function cropCandlesAroundWindow(
  candles: TradingPairCandle[],
  keep: "older" | "newer",
  visibleWindow?: TradingPairVisibleWindow | null
) {
  if (candles.length <= MAX_CACHED_CANDLES) return candles;

  if (visibleWindow?.visibleStartTs && visibleWindow?.visibleEndTs) {
    let startIndex = candles.findIndex(
      (candle) => candle.ts >= Number(visibleWindow.visibleStartTs)
    );
    if (startIndex < 0) startIndex = 0;

    let endIndex = -1;
    for (let index = candles.length - 1; index >= 0; index -= 1) {
      if (candles[index].ts <= Number(visibleWindow.visibleEndTs)) {
        endIndex = index;
        break;
      }
    }

    if (endIndex >= startIndex) {
      const center = (startIndex + endIndex) / 2;
      const sliceStart = Math.max(
        0,
        Math.min(
          candles.length - MAX_CACHED_CANDLES,
          Math.round(center - MAX_CACHED_CANDLES / 2)
        )
      );
      return candles.slice(sliceStart, sliceStart + MAX_CACHED_CANDLES);
    }
  }

  return keep === "older"
    ? candles.slice(0, MAX_CACHED_CANDLES)
    : candles.slice(-MAX_CACHED_CANDLES);
}

function mergeCandles(
  current: TradingPairCandle[],
  incoming: TradingPairCandle[],
  keep: "older" | "newer",
  visibleWindow?: TradingPairVisibleWindow | null
) {
  const byTs = new Map<number, TradingPairCandle>();
  for (const candle of current) byTs.set(candle.ts, candle);
  for (const candle of incoming) byTs.set(candle.ts, candle);

  const merged = Array.from(byTs.values()).sort(
    (left, right) => left.ts - right.ts
  );
  return cropCandlesAroundWindow(merged, keep, visibleWindow);
}

function latestPrice(candles: TradingPairCandle[], fallback: string) {
  return candles[candles.length - 1]?.close || fallback;
}

function relativeChange(candles: TradingPairCandle[], fallback: string) {
  const first = Number(candles[0]?.open);
  const last = Number(candles[candles.length - 1]?.close);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) {
    return fallback;
  }
  return (((last - first) / first) * 100).toFixed(2);
}

function connectionStatusFromStream(
  payload: TradingPairCandlesStreamEvent
): TradingPairConnectionStatus {
  if (payload.lastError) return "degraded";
  if (payload.wsStatus === "connected") return "connected";
  if (payload.wsStatus === "fallback" || payload.wsStatus === "connecting") {
    return "degraded";
  }
  return "disconnected";
}

export function useTradingPairCandlestickData({
  mode,
  pair,
  range,
  market,
  currentPriceFallback,
  change24hPctFallback,
}: {
  mode: TradingPairDataMode;
  pair: string;
  range: TradingPairCandlestickRange;
  market: TradingPairMarketType;
  currentPriceFallback: string;
  change24hPctFallback: string;
}) {
  const [cache, setCache] = useState<CandleCache>({});
  const [mockCache, setMockCache] = useState<CandleCache>({});
  const [apiMeta, setApiMeta] = useState<TradingPairCandlesResponse | null>(
    null
  );
  const [status, setStatus] =
    useState<TradingPairConnectionStatus>("connected");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [readyViewKey, setReadyViewKey] = useState<string | null>(null);
  const [initialLoadingViewKey, setInitialLoadingViewKey] = useState<
    string | null
  >(null);
  const historyLoadingRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamReconnectTimerRef = useRef<number | null>(null);
  const streamShouldRunRef = useRef(false);
  const pendingStreamPayloadRef = useRef<TradingPairCandlesStreamEvent | null>(
    null
  );
  const streamFlushRafRef = useRef<number | null>(null);
  const streamFlushTimerRef = useRef<number | null>(null);
  const lastStreamFlushAtRef = useRef(0);
  const lastAppliedSnapshotAtRef = useRef<number | null>(null);

  const activeKey = cacheKey({ pair, range, market });
  const activeViewKey = viewKey({ mode, pair, range, market });
  const activeViewKeyRef = useRef(activeViewKey);

  useEffect(() => {
    activeViewKeyRef.current = activeViewKey;
  }, [activeViewKey]);

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

  function clearStreamReconnectTimer() {
    if (streamReconnectTimerRef.current !== null) {
      window.clearTimeout(streamReconnectTimerRef.current);
      streamReconnectTimerRef.current = null;
    }
  }

  function stopGateStream({ keepIntent = false } = {}) {
    if (!keepIntent) streamShouldRunRef.current = false;
    clearStreamReconnectTimer();
    clearStreamRenderQueue();
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
  }

  function flushStreamPayload() {
    streamFlushRafRef.current = null;
    streamFlushTimerRef.current = null;
    if (document.visibilityState === "hidden") return;

    const payload = pendingStreamPayloadRef.current;
    pendingStreamPayloadRef.current = null;
    if (!payload) return;
    if (
      payload.gateCurrencyPair &&
      payload.gateCurrencyPair !== pair.toUpperCase()
    ) {
      return;
    }
    if (payload.range && payload.range !== range) return;
    if (payload.marketType && payload.marketType !== market) return;

    const snapshotAt = payload.latestSnapshotAt || null;
    if (snapshotAt && snapshotAt === lastAppliedSnapshotAtRef.current) return;
    if (snapshotAt) lastAppliedSnapshotAtRef.current = snapshotAt;

    const incoming = Array.isArray(payload.candles) ? payload.candles : [];
    if (incoming.length) {
      setCache((current) => ({
        ...current,
        [activeKey]: mergeCandles(current[activeKey] || [], incoming, "newer"),
      }));
    }

    setApiMeta((current) => ({
      ...(current || {
        success: true,
        asOf: Date.now(),
        exchange: "gate",
        marketType: market,
        gateCurrencyPair: pair,
        range,
      }),
      asOf: Date.now(),
      candles: incoming,
      currentPriceQuote:
        payload.currentPriceQuote || current?.currentPriceQuote || null,
      change24hPct: payload.change24hPct || current?.change24hPct || null,
      latestSnapshotAt: snapshotAt,
      lastUpdatedAt: payload.lastUpdatedAt || null,
      wsStatus: payload.wsStatus || null,
      restStatus: payload.restStatus || null,
      lastRestFetchAt: payload.lastRestFetchAt || null,
      lastWsMessageAt: payload.lastWsMessageAt || null,
      subscriberCount: payload.subscriberCount || null,
      connectionStatus: connectionStatusFromStream(payload),
    }));
    setStatus(connectionStatusFromStream(payload));
    if (!payload.lastError) setError(null);
    lastStreamFlushAtRef.current = Date.now();
  }

  function scheduleStreamPayload(payload: TradingPairCandlesStreamEvent) {
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

  function startGateStream() {
    if (mode !== "gate-api" || market !== "spot") return;
    if (document.visibilityState === "hidden") return;
    if (streamAbortRef.current) return;

    const controller = new AbortController();
    streamAbortRef.current = controller;
    streamShouldRunRef.current = true;

    streamMarketCandles({
      pair,
      range,
      market,
      signal: controller.signal,
      onData(payload: TradingPairCandlesStreamEvent) {
        if (payload) scheduleStreamPayload(payload);
      },
      onClose() {
        if (controller.signal.aborted) return;
        streamAbortRef.current = null;
        scheduleGateStreamReconnect();
      },
      onError(error) {
        if (controller.signal.aborted) return;
        throw error;
      },
    }).catch(() => {
      if (controller.signal.aborted) return;
      streamAbortRef.current = null;
      scheduleGateStreamReconnect();
    });
  }

  function scheduleGateStreamReconnect() {
    if (
      !streamShouldRunRef.current ||
      mode !== "gate-api" ||
      market !== "spot"
    ) {
      return;
    }
    if (document.visibilityState === "hidden") return;
    if (streamReconnectTimerRef.current !== null) return;
    streamReconnectTimerRef.current = window.setTimeout(() => {
      streamReconnectTimerRef.current = null;
      restartGateRealtime("snapshot");
    }, STREAM_RECONNECT_MS);
  }

  useCryptoHubWatchedConnection({
    key: `marketCandles.stream.${market}.${pair}.${range}`,
    active: mode === "gate-api" && market === "spot",
    status,
    lastConnectedAt: apiMeta?.asOf || null,
    reconnect: () => restartGateRealtime("snapshot"),
  });

  const initialLoadingActive =
    loading && initialLoadingViewKey === activeViewKey;
  const activeCandles =
    readyViewKey === activeViewKey && !initialLoadingActive
      ? mode === "mock"
        ? mockCache[activeKey] || []
        : cache[activeKey] || []
      : [];
  const currentPriceQuote =
    mode === "mock"
      ? latestPrice(activeCandles, currentPriceFallback)
      : apiMeta?.currentPriceQuote ||
        latestPrice(activeCandles, currentPriceFallback);
  const change24hPct =
    mode === "mock"
      ? relativeChange(activeCandles, change24hPctFallback)
      : apiMeta?.change24hPct ||
        relativeChange(activeCandles, change24hPctFallback);

  async function loadMockHistory(
    beforeTs: number,
    visibleWindow: TradingPairVisibleWindow
  ) {
    if (historyLoadingRef.current) return;
    historyLoadingRef.current = true;
    setHistoryLoading(true);

    try {
      const incoming = generateMockCandles({
        pair,
        range,
        currentPrice: currentPriceFallback,
        beforeTs,
      });
      setMockCache((current) => ({
        ...current,
        [activeKey]: mergeCandles(
          current[activeKey] || [],
          incoming,
          "older",
          visibleWindow
        ),
      }));
      setReadyViewKey(activeViewKey);
      setStatus("connected");
      setError(null);
    } finally {
      setHistoryLoading(false);
      historyLoadingRef.current = false;
    }
  }

  async function loadCandles(
    direction: CandleDirection,
    options: {
      beforeTs?: number;
      visibleWindow?: TradingPairVisibleWindow;
    } = {}
  ) {
    if (mode !== "gate-api") return null;
    const requestKey = activeKey;
    const requestViewKey = activeViewKey;
    const requestPair = pair;
    const requestRange = range;
    const requestMarket = market;

    if (market !== "spot") {
      setStatus("degraded");
      setError(
        "第一版真实 K 线仅支持 Gate spot；futures/margin 暂不请求后端。"
      );
      setLoading(false);
      setInitialLoadingViewKey(null);
      setReadyViewKey(requestViewKey);
      return null;
    }

    const currentCandles = cache[requestKey] || [];
    if (direction === "history") {
      const beforeTs = options.beforeTs || currentCandles[0]?.ts;
      if (historyLoadingRef.current || !beforeTs) return null;
      historyLoadingRef.current = true;
      setHistoryLoading(true);
    } else if (direction === "initial") {
      setLoading(true);
      setReadyViewKey(null);
      setInitialLoadingViewKey(requestViewKey);
      setCache((current) => ({ ...current, [requestKey]: [] }));
    }

    try {
      const params = new URLSearchParams({
        pair: requestPair,
        range: requestRange,
        market: requestMarket,
      });
      if (direction === "history") {
        params.set(
          "beforeTs",
          String(options.beforeTs || currentCandles[0]?.ts)
        );
      }

      const payload = await cryptoHubFetch<TradingPairCandlesResponse>(
        `/market-candles?${params.toString()}`
      );

      const incoming = Array.isArray(payload.candles) ? payload.candles : [];
      setCache((current) => ({
        ...current,
        [requestKey]: mergeCandles(
          current[requestKey] || [],
          incoming,
          direction === "history" ? "older" : "newer",
          options.visibleWindow
        ),
      }));

      if (activeViewKeyRef.current === requestViewKey) {
        setApiMeta(payload);
        setStatus(payload.partialFailures?.length ? "degraded" : "connected");
        setError(null);
        setReadyViewKey(requestViewKey);
        lastAppliedSnapshotAtRef.current =
          payload.latestSnapshotAt || payload.cache?.latestSnapshotAt || null;
      }
      return payload;
    } catch (requestError) {
      if (activeViewKeyRef.current === requestViewKey) {
        setStatus("disconnected");
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Gate candles request failed."
        );
      }
      return null;
    } finally {
      setLoading(false);
      setHistoryLoading(false);
      setInitialLoadingViewKey((current) =>
        current === requestViewKey ? null : current
      );
      historyLoadingRef.current = false;
    }
  }

  async function restartGateRealtime(direction: "initial" | "snapshot") {
    if (mode !== "gate-api" || market !== "spot") return;
    if (document.visibilityState === "hidden") return;

    stopGateStream({ keepIntent: true });
    streamShouldRunRef.current = true;
    const payload = await loadCandles(direction);
    if (!payload || activeViewKeyRef.current !== activeViewKey) return;
    startGateStream();
  }

  async function loadMoreHistory(
    beforeTs: number,
    visibleWindow: TradingPairVisibleWindow
  ) {
    if (mode === "mock") {
      await loadMockHistory(beforeTs, visibleWindow);
      return;
    }

    await loadCandles("history", { beforeTs, visibleWindow });
  }

  useEffect(() => {
    stopGateStream();
    lastAppliedSnapshotAtRef.current = null;
    setError(null);
    setApiMeta(null);
    setReadyViewKey(null);
    setInitialLoadingViewKey(activeViewKey);
    historyLoadingRef.current = false;
    setHistoryLoading(false);

    if (mode === "mock") {
      setLoading(false);
      setStatus("connected");
      setMockCache((current) => ({
        ...current,
        [activeKey]: generateMockCandles({
          pair,
          range,
          currentPrice: currentPriceFallback,
        }),
      }));
      setReadyViewKey(activeViewKey);
      setInitialLoadingViewKey(null);
      return;
    }

    if (market !== "spot") {
      loadCandles("initial");
      return;
    }

    restartGateRealtime("initial");
  }, [
    mode,
    pair,
    range,
    market,
    activeKey,
    activeViewKey,
    currentPriceFallback,
  ]);

  useEffect(() => {
    return () => stopGateStream();
  }, []);

  useEffect(() => {
    if (mode !== "gate-api" || market !== "spot") return;

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        stopGateStream({ keepIntent: true });
        return;
      }
      restartGateRealtime("snapshot");
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [mode, pair, range, market, activeKey, activeViewKey]);

  return {
    activeCandles,
    apiMeta,
    currentPriceQuote,
    change24hPct,
    status,
    error,
    loading,
    historyLoading,
    loadMoreHistory,
  };
}
