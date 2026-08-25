import { useEffect, useRef, useState } from "react";
import { cryptoHubFetch } from "@/hooks/cryptoHub/useCryptoHubQuery";
import { streamDashboardSnapshot } from "@/lib/communication/crypto/cryptoHubStreamClient";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import type { AssetAllocationItem } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/assetAllocationDonutTypes";
import type { TradingPairDetailResponse } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/tradingPairDetailTypes";

export type CryptoPortfolioSource =
  | "gate"
  | "supplemental"
  | "mixed"
  | "gate_reconciliation";

export type ConsolidatedPortfolioItem = AssetAllocationItem & {
  totalAmount: string;
  source: CryptoPortfolioSource;
  gate: {
    quantity: string;
    valueUsd: string;
    holdingSources: string[];
  };
  supplemental: {
    quantity: string;
    valueUsd: string;
    costBasisUsd: string;
  };
};

export type PortfolioRiskAlert = {
  id: string;
  rule: string;
  severity: "warning" | "critical";
  title: string;
  message: string;
  evidence?: Record<string, unknown>;
};

export type PortfolioRiskSnapshot = {
  asOf: number;
  level: "safe" | "watch" | "danger";
  score: number;
  metrics: {
    largestAsset: string | null;
    largestAssetPct: number | null;
    stablecoinPct: number;
    portfolioValueUsd: number;
    futuresNotionalUsd: number;
    futuresToPortfolioPct: number | null;
    accountInitialMarginUsd: number;
    accountMaintenanceMarginUsd: number;
    crossAvailableUsd: number;
    marginPressurePct: number | null;
    minLiquidationDistancePct: number | null;
    liquidationReferenceOnly: boolean;
    maxDrawdownPct: number;
    currentDrawdownPct: number;
    dataAgeMs: number;
  };
  breakdown: Record<string, "safe" | "watch" | "danger" | "unavailable">;
  alerts: PortfolioRiskAlert[];
  guidance: {
    crossMargin: string;
    modelGenerated: false;
    readOnly: true;
  };
};

export type CryptoDashboardSnapshot = {
  success: true;
  asOf: number;
  readOnly: true;
  accountScoped: true;
  connectionStatus: "connected" | "degraded" | "disconnected";
  portfolio: {
    asOf: number;
    quoteAsset: "USD";
    gate: {
      totalValueUsd: string;
      allocatedValueUsd: string;
      reconciliationUsd: string;
      authority: "gate_read_only";
    };
    supplemental: {
      totalValueUsd: string;
      costBasisUsd: string;
      authority: "user_supplied_portfolio_layer";
      includedInGateHistory: false;
      unpricedSymbols: string[];
    };
    totalValueUsd: string;
    items: ConsolidatedPortfolioItem[];
    invariant: {
      itemTotalUsd: string;
      expectedTotalUsd: string;
      deltaUsd: string;
      valid: boolean;
    };
    connectionStatus: "connected" | "degraded";
  };
  risk: PortfolioRiskSnapshot;
  equityHistory: Record<string, any>;
  spotDetails: {
    BTC: TradingPairDetailResponse;
    ETH: TradingPairDetailResponse;
  };
  futures: Record<string, any>;
  sourcePolicy: {
    gate: "authoritative_real_account";
    supplemental: "user_supplied_current_portfolio_only";
    supplementalIncludedInPnl: false;
    supplementalIncludedInHistory: false;
  };
  cache?: { status: string; ageMs: number };
};

type DashboardStatus = "idle" | "loading" | "connected" | "error";

export function useCryptoDashboard({ enabled = true } = {}) {
  const [snapshot, setSnapshot] = useState<CryptoDashboardSnapshot | null>(
    null
  );
  const [status, setStatus] = useState<DashboardStatus>(
    enabled ? "loading" : "idle"
  );
  const [error, setError] = useState<string | null>(null);
  const latestAsOfRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    let acceptedStreamSnapshot = false;
    let fallbackStarted = false;
    let fallbackTimer: number | null = null;

    const acceptSnapshot = (next: unknown) => {
      const candidate = next as CryptoDashboardSnapshot;
      if (!candidate?.success || !candidate?.portfolio?.invariant) return;
      if (candidate.asOf < latestAsOfRef.current) return;
      latestAsOfRef.current = candidate.asOf;
      acceptedStreamSnapshot = true;
      setSnapshot(candidate);
      setStatus("connected");
      setError(null);
    };

    async function loadInitial() {
      if (fallbackStarted) return;
      fallbackStarted = true;
      setStatus((current) => (current === "connected" ? current : "loading"));
      try {
        const payload = await requestPriorityQueue.schedule(
          ({ signal }: { signal: AbortSignal }) =>
            cryptoHubFetch<CryptoDashboardSnapshot>("/dashboard-snapshot", {
              signal,
              communicationScene: "crypto-visible",
              task: false,
            }),
          {
            priority: "P1",
            label: "crypto:dashboard-snapshot",
            kind: "crypto",
            scope: { route: "crypto-center", surface: "dashboard" },
            policy: "visible",
            signal: controller.signal,
            dedupeKey: "crypto:dashboard-snapshot",
          }
        );
        if (!controller.signal.aborted) acceptSnapshot(payload);
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : "资产总览读取失败"
        );
        setStatus("error");
      }
    }

    streamDashboardSnapshot({
      signal: controller.signal,
      openWhenHidden: false,
      retryOnError: true,
      onData: acceptSnapshot,
      onError: (streamError: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          streamError instanceof Error
            ? streamError.message
            : "资产更新流已断开"
        );
        setStatus((current) => (current === "connected" ? current : "error"));
        void loadInitial();
      },
    }).catch((streamError: unknown) => {
      if (controller.signal.aborted) return;
      setError(
        streamError instanceof Error ? streamError.message : "资产更新流已断开"
      );
      setStatus((current) => (current === "connected" ? current : "error"));
      void loadInitial();
    });

    fallbackTimer = window.setTimeout(() => {
      if (!acceptedStreamSnapshot) void loadInitial();
    }, 3_500);

    return () => {
      controller.abort();
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
    };
  }, [enabled]);

  return { snapshot, status, error };
}
