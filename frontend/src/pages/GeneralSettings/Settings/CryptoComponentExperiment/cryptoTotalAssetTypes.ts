export type CryptoConnectionStatus = "connected" | "degraded" | "disconnected";

export type CryptoBackgroundMode = "none" | "gradient" | "image";

export type CryptoChartTone = "green" | "gold" | "cyan";

export type CryptoLossChartTone = "red" | "gold" | "cyan";

export type CryptoTrendScenario = "profit" | "loss" | "mixed";

export interface CryptoTrendPoint {
  ts?: number;
  time: string;
  date?: string;
  value: number;
  deltaUsd?: number;
  deltaPct?: number;
  source?: "reconstructed" | "snapshot" | "poll" | "ws" | string;
  type?: string;
  exchange?: string;
  apiId?: string;
  apiName?: string;
  equityMode?: string;
  estimated?: boolean;
}

export interface CryptoTotalAssetCardProps {
  totalEquityUsd: number;
  todayPnlUsd: number;
  todayPnlPct: number;
  yesterdayChangePct: number;
  yesterdayBaselineUsd: number;
  connectionStatus: CryptoConnectionStatus;
  lastUpdatedAt: string;
  lastUpdatedDate?: string;
  latestSampleAt?: number | null;
  cardHeight: number;
  borderRadius: number;
  backgroundMode: CryptoBackgroundMode;
  backgroundImage?: string;
  showTrendChart: boolean;
  showEyeIcon: boolean;
  showStatusBadge: boolean;
  glowIntensity: number;
  chartTone: CryptoChartTone;
  profitChartTone: CryptoChartTone;
  lossChartTone: CryptoLossChartTone;
  trendPoints?: CryptoTrendPoint[];
  trendScenario: CryptoTrendScenario;
  numberSize: number;
  compactMode: boolean;
}
