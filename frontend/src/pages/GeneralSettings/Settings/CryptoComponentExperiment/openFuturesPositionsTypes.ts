export type FuturesPositionSide = "long" | "short";

export type FuturesRiskLevel = "safe" | "watch" | "danger" | "unavailable";

export type LiquidationRiskLevel =
  | "safe"
  | "watch"
  | "danger"
  | "critical"
  | "extreme"
  | "unavailable";

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
  configuredLeverage?: number;
  effectiveLeverage?: number | null;
  leverageScope?: string;
  marginMode: FuturesMarginMode;
  contractSize?: string;
  contractSizeUnit?: "contracts";
  quantity: string;
  quantityAmount?: string;
  baseEquivalentAmount?: string;
  quantitySemantics?: string;
  notionalUsd: string;
  positionValueUsd: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string | null;
  liquidationPriceReferenceOnly?: boolean;
  liquidationRiskLevel?: LiquidationRiskLevel;
  liquidationDistancePct?: string | null;
  marginUsd: string;
  initialMarginUsd?: string | null;
  maintenanceMarginUsd?: string | null;
  marginSemantics?: string;
  fundingFeeUsd: string | null;
  unrealizedPnlUsd: string;
  pnlPct: string | null;
  pnlPctUnavailableReason?: string | null;
  riskLevel: FuturesRiskLevel;
  iconUrl?: string;
}

export interface OpenFuturesPositionsSummary {
  totalUnrealizedPnlUsd: string;
  weightedPnlPct: string | null;
  totalNotionalUsd?: string;
  accountInitialMarginUsd?: string;
  accountMaintenanceMarginUsd?: string;
  accountOrderMarginUsd?: string;
  crossAvailableUsd?: string;
  initialMarginToCrossAvailablePct?: string | null;
  totalMarginUsd: string;
  accountEquityUsd: string;
  accountEquitySemantics?: string;
  marginRatioPct: string | null;
  marginRatioSemantics?: string;
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
