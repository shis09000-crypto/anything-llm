export type TradingPairDataMode = "mock" | "gate-api";

export type TradingPairMarketType = "spot" | "futures" | "margin";

export type TradingPairConnectionStatus =
  | "connected"
  | "degraded"
  | "disconnected";

export type AverageBuyPriceMethod =
  | "moving_weighted"
  | "recent_weighted"
  | "manual"
  | "unknown";

export type AverageBuyPriceScope =
  | "full"
  | "partial"
  | "calculating"
  | "insufficient_history"
  | "unknown";

export interface TradingPairDetailCardProps {
  baseAsset: string;
  quoteAsset: string;
  symbol: string;
  gateCurrencyPair?: string;
  assetName: string;
  assetNameCn?: string;
  marketType: TradingPairMarketType;
  iconText?: string;
  iconImage?: string;
  iconSize: number;
  iconCropScale: number;
  iconCropX: number;
  iconCropY: number;
  accentColor?: string;
  holdingValueQuote: string;
  holdingValueUsd?: string | null;
  change24hPct: string | null;
  change24hQuote: string | null;
  averageBuyPriceQuote: string | null;
  averageBuyPriceMethod: AverageBuyPriceMethod;
  averageBuyPriceScope?: AverageBuyPriceScope;
  currentPriceQuote: string;
  holdingAmountBase: string;
  lastUpdatedAt: number | null;
  connectionStatus: TradingPairConnectionStatus;
  showUsdEstimate: boolean;
  showMarketBadge: boolean;
  showInfoIcons: boolean;
  compactMode: boolean;
  cardWidth: number;
  cardHeight: number;
  borderRadius: number;
  glowIntensity: number;
}

export interface TradingPairDetailResponse
  extends Partial<TradingPairDetailCardProps> {
  success: boolean;
  asOf: number;
  exchange?: "gate";
  freshness?: {
    latestSnapshotAt: number | null;
    tickerAgeMs: number | null;
    balanceAgeMs: number | null;
    averageBuyAgeMs: number | null;
    lastRefreshSource: string | null;
    rateLimitMode: "normal" | "slow";
  };
  partialFailures?: Array<{ source: string; message: string }>;
  safeErrorMessage?: string;
  averageBuyTradeCount?: number;
  averageBuyHistoryComplete?: boolean;
  averageBuyWindow?: {
    type: string;
    count?: number;
    configuredCount?: number;
  } | null;
  holdingSources?: {
    spot?: string;
    earnUni?: string;
    selected?: "spot" | "earnUni" | "combined";
  };
}

export interface TradingPairPreset {
  id: string;
  baseAsset: string;
  quoteAsset: string;
  symbol: string;
  gateCurrencyPair: string;
  assetName: string;
  assetNameCn: string;
  iconText: string;
  iconImage?: string;
  accentColor: string;
  holdingValueQuote: string;
  holdingValueUsd: string;
  change24hPct: string;
  change24hQuote: string;
  averageBuyPriceQuote: string | null;
  averageBuyPriceMethod: AverageBuyPriceMethod;
  currentPriceQuote: string;
  holdingAmountBase: string;
}
