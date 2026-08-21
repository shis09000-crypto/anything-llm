import { useCallback, useEffect, useRef, useState } from "react";
import { cryptoHubFetch } from "@/hooks/cryptoHub/useCryptoHubQuery";
import { useCryptoHubWatchedConnection } from "@/hooks/cryptoHub/useCryptoHubWatchdog";
import type {
  TradingPairDataMode,
  TradingPairDetailResponse,
  TradingPairMarketType,
} from "./tradingPairDetailTypes";

const DETAIL_VISIBLE_REFRESH_MS = 30_000;
const DETAIL_HIDDEN_REFRESH_MS = 120_000;
const DETAIL_MAX_RETRY_MS = 60_000;

export function useTradingPairDetailData({
  mode,
  pair,
  market,
  enabled = true,
}: {
  mode: TradingPairDataMode;
  pair: string;
  market: TradingPairMarketType;
  enabled?: boolean;
}) {
  const [response, setResponse] = useState<TradingPairDetailResponse | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [watchdogRefreshNonce, setWatchdogRefreshNonce] = useState(0);
  const lastAsOfRef = useRef<number | null>(null);
  const failureCountRef = useRef(0);

  const clear = useCallback(() => {
    setResponse(null);
    setError(null);
    setLoading(false);
    setHasLoadedOnce(false);
    setReconnectAttempt(0);
    failureCountRef.current = 0;
    lastAsOfRef.current = null;
  }, []);

  useCryptoHubWatchedConnection({
    key: `tradingPairDetail.rest.${market}.${pair}`,
    active: enabled && mode === "gate-api" && market === "spot",
    status: error ? "error" : response?.connectionStatus || "connected",
    lastConnectedAt: response?.asOf || null,
    reconnect: () => setWatchdogRefreshNonce((current) => current + 1),
  });

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    if (mode !== "gate-api" || market !== "spot") {
      setError(null);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    async function loadDetail() {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          pair,
          market: "spot",
        });
        const payload = await cryptoHubFetch<TradingPairDetailResponse>(
          `/trading-pair-detail?${params.toString()}`,
          { communicationScene: "crypto-visible" }
        );
        if (!payload?.success) {
          throw new Error(payload?.safeErrorMessage || "交易对详情读取失败");
        }
        if (cancelled) return;
        failureCountRef.current = 0;
        setReconnectAttempt(0);
        setError(null);
        setHasLoadedOnce(true);
        if (lastAsOfRef.current === payload.asOf) return true;
        lastAsOfRef.current = payload.asOf;
        setResponse(payload);
        return true;
      } catch (requestError) {
        if (cancelled) return;
        failureCountRef.current += 1;
        setReconnectAttempt(failureCountRef.current);
        setError(
          requestError instanceof Error
            ? requestError.message
            : "交易对详情读取失败"
        );
        setHasLoadedOnce(true);
        return false;
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    function nextDelay(wasSuccessful = true) {
      const hidden = document.visibilityState === "hidden";
      if (hidden) return DETAIL_HIDDEN_REFRESH_MS;
      if (wasSuccessful) return DETAIL_VISIBLE_REFRESH_MS;
      return Math.min(
        DETAIL_MAX_RETRY_MS,
        2_000 * 2 ** Math.min(failureCountRef.current, 4)
      );
    }

    function schedule(wasSuccessful = true) {
      const delay = nextDelay(wasSuccessful);
      timer = window.setTimeout(async () => {
        const ok = await loadDetail();
        if (!cancelled) schedule(Boolean(ok));
      }, delay);
    }

    loadDetail();
    schedule();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled, mode, market, pair, watchdogRefreshNonce]);

  return {
    response,
    error,
    loading,
    hasLoadedOnce,
    reconnectAttempt,
    clear,
  };
}
