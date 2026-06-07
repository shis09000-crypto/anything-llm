export type BtcCardMode = "mock" | "gate-real";

export type BtcChartRange = "1d" | "7d" | "30d" | "90d" | "1y";

export type BtcConnectionStatus = "connected" | "degraded" | "disconnected";

export type BtcBackgroundMode = "none" | "gradient" | "image";

export interface BtcCandlePoint {
  ts: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

export interface BtcSpotAssetCardProps {
  mode: BtcCardMode;
  totalValueUsd: string;
  btcAmount: string;
  averageBuyPriceUsd: string | null;
  averageBuyPriceScope?:
    | "full"
    | "partial"
    | "insufficient_history"
    | "unknown";
  averageBuyPriceMethod?: "fifo_remaining_cost";
  averageBuyTradeCount?: number;
  averageBuyHistoryComplete?: boolean;
  currentPriceUsd: string;
  change24hPct: string | null;
  change24hUsd: string | null;
  lastUpdatedAt: number | null;
  connectionStatus: BtcConnectionStatus;
  range: BtcChartRange;
  candles: BtcCandlePoint[];
  backgroundMode: BtcBackgroundMode;
  backgroundImage?: string;
  cardHeight: number;
  borderRadius: number;
  glowIntensity: number;
  showVolume: boolean;
  showCnyEstimate: boolean;
  showAutoRefreshBadge: boolean;
  autoRefreshSeconds: number;
  compactMode: boolean;
}

export interface BtcSpotSummaryResponse {
  success: boolean;
  asOf: number;
  exchange: "gate";
  symbol: "BTC_USDT";
  connectionStatus: BtcConnectionStatus;
  totalValueUsd?: string;
  btcAmount?: string;
  averageBuyPriceUsd?: string | null;
  averageBuyPriceScope?:
    | "full"
    | "partial"
    | "insufficient_history"
    | "unknown";
  averageBuyPriceMethod?: "fifo_remaining_cost";
  averageBuyTradeCount?: number;
  averageBuyHistoryComplete?: boolean;
  currentPriceUsd?: string;
  change24hPct?: string | null;
  change24hUsd?: string | null;
  candles?: BtcCandlePoint[];
  freshness?: {
    latestSnapshotAt: number | null;
    priceAgeMs: number | null;
    balanceAgeMs: number | null;
    candleAgeMs: number | null;
    lastRefreshSource: string | null;
    rateLimitMode: "normal" | "slow";
  };
  partialFailures?: Array<{ source: string; message: string }>;
  safeErrorMessage?: string;
}
