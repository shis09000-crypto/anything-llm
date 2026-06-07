import type {
  TradingPairConnectionStatus,
  TradingPairDataMode,
  TradingPairMarketType,
} from "./tradingPairDetailTypes";

export type TradingPairCandlestickRange =
  | "15m"
  | "1h"
  | "4h"
  | "1d"
  | "7d"
  | "30d";

export interface TradingPairCandle {
  ts: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface TradingPairVisibleWindow {
  visibleStartTs: number | null;
  visibleEndTs: number | null;
}

export interface TradingPairCandlestickChartProps {
  mode: TradingPairDataMode;
  pair: string;
  range: TradingPairCandlestickRange;
  market: TradingPairMarketType;
  baseAsset: string;
  quoteAsset: string;
  symbol: string;
  assetName: string;
  assetNameCn?: string;
  iconText?: string;
  iconImage?: string;
  iconSize: number;
  iconCropScale: number;
  iconCropX: number;
  iconCropY: number;
  candles: TradingPairCandle[];
  currentPriceQuote: string | null;
  currentPriceUsd?: string | null;
  change24hPct: string | null;
  status: TradingPairConnectionStatus;
  autoRefreshSeconds: number;
  showVolume: boolean;
  showCrosshair: boolean;
  showCurrentPriceLine: boolean;
  showGrid: boolean;
  compactMode: boolean;
  cardHeight: number;
  borderRadius: number;
  glowIntensity: number;
  accentColor: string;
  chartBackgroundImage?: string | null;
  loading?: boolean;
  historyLoading?: boolean;
  error?: string | null;
  onRangeChange?: (range: TradingPairCandlestickRange) => void;
  onLoadMoreHistory?: (
    beforeTs: number,
    visibleWindow: TradingPairVisibleWindow
  ) => void | Promise<void>;
}

export interface TradingPairCandlesResponse {
  success: boolean;
  asOf: number;
  exchange?: "gate";
  marketType?: TradingPairMarketType;
  baseAsset?: string;
  quoteAsset?: string;
  symbol?: string;
  gateCurrencyPair?: string;
  range?: TradingPairCandlestickRange;
  gateInterval?: string;
  candles?: TradingPairCandle[];
  currentPriceQuote?: string | null;
  change24hPct?: string | null;
  connectionStatus?: TradingPairConnectionStatus;
  latestSnapshotAt?: number | null;
  lastUpdatedAt?: number | null;
  wsStatus?: string | null;
  restStatus?: string | null;
  lastRestFetchAt?: number | null;
  lastWsMessageAt?: number | null;
  subscriberCount?: number | null;
  hasMoreHistory?: boolean;
  cache?: {
    cacheKey?: string;
    latestSnapshotAt?: number | null;
    wsStatus?: string | null;
    restStatus?: string | null;
    lastRestFetchAt?: number | null;
    lastWsMessageAt?: number | null;
    subscriberCount?: number | null;
  } | null;
  partialFailures?: Array<{ source: string; message: string }>;
  safeErrorMessage?: string;
}

export interface TradingPairCandlesStreamEvent {
  type?: "market_candles" | string;
  cacheKey?: string;
  marketType?: TradingPairMarketType;
  gateCurrencyPair?: string;
  range?: TradingPairCandlestickRange;
  gateInterval?: string;
  candles?: TradingPairCandle[];
  currentPriceQuote?: string | null;
  change24hPct?: string | null;
  latestSnapshotAt?: number | null;
  lastUpdatedAt?: number | null;
  wsStatus?: string | null;
  restStatus?: string | null;
  lastRestFetchAt?: number | null;
  lastWsMessageAt?: number | null;
  subscriberCount?: number | null;
  lastError?: string | null;
}
