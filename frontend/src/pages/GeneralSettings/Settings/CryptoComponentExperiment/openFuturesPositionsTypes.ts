export type FuturesPositionSide = "long" | "short";

export type FuturesRiskLevel = "safe" | "watch" | "danger";

export type LiquidationRiskLevel =
  | "safe"
  | "watch"
  | "danger"
  | "critical"
  | "extreme";

export type FuturesMarginMode = "cross" | "isolated";

export type OpenFuturesConnectionStatus =
  | "connected"
  | "degraded"
  | "disconnected";

export interface OpenFuturesPositionItem {
  id: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: "perpetual" | "delivery";
  side: FuturesPositionSide;
  leverage: number;
  marginMode: FuturesMarginMode;
  quantity: string;
  quantityAmount?: string;
  notionalUsd: string;
  positionValueUsd: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string | null;
  liquidationRiskLevel?: LiquidationRiskLevel;
  liquidationDistancePct?: string | null;
  marginUsd: string;
  fundingFeeUsd: string | null;
  unrealizedPnlUsd: string;
  pnlPct: string;
  riskLevel: FuturesRiskLevel;
  iconUrl?: string;
}

export interface OpenFuturesPositionsSummary {
  totalUnrealizedPnlUsd: string;
  weightedPnlPct: string;
  totalMarginUsd: string;
  accountEquityUsd: string;
  marginRatioPct: string;
}

export interface OpenFuturesPositionsCardProps {
  positions: OpenFuturesPositionItem[];
  summary: OpenFuturesPositionsSummary;
  filterLabel?: string;
  lastUpdatedAt?: number | null;
  loading?: boolean;
  error?: string | null;
  status?: OpenFuturesConnectionStatus;
  cardWidth?: number;
  cardHeight?: number;
  borderRadius?: number;
  compactMode?: boolean;
  showSummaryFooter?: boolean;
  showLeverageBars?: boolean;
  visiblePositionCount?: number;
  onRefresh?: () => void;
}

export interface OpenFuturesPositionsResponse {
  success: boolean;
  asOf: number;
  exchange?: "gate";
  marketType?: "futures";
  settle?: "usdt";
  positions?: OpenFuturesPositionItem[];
  summary?: OpenFuturesPositionsSummary;
  connectionStatus?: OpenFuturesConnectionStatus;
  wsStatus?: string | null;
  restStatus?: string | null;
  lastRestFetchAt?: number | null;
  lastWsMessageAt?: number | null;
  partialFailures?: Array<{ source: string; message: string }>;
  safeErrorMessage?: string;
}
