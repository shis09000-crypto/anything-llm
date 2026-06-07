export type ExchangeId =
  | "gate"
  | "binance"
  | "okx"
  | "bybit"
  | "bitget"
  | "other";
export type AssetSymbol =
  | "BTC"
  | "ETH"
  | "SOL"
  | "USDT"
  | "USDC"
  | "LTC"
  | "XRP"
  | "OTHER";
export type AccountType = "spot" | "futures" | "funding" | "earn" | "finance";
export type RiskLevel = "safe" | "watch" | "danger";
export type PositionSide = "long" | "short" | "net";
export type OrderType =
  | "limit"
  | "market"
  | "conditional"
  | "take_profit_stop_loss";
export type AlertType =
  | "large_withdrawal"
  | "api_invalid"
  | "ws_disconnected"
  | "low_margin_ratio"
  | "liquidation_risk"
  | "abnormal_flow";

export interface KpiMetric {
  key: string;
  label: string;
  value: number;
  unit: "usd" | "pct" | "count" | "score";
  delta24h?: number;
  trend: Array<{ ts: number; value: number }>;
  tone: "positive" | "negative" | "neutral" | "risk";
}

export interface AssetAllocation {
  symbol: AssetSymbol;
  amount: number;
  equityUsd: number;
  pct: number;
}

export interface ExchangeAllocation {
  exchange: ExchangeId;
  totalEquityUsd: number;
  pct: number;
  todayChangeUsd: number;
  status: "connected" | "degraded" | "disconnected";
  latencyMs?: number | null;
}

export interface AccountNode {
  id: string;
  name: string;
  type: AccountType;
  exchange: ExchangeId;
  equityUsd: number;
  pct: number;
  riskLevel: RiskLevel;
}

export interface EquityPoint {
  ts: number;
  totalEquityUsd: number;
  nav: number;
  drawdownPct: number;
}

export interface PnlPoint {
  date: string;
  realizedUsd: number;
  unrealizedUsd: number;
  totalUsd: number;
}

export interface PositionRow {
  id: string;
  exchange: ExchangeId;
  symbol: string;
  side: PositionSide;
  quantity: number;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice?: number;
  unrealizedPnlUsd: number;
  marginRatio: number;
  riskLevel: RiskLevel;
}

export interface OrderSummary {
  type: OrderType;
  count: number;
  notionalUsd: number;
}

export interface TradeFill {
  id: string;
  ts: number;
  exchange: ExchangeId;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  feeUsd: number;
}

export interface EarnProduct {
  id: string;
  category: "flexible" | "fixed" | "staking" | "launchpool";
  asset: string;
  amountUsd: number;
  aprPct: number;
  accruedUsd: number;
  todayIncomeUsd: number;
}

export interface RiskScore {
  score: number;
  leverageScore: number;
  marginScore: number;
  assetConcentrationScore: number;
  accountConcentrationScore: number;
  liquidityScore: number;
  level: RiskLevel;
}

export interface AlertItem {
  id: string;
  ts: number;
  type: AlertType;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  read: boolean;
  sound: boolean;
}

export interface CryptoCenterSnapshot {
  asOf: number;
  kpis: KpiMetric[];
  assets: AssetAllocation[];
  exchanges: ExchangeAllocation[];
  accounts: AccountNode[];
  equity: EquityPoint[];
  pnl: PnlPoint[];
  positions: PositionRow[];
  orders: OrderSummary[];
  trades: TradeFill[];
  earn: EarnProduct[];
  risk: RiskScore;
  alerts: AlertItem[];
}

export type CryptoCenterEvent =
  | { type: "snapshot"; data: CryptoCenterSnapshot }
  | { type: "kpi:update"; data: Partial<KpiMetric> }
  | { type: "asset:update"; data: AssetAllocation[] }
  | { type: "position:update"; data: PositionRow[] }
  | { type: "order:update"; data: OrderSummary[] }
  | { type: "trade:append"; data: TradeFill }
  | { type: "risk:update"; data: RiskScore }
  | { type: "alert:append"; data: AlertItem }
  | { type: "connection:update"; data: ExchangeAllocation[] }
  | { type: "heartbeat"; ts: number };

export type TimeRange = "24h" | "7d" | "30d" | "90d" | "365d";
export type SocketStatus =
  | "connecting"
  | "connected"
  | "degraded"
  | "disconnected";
