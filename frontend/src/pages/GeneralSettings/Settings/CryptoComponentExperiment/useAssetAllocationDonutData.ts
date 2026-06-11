import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import { useCryptoHubWatchedConnection } from "@/hooks/cryptoHub/useCryptoHubWatchdog";
import { mockAssetAllocationItems } from "./assetAllocationMockData";
import type { AssetAllocationItem } from "./assetAllocationDonutTypes";

const GATE_ALLOCATION_ENDPOINT = `${API_BASE}/crypto-hub/allocation`;
const REAL_GATE_REFRESH_MS = 60_000;
const IMMEDIATE_RECONNECT_MS = 0;
const MAX_RECONNECT_MS = 30_000;

export type AssetAllocationDataMode = "mock" | "gate";

export type AssetAllocationGateStatus =
  | "idle"
  | "loading"
  | "connected"
  | "degraded"
  | "error";

type GateAllocationResponse = {
  success: boolean;
  totalValueUsd?: string;
  items?: AssetAllocationItem[];
  connectionStatus?: "connected" | "degraded" | "disconnected";
  safeErrorMessage?: string;
  partialFailures?: Array<{ source: string; message: string }>;
};

type UseAssetAllocationDonutDataOptions = {
  initialMode?: AssetAllocationDataMode;
  mockItems?: AssetAllocationItem[];
  mockTotalValueUsd?: string;
};

export function useAssetAllocationDonutData({
  initialMode = "mock",
  mockItems = mockAssetAllocationItems,
  mockTotalValueUsd = "52314.68",
}: UseAssetAllocationDonutDataOptions = {}) {
  const [useRealGateData, setUseRealGateData] = useState(
    initialMode === "gate"
  );
  const [gateItems, setGateItems] = useState<AssetAllocationItem[] | null>(
    null
  );
  const [gateTotalValueUsd, setGateTotalValueUsd] = useState<string | null>(
    null
  );
  const [gateStatus, setGateStatus] =
    useState<AssetAllocationGateStatus>("idle");
  const [gateStatusText, setGateStatusText] = useState("使用 mock 数据");
  const [gateRefreshNonce, setGateRefreshNonce] = useState(0);
  const gateReconnectAttemptRef = useRef(0);
  const hasGateItemsRef = useRef(false);

  useEffect(() => {
    hasGateItemsRef.current = Boolean(gateItems?.length);
  }, [gateItems]);

  const activeItems = useRealGateData && gateItems ? gateItems : mockItems;
  const activeTotalValueUsd =
    useRealGateData && gateTotalValueUsd
      ? gateTotalValueUsd
      : mockTotalValueUsd;

  const loadGateAllocation = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(GATE_ALLOCATION_ENDPOINT, {
        headers: baseHeaders(),
        signal,
      });
      const payload = (await response.json()) as GateAllocationResponse;
      if (signal?.aborted) return false;
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.safeErrorMessage || "真实 Gate 资产读取失败");
      }

      const nextItems = Array.isArray(payload.items) ? payload.items : [];
      if (!nextItems.length) {
        throw new Error("Gate API 已连接，但没有可展示的现货资产。");
      }

      gateReconnectAttemptRef.current = 0;
      setGateItems(nextItems);
      setGateTotalValueUsd(payload.totalValueUsd || "0");
      setUseRealGateData(true);
      setGateStatus(
        payload.connectionStatus === "degraded" ? "degraded" : "connected"
      );
      setGateStatusText(
        payload.connectionStatus === "degraded"
          ? `Gate 已连接，部分数据降级（${payload.partialFailures?.length || 0}）`
          : "Gate API Key 已连接，每 60s 刷新一次。"
      );
      return true;
    } catch (error) {
      if (signal?.aborted) return false;
      gateReconnectAttemptRef.current += 1;
      setGateStatus((current) =>
        hasGateItemsRef.current ||
        current === "connected" ||
        current === "degraded"
          ? "degraded"
          : "error"
      );
      setGateStatusText(
        error instanceof Error
          ? `连接中断，正在重连：${error.message}`
          : "连接中断，正在重连"
      );
      return false;
    }
  }, []);

  const connectRealGate = useCallback(() => {
    gateReconnectAttemptRef.current = 0;
    setGateStatus("loading");
    setGateStatusText("正在连接真实 Gate API...");
    setUseRealGateData(true);
    setGateRefreshNonce((current) => current + 1);
  }, []);

  const switchToMockData = useCallback(() => {
    setUseRealGateData(false);
    setGateStatus("idle");
    setGateStatusText("使用 mock 数据");
  }, []);

  useCryptoHubWatchedConnection({
    key: "allocation.rest",
    active: useRealGateData,
    status:
      gateStatus === "error" || gateStatus === "degraded"
        ? gateStatus
        : "connected",
    reconnect: connectRealGate,
  });

  useEffect(() => {
    if (!useRealGateData) return;

    let cancelled = false;
    let timer: number | null = null;
    let inFlight = false;
    let abortController: AbortController | null = null;

    function clearTimer() {
      if (timer) window.clearTimeout(timer);
      timer = null;
    }

    function reconnectDelay(wasSuccessful: boolean) {
      if (wasSuccessful) return REAL_GATE_REFRESH_MS;
      if (gateReconnectAttemptRef.current <= 1) return IMMEDIATE_RECONNECT_MS;
      return Math.min(
        MAX_RECONNECT_MS,
        2_000 * 2 ** Math.min(gateReconnectAttemptRef.current - 2, 4)
      );
    }

    async function run() {
      if (cancelled || inFlight) return;
      inFlight = true;
      abortController = new AbortController();
      const ok = await loadGateAllocation(abortController.signal);
      abortController = null;
      inFlight = false;
      if (cancelled) return;
      timer = window.setTimeout(run, reconnectDelay(ok));
    }

    run();

    return () => {
      cancelled = true;
      clearTimer();
      abortController?.abort();
    };
  }, [gateRefreshNonce, loadGateAllocation, useRealGateData]);

  return useMemo(
    () => ({
      activeItems,
      activeTotalValueUsd,
      connectRealGate,
      gateStatus,
      gateStatusText,
      useRealGateData,
      switchToMockData,
    }),
    [
      activeItems,
      activeTotalValueUsd,
      connectRealGate,
      gateStatus,
      gateStatusText,
      useRealGateData,
      switchToMockData,
    ]
  );
}
