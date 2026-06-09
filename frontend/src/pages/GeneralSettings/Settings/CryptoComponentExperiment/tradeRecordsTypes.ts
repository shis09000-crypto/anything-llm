export type TradeMarketType = "spot" | "futures";
export type TradeFeeSource = "asset" | "point" | "gt" | "zero" | "unknown";
export type CycleConfidence = "complete" | "partial_history" | "unmatched";
export type CycleMatchWarning =
  | "missing_open_before_window"
  | "partial_history"
  | "unmatched_close"
  | "window_boundary";

export type TradeActionType =
  | "spot_buy"
  | "spot_sell"
  | "futures_open_long"
  | "futures_close_long"
  | "futures_open_short"
  | "futures_close_short";

export interface TradeRecordItem {
  id: string;
  ts: number;
  marketType: TradeMarketType;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType?: "spot" | "perpetual" | "delivery";
  action: TradeActionType;
  quantity: string;
  price: string;
  notionalUsd: string;
  feeUsd: string;
  feeAmount: string;
  feeCurrency: string;
  feeSource: TradeFeeSource;
  pointFeeAmount?: string;
  gtFeeAmount?: string;
  feeDisplayAmount: string;
  feeDisplayCurrency: string;
  realizedPnlUsd: string | null;
  realizedPnlPct?: string | null;
  realizedPnlSource?: "position_close" | "trade" | "cycle_estimated" | null;
  orderId: string;
  iconUrl?: string;
  fillCount?: number;
  fillIds?: string[];
  isAggregated?: boolean;
  cycleId?: string;
  cycleStatus?: "open" | "closed" | "partial" | "unmatched";
  cycleConfidence?: CycleConfidence;
  matchRole?: "open" | "close" | "unmatched_close" | "boundary";
  matchedQty?: string;
  matchWarning?: CycleMatchWarning;
}

export type TradeRecordsActionHighlight = {
  cycleId?: string;
  contractKey?: string;
  sourceRecordKey: string;
  sourceAction?: TradeActionType;
  relatedAction?: TradeActionType;
  relatedRecordKeys?: string[];
} | null;

export interface HistoryCoverage {
  requestedFrom: number;
  requestedTo: number;
  loadedFrom: number;
  loadedTo: number;
  effectiveTo?: number;
  batchLimit?: number;
  hasMoreBefore?: boolean;
}

export interface CloseMatch {
  id: string;
  cycleId: string;
  openLotId: string;
  closeTradeId: string;
  matchedQty: string;
  openPrice: string;
  closePrice: string;
  pnlUsd: string;
  pnlSource?: "gate" | "estimated";
}

export interface OpenLot {
  id: string;
  tradeId: string;
  orderId: string;
  symbol: string;
  side: "long" | "short";
  openedAt: number;
  price: string;
  qtyOriginal: string;
  qtyRemaining: string;
  feeUsd?: string;
}

export interface FuturesTradeCycle {
  id: string;
  symbol: string;
  contractType: "perpetual" | "delivery";
  side: "long" | "short";
  status: "open" | "closed" | "partial" | "unmatched";
  openedAt: number | null;
  closedAt: number | null;
  openRecordKeys?: string[];
  closeRecordKeys?: string[];
  openTradeIds: string[];
  closeTradeIds: string[];
  openOrderIds: string[];
  closeOrderIds: string[];
  matches: CloseMatch[];
  totalOpenedQty: string;
  totalClosedQty: string;
  remainingQty: string;
  avgOpenPrice: string | null;
  avgClosePrice: string | null;
  realizedPnlUsd: string;
  totalFeeUsd: string;
  durationMs: number | null;
  hasUnmatchedClose?: boolean;
  unmatchedCloseQty?: string;
  historyWindowStartAt: number;
  historyWindowEndAt: number;
  hasBoundaryOpen?: boolean;
  boundaryReason?: string;
  cycleConfidence: CycleConfidence;
  isMemoryBacked?: boolean;
  isPartialInWindow?: boolean;
}

export interface TradeRecordsSummary {
  totalNotionalUsd: string;
  totalFeeUsd: string;
  yearTotalFeeUsd?: string | null;
  totalRealizedPnlUsd: string;
  winRatePct: string;
  tradeCount: number;
  spotNotionalUsd: string;
  futuresNotionalUsd: string;
}

export type TradeRecordsConnectionStatus =
  | "connected"
  | "degraded"
  | "disconnected";

export interface TradeRecordsTableProps {
  records: TradeRecordItem[];
  summary: TradeRecordsSummary;
  loading?: boolean;
  error?: string | null;
  page?: number;
  pageSize?: number;
  totalCount?: number;
  cardWidth?: number;
  cardHeight?: number;
  borderRadius?: number;
  compactMode?: boolean;
  hasMoreHistory?: boolean;
  lastUpdatedAt?: number | null;
  connectionStatus?: TradeRecordsConnectionStatus;
  marketFilter?: TradeMarketType | "all";
  typeFilter?: TradeActionType | "all";
  directionFilter?: "all" | "long" | "short" | "spot";
  contractFilter?: string;
  availableContracts?: string[];
  timeRangeLabel?: string;
  copiedOrderId?: string | null;
  actionHighlight?: TradeRecordsActionHighlight;
  onMarketFilterChange?: (value: TradeMarketType | "all") => void;
  onTypeFilterChange?: (value: TradeActionType | "all") => void;
  onDirectionFilterChange?: (value: "all" | "long" | "short" | "spot") => void;
  onContractFilterChange?: (value: string) => void;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  onRefresh?: () => void;
  onExportCsv?: () => void;
  onOrderIdCopy?: (orderId: string) => void;
  onTimeRangeClick?: () => void;
  onActionHighlightToggle?: (record: TradeRecordItem) => void;
  onActionJump?: (record: TradeRecordItem) => void;
  jumpTargetRecordKey?: string | null;
}

export interface TradeRecordsResponse {
  success: boolean;
  asOf: number;
  exchange?: "gate";
  marketType?: "all";
  settle?: "usdt";
  range?: {
    from: number;
    to: number;
    effectiveTo?: number;
  };
  batchLimit?: number;
  records?: TradeRecordItem[];
  summary?: TradeRecordsSummary;
  hasMoreHistory?: boolean;
  nextCursorTs?: number | null;
  connectionStatus?: TradeRecordsConnectionStatus;
  historyCoverage?: HistoryCoverage;
  cycles?: FuturesTradeCycle[];
  partialFailures?: Array<{ source: string; message: string }>;
  debugFeeFields?: Array<{
    currency_pair?: string | null;
    order_id?: string | null;
    fee?: string | null;
    fee_currency?: string | null;
    point_fee?: string | null;
    gt_fee?: string | null;
  }>;
  safeErrorMessage?: string;
}

export interface TradeRecordsFeeSummaryResponse {
  success: boolean;
  exchange?: "gate";
  asOf: number;
  range?: {
    from: number;
    to: number;
  };
  totalFeeUsd: string;
  yearRange?: {
    from: number;
    to: number;
  };
  yearTotalFeeUsd?: string;
  feeSources?: {
    spotUsd: string;
    futuresUsd: string;
    gtUsd: string;
    pointAmount?: string;
    unknownUsd: string;
  };
  connectionStatus?: TradeRecordsConnectionStatus;
  partialFailures?: Array<{ source: string; message: string }>;
  safeErrorMessage?: string;
}
