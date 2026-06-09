import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import { useMotion } from "@/contexts/MotionProvider";
import AssetAllocationDonutCard from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/AssetAllocationDonutCard";
import CryptoTotalAssetCard from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/CryptoTotalAssetCard";
import OpenFuturesPositionsCard from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/OpenFuturesPositionsCard";
import TradeRecordsTable from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/TradeRecordsTable";
import TradingPairDetailCard from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/TradingPairDetailCard";
import TradingPairCandlestickChart from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/TradingPairCandlestickChart";
import {
  mockOpenFuturesPositions,
  mockOpenFuturesSummary,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/openFuturesPositionsMockData";
import {
  presetById,
  tradingPairMockPresets,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/tradingPairMockPresets";
import { useTradingPairCandlestickData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useTradingPairCandlestickData";
import { useAssetAllocationDonutData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useAssetAllocationDonutData";
import { useOpenFuturesPositionsData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useOpenFuturesPositionsData";
import { useTradeRecordsTableController } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useTradeRecordsTableController";
import { useTradingPairDetailData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useTradingPairDetailData";
import type { AssetAllocationDonutCardProps } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/assetAllocationDonutTypes";
import type {
  CryptoTotalAssetCardProps,
  CryptoTrendPoint,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/cryptoTotalAssetTypes";
import type { OpenFuturesPositionsCardProps } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/openFuturesPositionsTypes";
import type { TradingPairCandlestickRange } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/tradingPairCandlestickTypes";
import type {
  TradingPairDetailCardProps,
  TradingPairDetailResponse,
  TradingPairMarketType,
  TradingPairPreset,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/tradingPairDetailTypes";

const CRYPTO_CENTER_BACKGROUND_URL =
  "/crypto-center-backgrounds/crypto-center-background.png";
const FIXED_YESTERDAY_BASELINE_USD = 51685.38;
const BTC_PAIR = "BTC_USDT";
const BTC_MARKET = "spot";
const btcPreset = presetById(BTC_PAIR);
const ETH_PAIR = "ETH_USDT";
const ETH_MARKET = "spot";
const ETH_CHART_BACKGROUND_URL = "/crypto-chart-backgrounds/eth-background.png";
const ethPreset = presetById(ETH_PAIR);
const BTC_SPOT_DETAIL_CARD_WIDTH = 480;
const BTC_SPOT_CARD_HEIGHT = 560;
const BTC_SPOT_CHART_MAX_WIDTH = 720;
const BTC_SPOT_CONTENT_MAX_WIDTH = 1224;
const HERO_TOTAL_ASSET_CARD_WIDTH = 640;
const HERO_ASSET_ALLOCATION_CARD_WIDTH = 560;
const HERO_PORTFOLIO_CARD_HEIGHT = 380;
const TOP_SPOT_ASSET_LIMIT = 6;
const TOP_SPOT_EXCLUDED_ASSETS = ["BTC", "ETH", "USDT", "GUSD"];
const TOP_SPOT_CARD_HEIGHT = 560;
const TOP_SPOT_CARD_GAP = 24;
const TOP_SPOT_REORDER_DURATION_MS = 360;
const TOP_SPOT_MIN_TWO_COLUMN_WIDTH = 760;
const OPEN_FUTURES_POSITIONS_CARD_HEIGHT = 645;
const OPEN_FUTURES_VISIBLE_POSITION_COUNT = 6;
const TRADE_RECORDS_CARD_HEIGHT = 680;

const btcDetailVisual = {
  cardWidth: BTC_SPOT_DETAIL_CARD_WIDTH,
  cardHeight: BTC_SPOT_CARD_HEIGHT,
  borderRadius: 28,
  glowIntensity: 0.75,
  iconSize: 62,
  iconCropScale: 1.21,
  iconCropX: 0,
  iconCropY: 0,
  showUsdEstimate: true,
  showMarketBadge: true,
  showInfoIcons: true,
  compactMode: false,
};

const btcCandlestickVisual = {
  cardHeight: BTC_SPOT_CARD_HEIGHT,
  borderRadius: 24,
  glowIntensity: 0.72,
  accentColor: "#D6A84F",
  iconSize: 62,
  iconCropScale: 1.21,
  iconCropX: 0,
  iconCropY: 0,
  showVolume: true,
  showCrosshair: true,
  showCurrentPriceLine: true,
  showGrid: true,
  compactMode: true,
};

type GateEquityMode = "api_total" | "net_equity" | "account_sum";

type GateEquityHistory = {
  historyVersion: number;
  latestPointTs: number | null;
  incremental?: boolean;
  latestEquityUsd: number;
  todayPnlUsd: number;
  todayPnlPct: number;
  yesterdayBaselineUsd: number;
  yesterdayChangePct: number;
  lastUpdatedAt: string | null;
  lastUpdatedDate?: string | null;
  freshness?: {
    latestSnapshotAt: number | null;
    lastError?: string | null;
  };
  points: CryptoTrendPoint[];
};

type TopSpotAsset = {
  pair: string;
  baseAsset: string;
  quoteAsset: string;
  symbol: string;
  holdingAmountBase: string;
  holdingValueQuote: string;
  holdingValueUsd?: string | null;
  currentPriceQuote: string;
  change24hPct?: string | null;
};

type TopSpotAssetsResponse = {
  success: boolean;
  asOf?: number;
  connectionStatus?: "connected" | "degraded" | "disconnected";
  safeErrorMessage?: string;
  assets?: TopSpotAsset[];
};

type TopSpotAssetsState = {
  assets: TopSpotAsset[];
  status: "idle" | "loading" | "connected" | "error";
  error: string | null;
  asOf: number | null;
};

const defaultTotalAssetParams: CryptoTotalAssetCardProps = {
  totalEquityUsd: 0,
  todayPnlUsd: 0,
  todayPnlPct: 0,
  yesterdayChangePct: 0,
  yesterdayBaselineUsd: FIXED_YESTERDAY_BASELINE_USD,
  connectionStatus: "degraded",
  lastUpdatedAt: "--:--:--",
  lastUpdatedDate: "",
  cardHeight: HERO_PORTFOLIO_CARD_HEIGHT,
  borderRadius: 23,
  backgroundMode: "gradient",
  backgroundImage: "",
  showTrendChart: true,
  showEyeIcon: true,
  showStatusBadge: true,
  glowIntensity: 0.67,
  chartTone: "green",
  profitChartTone: "gold",
  lossChartTone: "red",
  trendScenario: "mixed",
  numberSize: 42,
  compactMode: false,
};

function useTopSpotAssets() {
  const [state, setState] = useState<TopSpotAssetsState>({
    assets: [],
    status: "idle",
    error: null,
    asOf: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function loadTopAssets() {
      setState((current) => ({
        ...current,
        status: current.status === "connected" ? "connected" : "loading",
      }));

      try {
        const query = new URLSearchParams({
          limit: String(TOP_SPOT_ASSET_LIMIT),
          exclude: TOP_SPOT_EXCLUDED_ASSETS.join(","),
          quote: "USDT",
        });
        const response = await fetch(
          `${API_BASE}/crypto/gate/spot/top-assets?${query.toString()}`,
          { headers: baseHeaders() }
        );
        const payload = (await response.json()) as TopSpotAssetsResponse;
        if (!response.ok || !payload?.success) {
          throw new Error(
            payload?.safeErrorMessage || "Gate 现货前六资产读取失败"
          );
        }
        if (cancelled) return;

        setState({
          assets: Array.isArray(payload.assets) ? payload.assets : [],
          status:
            payload.connectionStatus === "degraded" ? "connected" : "connected",
          error: null,
          asOf: payload.asOf || Date.now(),
        });
      } catch (error) {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Gate 现货前六资产读取失败",
        }));
      }
    }

    function schedule() {
      timer = window.setTimeout(async () => {
        await loadTopAssets();
        if (!cancelled) schedule();
      }, 10_000);
    }

    loadTopAssets();
    schedule();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return state;
}

function currentShanghaiDateTime() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).map((part) => [part.type, part.value])
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function trendPointKey(point: CryptoTrendPoint) {
  return `${point.ts || point.time}:${point.apiId || "main_account"}:${
    point.equityMode || "api_total"
  }`;
}

function mergeTrendPoints(
  currentPoints: CryptoTrendPoint[] = [],
  nextPoints: CryptoTrendPoint[] = []
) {
  if (!nextPoints.length) return currentPoints;

  const merged = new Map<string, CryptoTrendPoint>();
  currentPoints.forEach((point) => merged.set(trendPointKey(point), point));
  nextPoints.forEach((point) => merged.set(trendPointKey(point), point));

  return [...merged.values()].sort((left, right) => {
    const leftTs = left.ts || 0;
    const rightTs = right.ts || 0;
    if (leftTs !== rightTs) return leftTs - rightTs;
    return trendPointKey(left).localeCompare(trendPointKey(right));
  });
}

function timestampFromTime(time: string) {
  const [hour = "0", minute = "0", second = "0"] = time.split(":");
  const date = new Date();
  date.setHours(Number(hour), Number(minute), Number(second), 0);
  return date.getTime();
}

function buildSpotDetailParams({
  response,
  error,
  preset,
  market,
  currentTime,
  visual,
}: {
  response: TradingPairDetailResponse | null;
  error: string | null;
  preset: TradingPairPreset;
  market: TradingPairMarketType;
  currentTime: string;
  visual: typeof btcDetailVisual;
}): TradingPairDetailCardProps {
  const real = Boolean(response?.success);

  return {
    baseAsset: real
      ? response?.baseAsset || preset.baseAsset
      : preset.baseAsset,
    quoteAsset: real
      ? response?.quoteAsset || preset.quoteAsset
      : preset.quoteAsset,
    symbol: real ? response?.symbol || preset.symbol : preset.symbol,
    gateCurrencyPair: preset.gateCurrencyPair,
    assetName: preset.assetName,
    assetNameCn: preset.assetNameCn,
    marketType: market,
    iconText: preset.iconText,
    iconImage: preset.iconImage,
    accentColor: preset.accentColor,
    holdingValueQuote: real
      ? response?.holdingValueQuote || preset.holdingValueQuote
      : preset.holdingValueQuote,
    holdingValueUsd: real
      ? (response?.holdingValueUsd ?? preset.holdingValueUsd)
      : preset.holdingValueUsd,
    change24hPct: real ? (response?.change24hPct ?? null) : preset.change24hPct,
    change24hQuote: real
      ? (response?.change24hQuote ?? null)
      : preset.change24hQuote,
    averageBuyPriceQuote: real
      ? (response?.averageBuyPriceQuote ?? null)
      : preset.averageBuyPriceQuote || null,
    averageBuyPriceMethod: real
      ? response?.averageBuyPriceMethod || "unknown"
      : preset.averageBuyPriceMethod,
    averageBuyPriceScope: real
      ? response?.averageBuyPriceScope || "unknown"
      : "full",
    currentPriceQuote: real
      ? response?.currentPriceQuote || preset.currentPriceQuote
      : preset.currentPriceQuote,
    holdingAmountBase: real
      ? response?.holdingAmountBase || preset.holdingAmountBase
      : preset.holdingAmountBase,
    lastUpdatedAt: real
      ? response?.lastUpdatedAt || response?.asOf || null
      : timestampFromTime(currentTime),
    connectionStatus: real
      ? response?.connectionStatus || "connected"
      : error
        ? "degraded"
        : "degraded",
    ...visual,
  };
}

function presetForTopSpotAsset(asset: TopSpotAsset): TradingPairPreset {
  const preset = tradingPairMockPresets.find(
    (candidate) => candidate.id === asset.pair
  );
  if (preset) return preset;

  const isNvdaOn = asset.pair === "NVDAON_USDT";

  return {
    id: asset.pair,
    baseAsset: asset.baseAsset,
    quoteAsset: asset.quoteAsset,
    symbol: asset.symbol,
    gateCurrencyPair: asset.pair,
    assetName: isNvdaOn ? "NVIDIA" : asset.baseAsset,
    assetNameCn: isNvdaOn ? "NVDAON" : asset.baseAsset,
    iconText: asset.baseAsset,
    iconImage: isNvdaOn ? "/stock-icons/nvda.PNG" : undefined,
    accentColor: isNvdaOn ? "#1fff9e" : "#D6A84F",
    holdingValueQuote: asset.holdingValueQuote,
    holdingValueUsd: asset.holdingValueUsd || asset.holdingValueQuote,
    change24hPct: asset.change24hPct || "0",
    change24hQuote: "0",
    averageBuyPriceQuote: null,
    averageBuyPriceMethod: "unknown",
    currentPriceQuote: asset.currentPriceQuote,
    holdingAmountBase: asset.holdingAmountBase,
  };
}

function TopSpotAssetDetailCard({
  asset,
  cardWidth,
  currentTime,
}: {
  asset: TopSpotAsset;
  cardWidth: number;
  currentTime: string;
}) {
  const preset = useMemo(() => presetForTopSpotAsset(asset), [asset]);
  const detail = useTradingPairDetailData({
    mode: "gate-api",
    pair: asset.pair,
    market: "spot",
  });
  const visual = useMemo(
    () => ({
      ...btcDetailVisual,
      cardWidth,
      cardHeight: TOP_SPOT_CARD_HEIGHT,
    }),
    [cardWidth]
  );
  const params = useMemo<TradingPairDetailCardProps>(() => {
    return buildSpotDetailParams({
      response: detail.response,
      error: detail.error,
      preset,
      market: "spot",
      currentTime,
      visual,
    });
  }, [currentTime, detail.error, detail.response, preset, visual]);

  return <TradingPairDetailCard {...params} />;
}

function AnimatedTopSpotAssetGrid({
  assets,
  currentTime,
}: {
  assets: TopSpotAsset[];
  currentTime: string;
}) {
  const { reducedMotion, requestMotion } = useMotion();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefsRef = useRef(new Map<string, HTMLDivElement>());
  const previousRectsRef = useRef(new Map<string, DOMRect>());
  const previousKeysRef = useRef<string[]>([]);
  const [containerWidth, setContainerWidth] = useState(
    BTC_SPOT_CONTENT_MAX_WIDTH
  );
  const orderedPairs = assets.map((asset) => asset.pair).join("|");

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    function updateWidth() {
      setContainerWidth(Math.floor(node.getBoundingClientRect().width));
    }

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const twoColumns = containerWidth >= TOP_SPOT_MIN_TWO_COLUMN_WIDTH;
  const cardWidth = Math.max(
    320,
    Math.floor(
      (containerWidth - (twoColumns ? TOP_SPOT_CARD_GAP : 0)) /
        (twoColumns ? 2 : 1)
    )
  );

  const setItemRef = useCallback(
    (pair: string) => (node: HTMLDivElement | null) => {
      if (node) itemRefsRef.current.set(pair, node);
      else itemRefsRef.current.delete(pair);
    },
    []
  );

  useLayoutEffect(() => {
    const currentKeys = assets.map((asset) => asset.pair);
    const previousKeys = previousKeysRef.current;
    const previousRects = previousRectsRef.current;
    const currentRects = new Map<string, DOMRect>();

    for (const pair of currentKeys) {
      const node = itemRefsRef.current.get(pair);
      if (node) currentRects.set(pair, node.getBoundingClientRect());
    }

    const sameAssetSet =
      previousKeys.length === currentKeys.length &&
      currentKeys.every((pair) => previousRects.has(pair)) &&
      previousKeys.every((pair) => currentKeys.includes(pair));
    const orderChanged =
      sameAssetSet &&
      currentKeys.some((pair, index) => pair !== previousKeys[index]);

    if (orderChanged && !reducedMotion) {
      const motion = requestMotion({
        category: "list",
        token: "crypto-top-spot-assets-reorder",
        duration: TOP_SPOT_REORDER_DURATION_MS,
      });
      if (motion.allowed) {
        for (const pair of currentKeys) {
          const node = itemRefsRef.current.get(pair);
          const previous = previousRects.get(pair);
          const current = currentRects.get(pair);
          if (!node || !previous || !current) continue;

          const deltaX = previous.left - current.left;
          const deltaY = previous.top - current.top;
          if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;

          node.style.transition = "none";
          node.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
          node.style.willChange = "transform";
          node.style.zIndex = "2";

          window.requestAnimationFrame(() => {
            node.style.transition = `transform ${TOP_SPOT_REORDER_DURATION_MS}ms var(--motion-ease-emphasized, cubic-bezier(0.2, 0, 0, 1))`;
            node.style.transform = "translate(0, 0)";
          });
        }

        window.setTimeout(() => {
          for (const pair of currentKeys) {
            const node = itemRefsRef.current.get(pair);
            if (!node) continue;
            node.style.transition = "";
            node.style.transform = "";
            node.style.willChange = "";
            node.style.zIndex = "";
          }
          motion.end?.();
        }, TOP_SPOT_REORDER_DURATION_MS + 60);
      }
    }

    previousRectsRef.current = currentRects;
    previousKeysRef.current = currentKeys;
  }, [assets, orderedPairs, reducedMotion, requestMotion]);

  return (
    <div
      ref={containerRef}
      className="grid w-full max-w-full justify-center gap-6 overflow-visible"
      style={{
        gridTemplateColumns: twoColumns
          ? `${cardWidth}px ${cardWidth}px`
          : `${cardWidth}px`,
      }}
    >
      {assets.map((asset, index) => (
        <div
          key={asset.pair}
          ref={setItemRef(asset.pair)}
          className="relative motion-list-item"
          style={
            {
              "--motion-list-index": index,
              width: cardWidth,
              height: TOP_SPOT_CARD_HEIGHT,
            } as React.CSSProperties
          }
        >
          <TopSpotAssetDetailCard
            asset={asset}
            cardWidth={cardWidth}
            currentTime={currentTime}
          />
        </div>
      ))}
    </div>
  );
}

export default function CryptoCenter() {
  const equityMode: GateEquityMode = "api_total";
  const [btcRange, setBtcRange] = useState<TradingPairCandlestickRange>("1h");
  const [ethRange, setEthRange] = useState<TradingPairCandlestickRange>("1h");
  const [gateHistory, setGateHistory] = useState<GateEquityHistory | null>(
    null
  );
  const [gateHistoryStatus, setGateHistoryStatus] = useState<
    "idle" | "loading" | "connected" | "error"
  >("idle");
  const [selectedAllocationAsset, setSelectedAllocationAsset] = useState<
    string | null
  >(null);
  const [currentDateTime, setCurrentDateTime] = useState(
    currentShanghaiDateTime
  );
  const gateHistoryRef = useRef<GateEquityHistory | null>(null);
  const btcDetail = useTradingPairDetailData({
    mode: "gate-api",
    pair: BTC_PAIR,
    market: BTC_MARKET,
  });
  const btcCandlestick = useTradingPairCandlestickData({
    mode: "gate-api",
    pair: BTC_PAIR,
    range: btcRange,
    market: BTC_MARKET,
    currentPriceFallback: btcPreset.currentPriceQuote,
    change24hPctFallback: btcPreset.change24hPct,
  });
  const ethDetail = useTradingPairDetailData({
    mode: "gate-api",
    pair: ETH_PAIR,
    market: ETH_MARKET,
  });
  const ethCandlestick = useTradingPairCandlestickData({
    mode: "gate-api",
    pair: ETH_PAIR,
    range: ethRange,
    market: ETH_MARKET,
    currentPriceFallback: ethPreset.currentPriceQuote,
    change24hPctFallback: ethPreset.change24hPct,
  });
  const topSpotAssets = useTopSpotAssets();
  const assetAllocation = useAssetAllocationDonutData({
    initialMode: "gate",
  });
  const openFuturesPositions = useOpenFuturesPositionsData({
    mode: "gate-api",
    mockPositions: mockOpenFuturesPositions,
    mockSummary: mockOpenFuturesSummary,
  });
  const tradeRecordsController = useTradeRecordsTableController({
    mode: "gate-api",
    initialRangePreset: "30d",
    initialPageSize: 10,
  });

  useEffect(() => {
    gateHistoryRef.current = gateHistory;
  }, [gateHistory]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentDateTime(currentShanghaiDateTime());
    }, 1_000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    async function startGateStream() {
      try {
        await fetch(`${API_BASE}/crypto/gate/probe/ws/start`, {
          method: "POST",
          headers: baseHeaders(),
        });
      } catch {
        // The history polling below owns the visible degraded state.
      }
    }

    startGateStream();

    return () => {
      fetch(`${API_BASE}/crypto/gate/probe/ws/stop`, {
        method: "POST",
        headers: baseHeaders(),
      }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let loadedFullHistory = false;

    async function loadHistory() {
      setGateHistoryStatus((current) =>
        current === "connected" ? "connected" : "loading"
      );

      try {
        const query = new URLSearchParams({
          window: "today",
          equityMode,
        });
        const currentHistory = gateHistoryRef.current;
        const lastPointTs =
          currentHistory?.latestPointTs ||
          currentHistory?.points?.[currentHistory.points.length - 1]?.ts;
        if (loadedFullHistory && lastPointTs) {
          query.set("sinceTs", String(lastPointTs));
        }

        const response = await fetch(
          `${API_BASE}/crypto/gate/probe/equity-history?${query.toString()}`,
          { headers: baseHeaders() }
        );
        const payload = await response.json();
        if (!response.ok || !payload?.success || !payload?.history) {
          throw new Error(payload?.error || "Gate 今日历史数据读取失败");
        }
        if (cancelled) return;

        setGateHistory((current) => {
          const nextHistory = payload.history as GateEquityHistory;
          loadedFullHistory = true;

          if (!nextHistory.incremental || !current) return nextHistory;

          const unchanged =
            current.historyVersion === nextHistory.historyVersion &&
            current.freshness?.latestSnapshotAt ===
              nextHistory.freshness?.latestSnapshotAt &&
            current.latestEquityUsd === nextHistory.latestEquityUsd;
          if (unchanged && !nextHistory.points.length) return current;

          return {
            ...nextHistory,
            points: mergeTrendPoints(current.points, nextHistory.points),
          };
        });
        setGateHistoryStatus("connected");
      } catch {
        if (cancelled) return;
        setGateHistoryStatus("error");
      }
    }

    loadHistory();
    timer = window.setInterval(loadHistory, 500);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [equityMode]);

  const totalAssetParams = useMemo<CryptoTotalAssetCardProps>(() => {
    const timeStampedParams = {
      ...defaultTotalAssetParams,
      lastUpdatedAt: currentDateTime.time,
      lastUpdatedDate: currentDateTime.date,
      connectionStatus:
        gateHistoryStatus === "connected"
          ? ("connected" as const)
          : gateHistoryStatus === "error"
            ? ("disconnected" as const)
            : ("degraded" as const),
    };

    if (!gateHistory) return timeStampedParams;

    return {
      ...timeStampedParams,
      totalEquityUsd: gateHistory.latestEquityUsd,
      todayPnlUsd: gateHistory.todayPnlUsd,
      todayPnlPct: gateHistory.todayPnlPct,
      yesterdayBaselineUsd: FIXED_YESTERDAY_BASELINE_USD,
      yesterdayChangePct: gateHistory.yesterdayChangePct,
      trendPoints: gateHistory.points,
    };
  }, [currentDateTime, gateHistory, gateHistoryStatus]);

  const btcDetailParams = useMemo<TradingPairDetailCardProps>(() => {
    return buildSpotDetailParams({
      response: btcDetail.response,
      error: btcDetail.error,
      preset: btcPreset,
      market: BTC_MARKET,
      currentTime: currentDateTime.time,
      visual: btcDetailVisual,
    });
  }, [btcDetail.error, btcDetail.response, currentDateTime.time]);

  const ethDetailParams = useMemo<TradingPairDetailCardProps>(() => {
    return buildSpotDetailParams({
      response: ethDetail.response,
      error: ethDetail.error,
      preset: ethPreset,
      market: ETH_MARKET,
      currentTime: currentDateTime.time,
      visual: btcDetailVisual,
    });
  }, [ethDetail.error, ethDetail.response, currentDateTime.time]);

  const assetAllocationParams = useMemo<AssetAllocationDonutCardProps>(
    () => ({
      title: "资产分布",
      totalValueUsd: assetAllocation.activeTotalValueUsd,
      items: assetAllocation.activeItems,
      selectedAsset: selectedAllocationAsset,
      onSelectAsset: setSelectedAllocationAsset,
      maxVisibleItems: 6,
      showFooterNote: true,
      cardWidth: HERO_ASSET_ALLOCATION_CARD_WIDTH,
      cardHeight: HERO_PORTFOLIO_CARD_HEIGHT,
      borderRadius: 23,
      donutSize: 210,
      donutThickness: 44,
      glowIntensity: 0.45,
      dimInactiveOnFocus: true,
      compactMode: true,
    }),
    [
      assetAllocation.activeItems,
      assetAllocation.activeTotalValueUsd,
      selectedAllocationAsset,
    ]
  );

  const openFuturesPositionsParams = useMemo<OpenFuturesPositionsCardProps>(
    () => ({
      positions: openFuturesPositions.positions,
      summary: openFuturesPositions.summary,
      filterLabel: "全部合约",
      lastUpdatedAt: openFuturesPositions.lastUpdatedAt,
      loading: openFuturesPositions.loading,
      error: openFuturesPositions.error,
      status: openFuturesPositions.status,
      onRefresh: openFuturesPositions.refresh,
      cardWidth: BTC_SPOT_CONTENT_MAX_WIDTH,
      cardHeight: OPEN_FUTURES_POSITIONS_CARD_HEIGHT,
      visiblePositionCount: OPEN_FUTURES_VISIBLE_POSITION_COUNT,
      borderRadius: 28,
      compactMode: false,
      showSummaryFooter: true,
      showLeverageBars: true,
    }),
    [openFuturesPositions]
  );

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#08090b] text-slate-100">
      <div className="pointer-events-none fixed inset-0 z-0 h-screen w-screen">
        <div
          className="fixed inset-0 h-screen w-screen bg-cover bg-center bg-no-repeat"
          style={{
            backgroundImage: `url("${CRYPTO_CENTER_BACKGROUND_URL}")`,
          }}
        />
        <div className="fixed inset-0 h-screen w-screen bg-[linear-gradient(180deg,rgba(5,5,5,.42),rgba(5,5,5,.72)),radial-gradient(circle_at_20%_0%,rgba(214,168,79,.14),transparent_34%)]" />
        <div className="fixed inset-0 h-screen w-screen bg-[#050505]/25" />
      </div>
      <main className="relative z-10 h-full w-full overflow-y-auto bg-transparent">
        <div className="relative min-h-full overflow-hidden px-4 py-6 md:px-6 md:py-8">
          <section
            className="relative z-10 mx-auto min-h-[calc(100vh-48px)] w-full"
            style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
          >
            <div className="grid w-full content-start gap-6 overflow-x-hidden pb-2">
              <header className="w-full pt-1">
                <h1 className="text-3xl font-black tracking-normal text-[#D6A84F] drop-shadow-[0_0_22px_rgba(214,168,79,.22)] md:text-5xl">
                  加密货币专区
                </h1>
                <p className="mt-2 text-sm font-semibold text-[#E8C46B]/70">
                  Crypto Center
                </p>
                <div className="mt-5 h-px w-full bg-gradient-to-r from-[#D6A84F]/85 via-[#D6A84F]/42 to-transparent shadow-[0_0_18px_rgba(214,168,79,.26)]" />
              </header>
              <div
                className="grid w-full max-w-full items-start gap-6 xl:grid-cols-[var(--crypto-hero-columns)]"
                style={
                  {
                    "--crypto-hero-columns": `${HERO_TOTAL_ASSET_CARD_WIDTH}px ${HERO_ASSET_ALLOCATION_CARD_WIDTH}px`,
                    maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH,
                  } as React.CSSProperties
                }
              >
                <div className="min-h-[380px] w-full min-w-0 xl:h-[380px] xl:w-[640px]">
                  <CryptoTotalAssetCard {...totalAssetParams} />
                </div>
                <div className="h-[380px] w-full min-w-0 xl:w-[560px]">
                  <AssetAllocationDonutCard {...assetAllocationParams} />
                </div>
              </div>
              <div className="h-px w-full bg-gradient-to-r from-[#D6A84F]/90 via-[#D6A84F]/45 to-transparent shadow-[0_0_20px_rgba(214,168,79,.28)]" />
              <div className="flex w-full items-end justify-between gap-6">
                <div>
                  <h2 className="text-2xl font-black tracking-normal text-[#D6A84F] drop-shadow-[0_0_18px_rgba(214,168,79,.20)] md:text-3xl">
                    现货：BTC ETH专区
                  </h2>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-normal text-[#E8C46B]/62">
                    Spot Market
                  </p>
                </div>
              </div>
              <div
                className="mx-auto flex w-full max-w-full items-start justify-center gap-6 overflow-x-hidden"
                style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
              >
                <div
                  className="shrink-0"
                  style={{
                    width: BTC_SPOT_DETAIL_CARD_WIDTH,
                    height: BTC_SPOT_CARD_HEIGHT,
                  }}
                >
                  <TradingPairDetailCard {...btcDetailParams} />
                </div>
                <div
                  className="min-w-0 flex-1"
                  style={{
                    maxWidth: BTC_SPOT_CHART_MAX_WIDTH,
                    height: BTC_SPOT_CARD_HEIGHT,
                  }}
                >
                  <TradingPairCandlestickChart
                    mode="gate-api"
                    pair={BTC_PAIR}
                    range={btcRange}
                    market={BTC_MARKET}
                    baseAsset={btcPreset.baseAsset}
                    quoteAsset={btcPreset.quoteAsset}
                    symbol={btcPreset.symbol}
                    assetName={btcPreset.assetName}
                    assetNameCn={btcPreset.assetNameCn}
                    iconText={btcPreset.iconText}
                    iconImage={btcPreset.iconImage}
                    iconSize={btcCandlestickVisual.iconSize}
                    iconCropScale={btcCandlestickVisual.iconCropScale}
                    iconCropX={btcCandlestickVisual.iconCropX}
                    iconCropY={btcCandlestickVisual.iconCropY}
                    candles={btcCandlestick.activeCandles}
                    currentPriceQuote={btcCandlestick.currentPriceQuote}
                    currentPriceUsd={btcCandlestick.currentPriceQuote}
                    change24hPct={btcCandlestick.change24hPct}
                    status={btcCandlestick.status}
                    autoRefreshSeconds={30}
                    showVolume={btcCandlestickVisual.showVolume}
                    showCrosshair={btcCandlestickVisual.showCrosshair}
                    showCurrentPriceLine={
                      btcCandlestickVisual.showCurrentPriceLine
                    }
                    showGrid={btcCandlestickVisual.showGrid}
                    compactMode={btcCandlestickVisual.compactMode}
                    cardHeight={btcCandlestickVisual.cardHeight}
                    borderRadius={btcCandlestickVisual.borderRadius}
                    glowIntensity={btcCandlestickVisual.glowIntensity}
                    accentColor={btcCandlestickVisual.accentColor}
                    loading={btcCandlestick.loading}
                    historyLoading={btcCandlestick.historyLoading}
                    error={btcCandlestick.error}
                    onRangeChange={setBtcRange}
                    onLoadMoreHistory={btcCandlestick.loadMoreHistory}
                  />
                </div>
              </div>
              <div
                className="mx-auto h-px w-full bg-gradient-to-r from-[#D6A84F]/90 via-[#D6A84F]/45 to-transparent shadow-[0_0_20px_rgba(214,168,79,.28)]"
                style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
              />
              <div
                className="mx-auto flex w-full max-w-full items-start justify-center gap-6 overflow-x-hidden"
                style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
              >
                <div
                  className="shrink-0"
                  style={{
                    width: BTC_SPOT_DETAIL_CARD_WIDTH,
                    height: BTC_SPOT_CARD_HEIGHT,
                  }}
                >
                  <TradingPairDetailCard {...ethDetailParams} />
                </div>
                <div
                  className="min-w-0 flex-1"
                  style={{
                    maxWidth: BTC_SPOT_CHART_MAX_WIDTH,
                    height: BTC_SPOT_CARD_HEIGHT,
                  }}
                >
                  <TradingPairCandlestickChart
                    mode="gate-api"
                    pair={ETH_PAIR}
                    range={ethRange}
                    market={ETH_MARKET}
                    baseAsset={ethPreset.baseAsset}
                    quoteAsset={ethPreset.quoteAsset}
                    symbol={ethPreset.symbol}
                    assetName={ethPreset.assetName}
                    assetNameCn={ethPreset.assetNameCn}
                    iconText={ethPreset.iconText}
                    iconImage={ethPreset.iconImage}
                    iconSize={btcCandlestickVisual.iconSize}
                    iconCropScale={btcCandlestickVisual.iconCropScale}
                    iconCropX={btcCandlestickVisual.iconCropX}
                    iconCropY={btcCandlestickVisual.iconCropY}
                    candles={ethCandlestick.activeCandles}
                    currentPriceQuote={ethCandlestick.currentPriceQuote}
                    currentPriceUsd={ethCandlestick.currentPriceQuote}
                    change24hPct={ethCandlestick.change24hPct}
                    status={ethCandlestick.status}
                    autoRefreshSeconds={30}
                    showVolume={btcCandlestickVisual.showVolume}
                    showCrosshair={btcCandlestickVisual.showCrosshair}
                    showCurrentPriceLine={
                      btcCandlestickVisual.showCurrentPriceLine
                    }
                    showGrid={btcCandlestickVisual.showGrid}
                    compactMode={btcCandlestickVisual.compactMode}
                    cardHeight={btcCandlestickVisual.cardHeight}
                    borderRadius={btcCandlestickVisual.borderRadius}
                    glowIntensity={btcCandlestickVisual.glowIntensity}
                    accentColor={ethPreset.accentColor}
                    chartBackgroundImage={ETH_CHART_BACKGROUND_URL}
                    loading={ethCandlestick.loading}
                    historyLoading={ethCandlestick.historyLoading}
                    error={ethCandlestick.error}
                    onRangeChange={setEthRange}
                    onLoadMoreHistory={ethCandlestick.loadMoreHistory}
                  />
                </div>
              </div>
              <div
                className="mx-auto h-px w-full bg-gradient-to-r from-[#D6A84F]/90 via-[#D6A84F]/45 to-transparent shadow-[0_0_20px_rgba(214,168,79,.28)]"
                style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
              />
              <div className="flex w-full items-end justify-between gap-6">
                <div>
                  <h2 className="text-2xl font-black tracking-normal text-[#D6A84F] drop-shadow-[0_0_18px_rgba(214,168,79,.20)] md:text-3xl">
                    现货前六资产专区
                  </h2>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-normal text-[#E8C46B]/62">
                    Top Spot Assets
                  </p>
                </div>
                {topSpotAssets.status === "loading" ? (
                  <div className="rounded-full border border-[#D6A84F]/20 bg-[#D6A84F]/10 px-4 py-2 text-xs font-black text-[#E8C46B]/75">
                    加载中
                  </div>
                ) : topSpotAssets.status === "error" ? (
                  <div className="max-w-[420px] truncate rounded-full border border-red-400/20 bg-red-500/10 px-4 py-2 text-xs font-black text-red-200/80">
                    {topSpotAssets.error || "前六资产读取失败"}
                  </div>
                ) : null}
              </div>
              <div
                className="mx-auto w-full max-w-full overflow-x-hidden"
                style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
              >
                {topSpotAssets.assets.length ? (
                  <AnimatedTopSpotAssetGrid
                    assets={topSpotAssets.assets}
                    currentTime={currentDateTime.time}
                  />
                ) : (
                  <div className="flex h-40 items-center justify-center rounded-[24px] border border-[#D6A84F]/15 bg-black/20 text-sm font-bold text-[#E8C46B]/60">
                    正在读取 Gate 现货资产...
                  </div>
                )}
              </div>
              <div
                className="mx-auto h-px w-full bg-gradient-to-r from-[#D6A84F]/90 via-[#D6A84F]/45 to-transparent shadow-[0_0_20px_rgba(214,168,79,.28)]"
                style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
              />
              <div className="flex w-full items-end justify-between gap-6">
                <div>
                  <h2 className="text-2xl font-black tracking-normal text-[#D6A84F] drop-shadow-[0_0_18px_rgba(214,168,79,.20)] md:text-3xl">
                    合约与交易详情专区
                  </h2>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-normal text-[#E8C46B]/62">
                    Futures & Trading Details
                  </p>
                </div>
              </div>
              <div
                className="mx-auto w-full max-w-full overflow-x-hidden"
                style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
              >
                <OpenFuturesPositionsCard {...openFuturesPositionsParams} />
              </div>
              <div
                className="mx-auto w-full max-w-full overflow-x-hidden"
                style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
              >
                <TradeRecordsTable
                  {...tradeRecordsController.tableProps}
                  cardWidth={BTC_SPOT_CONTENT_MAX_WIDTH}
                  cardHeight={TRADE_RECORDS_CARD_HEIGHT}
                  borderRadius={28}
                  compactMode={false}
                />
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
