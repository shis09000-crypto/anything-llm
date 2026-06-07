import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import type {
  TradingPairDataMode,
  TradingPairDetailResponse,
  TradingPairMarketType,
} from "./tradingPairDetailTypes";

const DETAIL_ENDPOINT = `${API_BASE}/crypto/gate/trading-pair/detail`;

export function useTradingPairDetailData({
  mode,
  pair,
  market,
}: {
  mode: TradingPairDataMode;
  pair: string;
  market: TradingPairMarketType;
}) {
  const [response, setResponse] = useState<TradingPairDetailResponse | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const lastAsOfRef = useRef<number | null>(null);
  const failureCountRef = useRef(0);

  const clear = useCallback(() => {
    setResponse(null);
    setError(null);
    setReconnectAttempt(0);
    failureCountRef.current = 0;
    lastAsOfRef.current = null;
  }, []);

  useEffect(() => {
    if (mode !== "gate-api" || market !== "spot") {
      setError(null);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    async function loadDetail() {
      try {
        const params = new URLSearchParams({
          pair,
          market: "spot",
        });
        const apiResponse = await fetch(
          `${DETAIL_ENDPOINT}?${params.toString()}`,
          { headers: baseHeaders() }
        );
        const payload = (await apiResponse.json()) as TradingPairDetailResponse;
        if (!apiResponse.ok || !payload?.success) {
          throw new Error(payload?.safeErrorMessage || "交易对详情读取失败");
        }
        if (cancelled) return;
        failureCountRef.current = 0;
        setReconnectAttempt(0);
        setError(null);
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
        return false;
      }
    }

    function nextDelay(wasSuccessful = true) {
      const hidden = document.visibilityState === "hidden";
      if (hidden) return 30_000;
      if (wasSuccessful) return 5_000;
      return Math.min(
        30_000,
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
  }, [mode, market, pair]);

  return {
    response,
    error,
    reconnectAttempt,
    clear,
  };
}
