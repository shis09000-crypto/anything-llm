import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import type {
  TradingPairCandlestickChartProps,
  TradingPairCandlestickRange,
  TradingPairVisibleWindow,
} from "./tradingPairCandlestickTypes";
import { useCryptoStatusLabel } from "./cryptoStatusI18n";

const DEFAULT_VISIBLE_CANDLES = 50;
const MIN_VISIBLE_CANDLES = 21;
const MAX_VISIBLE_CANDLES = 100;
const HISTORY_LOAD_THRESHOLD = 10;
const GRID_LINE_COLOR = "rgba(255,255,255,0.06)";
const GESTURE_LOCK_MS = 220;
const BROWSER_GESTURE_LOCK_MS = 500;
const WHEEL_NOISE_THRESHOLD = 2;
const PAN_DOMINANCE_RATIO = 1.35;
const PAN_DELTA_PER_CANDLE = 40;
const MIN_WHEEL_ZOOM_STEP = 0.08;
const MAX_WHEEL_ZOOM_STEP = 0.18;
const RESET_DATA_ZOOM_GUARD_MS = 900;
const USER_DATA_ZOOM_WINDOW_MS = 2_500;
const INDICATOR_STORAGE_KEY = "anythingllm.cryptoCandlestickIndicators.v1";
let indicatorPreferencesHydrated = false;
const RIGHT_PAD_RATIO = 0.5;
const LATEST_DEFAULT_RIGHT_PAD_CANDLES = 2;
const BTC_CHART_BACKGROUND_URL = "/crypto-chart-backgrounds/btc-background.png";

const rangeLabels: Record<TradingPairCandlestickRange, string> = {
  "15m": "15分钟",
  "1h": "1小时",
  "4h": "4小时",
  "1d": "1日",
  "7d": "7日",
  "30d": "30日",
};

const rangeOptions = Object.keys(rangeLabels) as TradingPairCandlestickRange[];

const marketLabels: Record<TradingPairCandlestickChartProps["market"], string> =
  {
    spot: "现货",
    futures: "合约",
    margin: "杠杆",
  };

const statusMeta: Record<
  TradingPairCandlestickChartProps["status"],
  { color: string; bg: string }
> = {
  connected: { color: "#22C55E", bg: "rgba(34,197,94,.10)" },
  degraded: { color: "#F4B23E", bg: "rgba(244,178,62,.10)" },
  disconnected: {
    color: "#EF4444",
    bg: "rgba(239,68,68,.10)",
  },
};

type ZoomWindow = {
  startValue: number;
  endValue: number;
};

type ChartRow = {
  index: number;
  category: string;
  ts: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

type GestureType = "pan" | "zoom";
type ZoomDirection = "in" | "out";

type GestureLock = {
  type: GestureType;
  zoomDirection: ZoomDirection | null;
  expiresAt: number;
};

type WheelAccumulator = {
  panDelta: number;
  zoomDelta: number;
  focusRatio: number;
};

type BrowserGestureLock = {
  expiresAt: number;
  releaseTimer: number | null;
  rootStyles: {
    htmlOverscrollBehaviorX: string;
    bodyOverscrollBehaviorX: string;
  } | null;
};

type DataZoomPayload = {
  start?: number;
  end?: number;
  startValue?: number | string;
  endValue?: number | string;
  batch?: Array<{
    start?: number;
    end?: number;
    startValue?: number | string;
    endValue?: number | string;
  }>;
};

type IndicatorPreferences = {
  showMA: boolean;
  showBoll: boolean;
};

type ExtremaPoint = {
  index: number;
  labelIndex: number;
  value: number;
  label: string;
};

type CurrentMovingAverageValues = {
  ma5: number | null;
  ma10: number | null;
  ma30: number | null;
};

const EMPTY_SERIES_VALUE = "-" as const;
type EmptySeriesValue = typeof EMPTY_SERIES_VALUE;
type CandleSeriesValue =
  | [number, number, number, number]
  | [EmptySeriesValue, EmptySeriesValue, EmptySeriesValue, EmptySeriesValue];
type VolumeSeriesValue =
  | {
      value: number;
      itemStyle: {
        color: string;
      };
    }
  | EmptySeriesValue;

function numeric(value: string | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rgba(hex = "#D6A84F", opacity = 1) {
  const normalized = hex.replace("#", "");
  if (!/^[0-9A-Fa-f]{6}$/.test(normalized)) {
    return `rgba(214,168,79,${opacity})`;
  }
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

function formatMoney(value: string | null | undefined, quoteAsset: string) {
  const number = numeric(value);
  if (number === null) return "--";
  const decimals = Math.abs(number) >= 100 ? 2 : Math.abs(number) >= 1 ? 4 : 6;
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(number);
  return `${quoteAsset === "USDT" || quoteAsset === "USD" ? "$" : ""}${formatted}`;
}

function formatPct(value: string | null | undefined) {
  const number = numeric(value);
  if (number === null) return "--";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatAxisTime(ts: number, range: TradingPairCandlestickRange) {
  const date = new Date(ts);
  const monthDay = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  if (range === "1d" || range === "7d" || range === "30d") return monthDay;

  const hourMinute = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return hourMinute;
}

function formatTooltipTime(ts: number, range: TradingPairCandlestickRange) {
  const date = new Date(ts);
  const datePart = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )}`;
  const timePart =
    range === "15m"
      ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
          date.getSeconds()
        )}`
      : `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return `${datePart} ${timePart}`;
}

function formatVolumeAxis(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    value
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function windowAroundCenter(
  center: number,
  visibleCount: number,
  candleCount: number
): ZoomWindow {
  if (candleCount <= 0) return { startValue: 0, endValue: 0 };

  const boundedVisible = clamp(
    Math.round(visibleCount),
    1,
    Math.max(1, candleCount)
  );
  const maxStart = Math.max(0, candleCount - boundedVisible);
  const startValue = clamp(
    Math.round(center - (boundedVisible - 1) / 2),
    0,
    maxStart
  );
  return {
    startValue,
    endValue: Math.min(candleCount - 1, startValue + boundedVisible - 1),
  };
}

function windowAroundFocus(
  focusIndex: number,
  focusRatio: number,
  visibleCount: number,
  candleCount: number
): ZoomWindow {
  if (candleCount <= 0) return { startValue: 0, endValue: 0 };

  const boundedVisible = clamp(
    Math.round(visibleCount),
    1,
    Math.max(1, candleCount)
  );
  const maxStart = Math.max(0, candleCount - boundedVisible);
  const startValue = clamp(
    Math.round(focusIndex - (boundedVisible - 1) * focusRatio),
    0,
    maxStart
  );
  return {
    startValue,
    endValue: Math.min(candleCount - 1, startValue + boundedVisible - 1),
  };
}

function normalizeZoomWindow(
  candidate: ZoomWindow,
  candleCount: number
): ZoomWindow {
  if (candleCount <= 0) return { startValue: 0, endValue: 0 };

  let startValue = clamp(Math.round(candidate.startValue), 0, candleCount - 1);
  let endValue = clamp(Math.round(candidate.endValue), 0, candleCount - 1);
  if (endValue < startValue) [startValue, endValue] = [endValue, startValue];

  const visibleCount = endValue - startValue + 1;
  const minVisible = Math.min(MIN_VISIBLE_CANDLES, candleCount);
  const maxVisible = Math.min(MAX_VISIBLE_CANDLES, candleCount);
  if (visibleCount >= minVisible && visibleCount <= maxVisible) {
    return { startValue, endValue };
  }

  const targetVisible = clamp(visibleCount, minVisible, maxVisible);
  const center = (startValue + endValue) / 2;
  return windowAroundCenter(center, targetVisible, candleCount);
}

function latestZoomWindow(candleCount: number): ZoomWindow {
  if (candleCount <= 0) return { startValue: 0, endValue: 0 };
  const visibleCount = Math.min(
    DEFAULT_VISIBLE_CANDLES,
    candleCount + LATEST_DEFAULT_RIGHT_PAD_CANDLES
  );
  const maxRightPadCount = rightPadCount(visibleCount, candleCount);
  const rightPad = Math.min(LATEST_DEFAULT_RIGHT_PAD_CANDLES, maxRightPadCount);
  const endValue = candleCount - 1 + rightPad;
  return {
    startValue: Math.max(0, endValue - visibleCount + 1),
    endValue,
  };
}

function rightPadCount(visibleCount: number, candleCount: number) {
  if (candleCount <= 0) return 0;
  return Math.max(1, Math.ceil(visibleCount * RIGHT_PAD_RATIO));
}

function virtualCategoryCount(candleCount: number, visibleCount: number) {
  return candleCount + rightPadCount(visibleCount, candleCount);
}

function normalizeVirtualZoomWindow(
  candidate: ZoomWindow,
  categoryCount: number
): ZoomWindow {
  return normalizeZoomWindow(candidate, categoryCount);
}

function latestVisibleRealIndex(window: ZoomWindow, candleCount: number) {
  if (candleCount <= 0) return null;
  const startValue = clamp(window.startValue, 0, candleCount - 1);
  const endValue = clamp(window.endValue, startValue, candleCount - 1);
  return endValue;
}

function windowIncludesLatestRealCandle(
  window: ZoomWindow,
  candleCount: number
) {
  if (candleCount <= 0) return false;
  const latestRealIndex = candleCount - 1;
  return (
    window.startValue <= latestRealIndex && window.endValue >= latestRealIndex
  );
}

function isLatestZoomWindow(window: ZoomWindow, candleCount: number) {
  return sameZoomWindow(window, latestZoomWindow(candleCount));
}

function padSeriesData<T>(
  data: T[],
  totalLength: number,
  emptyValueFactory: () => T
): T[] {
  if (data.length >= totalLength) return data;
  return [
    ...data,
    ...Array.from({ length: totalLength - data.length }, emptyValueFactory),
  ];
}

function sameZoomWindow(left: ZoomWindow, right: ZoomWindow) {
  return (
    left.startValue === right.startValue && left.endValue === right.endValue
  );
}

function isLocalDebugRuntime() {
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "0.0.0.0"].includes(
    window.location.hostname
  );
}

function visibleCountFromWindow(window: ZoomWindow) {
  return Math.max(1, window.endValue - window.startValue + 1);
}

function axisLabelInterval(visibleCount: number) {
  const targetLabels = visibleCount <= 30 ? 6 : visibleCount <= 60 ? 8 : 10;
  return Math.max(0, Math.ceil(visibleCount / targetLabels) - 1);
}

function categoryValueForIndex(index: number) {
  return String(index);
}

function indexFromCategoryValue(
  value: number | string | undefined,
  candleCount: number
) {
  if (value === undefined || candleCount <= 0) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const index = Math.round(number);
  return index >= 0 && index < candleCount ? index : null;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function tooltipRow(label: string, value: string, color: string) {
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:28px;line-height:22px;">
    <span style="display:flex;align-items:center;gap:7px;color:rgba(248,250,252,.78);">
      <span style="width:6px;height:6px;border-radius:999px;background:${color};display:inline-block;"></span>${label}
    </span>
    <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:800;color:#F8FAFC;">${value}</span>
  </div>`;
}

function formatTooltipNumber(value: string | number | null | undefined) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.abs(number) >= 100 ? 2 : 6,
  }).format(number);
}

function dataModeLabel(mode: TradingPairCandlestickChartProps["mode"]) {
  return mode === "mock" ? "模拟数据" : "Gate 数据";
}

function readIndicatorPreferences(): IndicatorPreferences {
  if (typeof window === "undefined") return { showMA: false, showBoll: false };
  if (!indicatorPreferencesHydrated) {
    indicatorPreferencesHydrated = true;
    import("@/utils/userStateSync")
      .then(({ hydrateUserStateValue, USER_STATE_NAMESPACES }) =>
        hydrateUserStateValue({
          namespace: USER_STATE_NAMESPACES.cryptoUi,
          fallback: {
            candlestickIndicators: readIndicatorPreferences(),
          },
          apply: (value: { candlestickIndicators?: IndicatorPreferences }) => {
            if (!value?.candlestickIndicators) return;
            window.localStorage.setItem(
              INDICATOR_STORAGE_KEY,
              JSON.stringify(value.candlestickIndicators)
            );
          },
        })
      )
      .catch(() => {});
  }

  try {
    const raw = window.localStorage.getItem(INDICATOR_STORAGE_KEY);
    if (!raw) return { showMA: false, showBoll: false };

    const parsed = JSON.parse(raw) as Partial<IndicatorPreferences>;
    return {
      showMA: Boolean(parsed.showMA),
      showBoll: Boolean(parsed.showBoll),
    };
  } catch {
    return { showMA: false, showBoll: false };
  }
}

function writeIndicatorPreferences(preferences: IndicatorPreferences) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      INDICATOR_STORAGE_KEY,
      JSON.stringify(preferences)
    );
    import("@/utils/userStateSync")
      .then(({ pushUserStateValue, USER_STATE_NAMESPACES }) =>
        pushUserStateValue(
          USER_STATE_NAMESPACES.cryptoUi,
          "global",
          { candlestickIndicators: preferences },
          { debounceMs: 1_000 }
        )
      )
      .catch(() => {});
  } catch {
    // Non-critical: the chart should remain usable even if localStorage is unavailable.
  }
}

function calculateMovingAverage(rows: ChartRow[], period: number) {
  const result = Array<number | null>(rows.length).fill(null);
  let runningSum = 0;
  const closes: number[] = [];

  rows.forEach((row, index) => {
    const close = Number(row.close);
    closes.push(close);
    if (Number.isFinite(close)) runningSum += close;

    if (index >= period) {
      const removed = closes[index - period];
      if (Number.isFinite(removed)) runningSum -= removed;
    }

    if (index >= period - 1) {
      const window = closes.slice(index - period + 1, index + 1);
      if (window.every(Number.isFinite)) result[index] = runningSum / period;
    }
  });

  return result;
}

function calculateBollingerBands(
  rows: ChartRow[],
  period = 20,
  multiplier = 2
) {
  const middle = Array<number | null>(rows.length).fill(null);
  const upper = Array<number | null>(rows.length).fill(null);
  const lower = Array<number | null>(rows.length).fill(null);
  const closes = rows.map((row) => Number(row.close));

  closes.forEach((close, index) => {
    if (!Number.isFinite(close) || index < period - 1) return;

    const window = closes.slice(index - period + 1, index + 1);
    if (!window.every(Number.isFinite)) return;

    const average =
      window.reduce((sum, value) => sum + value, 0) / Math.max(1, period);
    const variance =
      window.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      Math.max(1, period);
    const deviation = Math.sqrt(variance);

    middle[index] = average;
    upper[index] = average + deviation * multiplier;
    lower[index] = average - deviation * multiplier;
  });

  return { middle, upper, lower };
}

function indicatorButtonStyle(active: boolean, accentColor: string) {
  return active
    ? {
        borderColor: accentColor,
        backgroundColor: accentColor,
        color: "#111111",
        boxShadow: `0 12px 28px ${rgba(accentColor, 0.16)}`,
      }
    : {
        borderColor: "rgba(255,255,255,.12)",
        backgroundColor: "rgba(255,255,255,.035)",
        color: "#F8FAFC",
      };
}

function formatIndicatorValue(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.abs(value) >= 100 ? 2 : 6,
  }).format(value);
}

function isBitcoinPair({
  baseAsset,
  pair,
  symbol,
}: Pick<TradingPairCandlestickChartProps, "baseAsset" | "pair" | "symbol">) {
  const normalizedBaseAsset = baseAsset.trim().toUpperCase();
  const normalizedPair = pair.trim().toUpperCase();
  const normalizedSymbol = symbol.trim().toUpperCase();
  return (
    normalizedBaseAsset === "BTC" ||
    normalizedPair.startsWith("BTC_") ||
    normalizedPair.startsWith("BTC-") ||
    normalizedPair.startsWith("BTC/") ||
    normalizedSymbol.startsWith("BTC/")
  );
}

export default function TradingPairCandlestickChart({
  mode,
  pair,
  range,
  market,
  baseAsset,
  quoteAsset,
  symbol,
  assetName,
  assetNameCn,
  iconText,
  iconImage,
  iconSize,
  iconCropScale,
  iconCropX,
  iconCropY,
  candles,
  currentPriceQuote,
  currentPriceUsd,
  change24hPct,
  status,
  autoRefreshSeconds,
  showVolume,
  showCrosshair,
  showCurrentPriceLine,
  showGrid,
  compactMode,
  cardHeight,
  borderRadius,
  glowIntensity,
  accentColor,
  chartBackgroundImage = null,
  loading = false,
  historyLoading = false,
  error = null,
  onRangeChange,
  onLoadMoreHistory,
}: TradingPairCandlestickChartProps) {
  const chartRef = useRef<any>(null);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingRestoreRef = useRef<TradingPairVisibleWindow | null>(null);
  const pendingRequestIdRef = useRef(0);
  const dispatchingRef = useRef(false);
  const appliedResetKeyRef = useRef<string | null>(null);
  const pendingLatestResetRef = useRef<string | null>(null);
  const latestAnchorRef = useRef(true);
  const ignoringDataZoomUntilRef = useRef(0);
  const userDataZoomUntilRef = useRef(0);
  const gestureLockRef = useRef<GestureLock | null>(null);
  const browserGestureLockRef = useRef<BrowserGestureLock>({
    expiresAt: 0,
    releaseTimer: null,
    rootStyles: null,
  });
  const wheelAccumulatorRef = useRef<WheelAccumulator>({
    panDelta: 0,
    zoomDelta: 0,
    focusRatio: 0.5,
  });
  const wheelRafRef = useRef<number | null>(null);
  const [zoomWindow, setZoomWindow] = useState(() =>
    latestZoomWindow(candles.length)
  );
  const [rangeMenuOpen, setRangeMenuOpen] = useState(false);
  const [indicatorPreferences, setIndicatorPreferences] = useState(
    readIndicatorPreferences
  );

  const resetKey = `${mode}:${pair}:${range}:${market}`;
  const price = currentPriceQuote || candles[candles.length - 1]?.close || null;
  const change = numeric(change24hPct);
  const statusDisplay = statusMeta[status];
  const statusLabel = useCryptoStatusLabel(status);
  const coinSize = compactMode
    ? Math.max(56, Math.min(iconSize + 6, 72))
    : Math.max(70, Math.min(iconSize + 18, 86));
  const coinScale = Math.max(0.6, Math.min(iconCropScale, 2.4));
  const assetDisplayName = assetNameCn
    ? `${assetName} / ${assetNameCn}`
    : assetName;
  const chartBackgroundImageUrl =
    chartBackgroundImage ||
    (isBitcoinPair({
      baseAsset,
      pair,
      symbol,
    })
      ? BTC_CHART_BACKGROUND_URL
      : null);
  const chartRows = useMemo<ChartRow[]>(
    () =>
      candles.map((candle, index) => ({
        index,
        category: categoryValueForIndex(index),
        ts: candle.ts,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      })),
    [candles]
  );
  const zoomVisibleCount = visibleCountFromWindow(zoomWindow);
  const totalCategoryCount = virtualCategoryCount(
    chartRows.length,
    zoomVisibleCount
  );
  const categories = useMemo(
    () =>
      Array.from({ length: totalCategoryCount }, (_, index) =>
        categoryValueForIndex(index)
      ),
    [totalCategoryCount]
  );
  const candleData = useMemo<Array<CandleSeriesValue>>(
    () =>
      padSeriesData(
        chartRows.map(
          (row) =>
            [
              Number(row.open),
              Number(row.close),
              Number(row.low),
              Number(row.high),
            ] as CandleSeriesValue
        ),
        totalCategoryCount,
        () => [
          EMPTY_SERIES_VALUE,
          EMPTY_SERIES_VALUE,
          EMPTY_SERIES_VALUE,
          EMPTY_SERIES_VALUE,
        ]
      ),
    [chartRows, totalCategoryCount]
  );
  const volumeData = useMemo<Array<VolumeSeriesValue>>(
    () =>
      padSeriesData<VolumeSeriesValue>(
        chartRows.map((row) => ({
          value: Number(row.volume),
          itemStyle: {
            color:
              Number(row.close) >= Number(row.open)
                ? "rgba(34,197,94,.70)"
                : "rgba(239,68,68,.72)",
          },
        })),
        totalCategoryCount,
        () => EMPTY_SERIES_VALUE
      ),
    [chartRows, totalCategoryCount]
  );
  const ma5Data = useMemo(
    () => calculateMovingAverage(chartRows, 5),
    [chartRows]
  );
  const ma10Data = useMemo(
    () => calculateMovingAverage(chartRows, 10),
    [chartRows]
  );
  const ma30Data = useMemo(
    () => calculateMovingAverage(chartRows, 30),
    [chartRows]
  );
  const bollData = useMemo(
    () => calculateBollingerBands(chartRows, 20, 2),
    [chartRows]
  );
  const paddedMa5Data = useMemo(
    () => padSeriesData<number | null>(ma5Data, totalCategoryCount, () => null),
    [ma5Data, totalCategoryCount]
  );
  const paddedMa10Data = useMemo(
    () =>
      padSeriesData<number | null>(ma10Data, totalCategoryCount, () => null),
    [ma10Data, totalCategoryCount]
  );
  const paddedMa30Data = useMemo(
    () =>
      padSeriesData<number | null>(ma30Data, totalCategoryCount, () => null),
    [ma30Data, totalCategoryCount]
  );
  const paddedBollData = useMemo(
    () => ({
      upper: padSeriesData<number | null>(
        bollData.upper,
        totalCategoryCount,
        () => null
      ),
      middle: padSeriesData<number | null>(
        bollData.middle,
        totalCategoryCount,
        () => null
      ),
      lower: padSeriesData<number | null>(
        bollData.lower,
        totalCategoryCount,
        () => null
      ),
    }),
    [bollData.lower, bollData.middle, bollData.upper, totalCategoryCount]
  );
  const visibleExtrema = useMemo<{
    high: ExtremaPoint;
    low: ExtremaPoint;
  } | null>(() => {
    if (!chartRows.length) return null;

    const startValue = clamp(
      zoomWindow.startValue,
      0,
      Math.max(0, chartRows.length - 1)
    );
    const endValue = clamp(
      zoomWindow.endValue,
      startValue,
      Math.max(0, chartRows.length - 1)
    );
    let highValue = -Infinity;
    let lowValue = Infinity;
    let highIndex = startValue;
    let lowIndex = startValue;

    for (let index = startValue; index <= endValue; index += 1) {
      const high = Number(chartRows[index]?.high);
      const low = Number(chartRows[index]?.low);
      if (Number.isFinite(high) && high > highValue) {
        highValue = high;
        highIndex = index;
      }
      if (Number.isFinite(low) && low < lowValue) {
        lowValue = low;
        lowIndex = index;
      }
    }

    if (!Number.isFinite(highValue) || !Number.isFinite(lowValue)) return null;

    const labelOffset = endValue - startValue <= 25 ? 2 : 4;
    const labelIndexFor = (index: number) => {
      if (index + labelOffset <= endValue) return index + labelOffset;
      if (index - labelOffset >= startValue) return index - labelOffset;
      return index;
    };

    return {
      high: {
        index: highIndex,
        labelIndex: labelIndexFor(highIndex),
        value: highValue,
        label: formatTooltipNumber(highValue),
      },
      low: {
        index: lowIndex,
        labelIndex: labelIndexFor(lowIndex),
        value: lowValue,
        label: formatTooltipNumber(lowValue),
      },
    };
  }, [chartRows, zoomWindow.endValue, zoomWindow.startValue]);
  const currentMAValues = useMemo<CurrentMovingAverageValues>(() => {
    const index = latestVisibleRealIndex(zoomWindow, chartRows.length);
    if (index === null) {
      return { ma5: null, ma10: null, ma30: null };
    }
    return {
      ma5: ma5Data[index] ?? null,
      ma10: ma10Data[index] ?? null,
      ma30: ma30Data[index] ?? null,
    };
  }, [
    chartRows.length,
    ma10Data,
    ma30Data,
    ma5Data,
    zoomWindow.endValue,
    zoomWindow.startValue,
  ]);
  const labelInterval = axisLabelInterval(zoomVisibleCount);
  const minValueSpan = Math.min(
    Math.max(0, totalCategoryCount - 1),
    MIN_VISIBLE_CANDLES - 1
  );
  const maxValueSpan = Math.min(
    Math.max(0, totalCategoryCount - 1),
    MAX_VISIBLE_CANDLES - 1
  );

  function dispatchZoom(nextWindow: ZoomWindow) {
    const instance = chartRef.current?.getEchartsInstance?.();
    if (!instance || !candles.length) return;

    dispatchingRef.current = true;
    instance.dispatchAction({
      type: "dataZoom",
      startValue: categoryValueForIndex(nextWindow.startValue),
      endValue: categoryValueForIndex(nextWindow.endValue),
    });
    window.setTimeout(() => {
      dispatchingRef.current = false;
    }, 0);
  }

  function applyZoomWindow(
    nextWindow: ZoomWindow,
    shouldCheckHistory = true,
    options: { userInteraction?: boolean } = {}
  ) {
    const normalized = normalizeVirtualZoomWindow(
      nextWindow,
      totalCategoryCount
    );
    if (options.userInteraction) {
      latestAnchorRef.current = isLatestZoomWindow(normalized, candles.length);
    }
    setZoomWindow(normalized);
    dispatchZoom(normalized);
    if (shouldCheckHistory) maybeLoadMoreHistory(normalized);
  }

  function toggleIndicator(key: keyof IndicatorPreferences) {
    setIndicatorPreferences((current) => {
      const next = { ...current, [key]: !current[key] };
      writeIndicatorPreferences(next);
      return next;
    });
  }

  function visibleWindowFor(nextWindow: ZoomWindow): TradingPairVisibleWindow {
    if (!candles.length) {
      return { visibleStartTs: null, visibleEndTs: null };
    }

    const startIndex = clamp(nextWindow.startValue, 0, candles.length - 1);
    const endIndex = clamp(nextWindow.endValue, startIndex, candles.length - 1);
    return {
      visibleStartTs: candles[startIndex]?.ts ?? null,
      visibleEndTs: candles[endIndex]?.ts ?? null,
    };
  }

  function isResetGuardActive() {
    return (
      pendingLatestResetRef.current === resetKey ||
      appliedResetKeyRef.current !== resetKey ||
      Date.now() < ignoringDataZoomUntilRef.current
    );
  }

  function markUserDataZoomInteraction() {
    userDataZoomUntilRef.current = Date.now() + USER_DATA_ZOOM_WINDOW_MS;
  }

  function maybeLoadMoreHistory(nextWindow: ZoomWindow) {
    if (
      isResetGuardActive() ||
      nextWindow.startValue >= HISTORY_LOAD_THRESHOLD ||
      historyLoading ||
      pendingRestoreRef.current ||
      !candles[0]?.ts ||
      !onLoadMoreHistory
    ) {
      return;
    }

    const visibleWindow = visibleWindowFor(nextWindow);
    pendingRestoreRef.current = visibleWindow;
    const requestId = pendingRequestIdRef.current + 1;
    pendingRequestIdRef.current = requestId;

    Promise.resolve(onLoadMoreHistory(candles[0].ts, visibleWindow)).catch(
      () => {
        if (pendingRequestIdRef.current === requestId) {
          pendingRestoreRef.current = null;
        }
      }
    );
    window.setTimeout(() => {
      if (pendingRequestIdRef.current === requestId && !historyLoading) {
        pendingRestoreRef.current = null;
      }
    }, 10_000);
  }

  function zoomFromPayload(payload: DataZoomPayload): ZoomWindow | null {
    if (!totalCategoryCount) return null;

    const startByValue = indexFromCategoryValue(
      payload.startValue,
      totalCategoryCount
    );
    const endByValue = indexFromCategoryValue(
      payload.endValue,
      totalCategoryCount
    );
    if (startByValue !== null && endByValue !== null) {
      return { startValue: startByValue, endValue: endByValue };
    }

    if (typeof payload.start === "number" && typeof payload.end === "number") {
      const maxIndex = Math.max(0, totalCategoryCount - 1);
      return {
        startValue: Math.round((payload.start / 100) * maxIndex),
        endValue: Math.round((payload.end / 100) * maxIndex),
      };
    }

    return null;
  }

  function handleDataZoom(event: DataZoomPayload) {
    if (dispatchingRef.current) return;
    if (isResetGuardActive()) return;
    if (Date.now() > userDataZoomUntilRef.current) return;

    const payload = event.batch?.[0] || event;
    const nextWindow = zoomFromPayload(payload);
    if (!nextWindow) return;

    const normalized = normalizeVirtualZoomWindow(
      nextWindow,
      totalCategoryCount
    );
    latestAnchorRef.current = isLatestZoomWindow(normalized, candles.length);
    setZoomWindow(normalized);
    if (!sameZoomWindow(normalized, nextWindow)) dispatchZoom(normalized);
    maybeLoadMoreHistory(normalized);
  }

  function chartContainsEventTarget(target: EventTarget | null) {
    const node = chartContainerRef.current;
    if (!node || !target || typeof Node === "undefined") return false;
    return target instanceof Node && node.contains(target);
  }

  function lockRootHorizontalOverscroll() {
    const lock = browserGestureLockRef.current;
    if (!lock.rootStyles) {
      lock.rootStyles = {
        htmlOverscrollBehaviorX:
          document.documentElement.style.overscrollBehaviorX,
        bodyOverscrollBehaviorX: document.body.style.overscrollBehaviorX,
      };
    }
    document.documentElement.style.overscrollBehaviorX = "none";
    document.body.style.overscrollBehaviorX = "none";
  }

  function restoreRootHorizontalOverscroll() {
    const lock = browserGestureLockRef.current;
    if (!lock.rootStyles) return;
    document.documentElement.style.overscrollBehaviorX =
      lock.rootStyles.htmlOverscrollBehaviorX;
    document.body.style.overscrollBehaviorX =
      lock.rootStyles.bodyOverscrollBehaviorX;
    lock.rootStyles = null;
  }

  function releaseBrowserGestureLock() {
    const lock = browserGestureLockRef.current;
    lock.releaseTimer = null;
    lock.expiresAt = 0;
    restoreRootHorizontalOverscroll();
  }

  function activateBrowserGestureLock() {
    const lock = browserGestureLockRef.current;
    lock.expiresAt = Date.now() + BROWSER_GESTURE_LOCK_MS;
    lockRootHorizontalOverscroll();
    if (lock.releaseTimer !== null) window.clearTimeout(lock.releaseTimer);
    lock.releaseTimer = window.setTimeout(
      releaseBrowserGestureLock,
      BROWSER_GESTURE_LOCK_MS
    );
  }

  function isBrowserGestureLocked() {
    return Date.now() < browserGestureLockRef.current.expiresAt;
  }

  function forceReleaseBrowserGestureLock() {
    const lock = browserGestureLockRef.current;
    lock.expiresAt = 0;
    if (lock.releaseTimer !== null) window.clearTimeout(lock.releaseTimer);
    lock.releaseTimer = null;
    restoreRootHorizontalOverscroll();
  }

  function classifyWheelGesture(event: React.WheelEvent<HTMLDivElement>): {
    type: GestureType;
    delta: number;
    focusRatio: number;
    zoomDirection: ZoomDirection | null;
  } | null {
    const rect = event.currentTarget.getBoundingClientRect();
    const focusRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const absX = Math.abs(event.deltaX);
    const absY = Math.abs(event.deltaY);
    const isPinchZoom = event.ctrlKey || event.metaKey;

    if (isPinchZoom && absY >= WHEEL_NOISE_THRESHOLD) {
      return {
        type: "zoom",
        delta: event.deltaY,
        focusRatio,
        zoomDirection: event.deltaY < 0 ? "in" : "out",
      };
    }

    if (absX >= WHEEL_NOISE_THRESHOLD && absX >= absY * PAN_DOMINANCE_RATIO) {
      return {
        type: "pan",
        delta: event.deltaX,
        focusRatio,
        zoomDirection: null,
      };
    }

    if (event.shiftKey && absY >= WHEEL_NOISE_THRESHOLD) {
      return {
        type: "pan",
        delta: event.deltaY,
        focusRatio,
        zoomDirection: null,
      };
    }

    return null;
  }

  function lockWheelGesture(gesture: {
    type: GestureType;
    zoomDirection: ZoomDirection | null;
  }) {
    const now = Date.now();
    const currentLock = gestureLockRef.current;
    if (!currentLock || currentLock.expiresAt < now) {
      wheelAccumulatorRef.current = {
        panDelta: 0,
        zoomDelta: 0,
        focusRatio: 0.5,
      };
      gestureLockRef.current = {
        type: gesture.type,
        zoomDirection: gesture.zoomDirection,
        expiresAt: now + GESTURE_LOCK_MS,
      };
      return true;
    }

    currentLock.expiresAt = now + GESTURE_LOCK_MS;
    if (currentLock.type !== gesture.type) return false;
    if (
      currentLock.type === "zoom" &&
      currentLock.zoomDirection !== gesture.zoomDirection
    ) {
      return false;
    }
    return true;
  }

  function scheduleWheelFlush() {
    if (wheelRafRef.current !== null) return;
    wheelRafRef.current = window.requestAnimationFrame(() => {
      wheelRafRef.current = null;
      flushWheelGesture();
    });
  }

  function flushWheelGesture() {
    const lock = gestureLockRef.current;
    if (!lock || !candles.length) return;

    const accumulator = wheelAccumulatorRef.current;
    if (lock.type === "pan") {
      const barDelta = Math.trunc(accumulator.panDelta / PAN_DELTA_PER_CANDLE);
      if (!barDelta) return;

      accumulator.panDelta -= barDelta * PAN_DELTA_PER_CANDLE;
      const visibleCount = visibleCountFromWindow(zoomWindow);
      const maxStart = Math.max(0, totalCategoryCount - visibleCount);
      const startValue = clamp(zoomWindow.startValue + barDelta, 0, maxStart);
      applyZoomWindow(
        {
          startValue,
          endValue: Math.min(
            totalCategoryCount - 1,
            startValue + visibleCount - 1
          ),
        },
        true,
        { userInteraction: true }
      );
      return;
    }

    const zoomDelta = accumulator.zoomDelta;
    accumulator.zoomDelta = 0;
    if (Math.abs(zoomDelta) < WHEEL_NOISE_THRESHOLD) return;

    const visibleCount = visibleCountFromWindow(zoomWindow);
    const focusRatio = accumulator.focusRatio;
    const focusIndex = zoomWindow.startValue + (visibleCount - 1) * focusRatio;
    const zoomStep = clamp(
      Math.abs(zoomDelta) / 420,
      MIN_WHEEL_ZOOM_STEP,
      MAX_WHEEL_ZOOM_STEP
    );
    const targetVisible =
      lock.zoomDirection === "in"
        ? visibleCount * (1 - zoomStep)
        : visibleCount * (1 + zoomStep);
    const boundedVisible = clamp(
      Math.round(targetVisible),
      Math.min(MIN_VISIBLE_CANDLES, totalCategoryCount),
      Math.min(MAX_VISIBLE_CANDLES, totalCategoryCount)
    );

    applyZoomWindow(
      windowAroundFocus(
        focusIndex,
        focusRatio,
        boundedVisible,
        totalCategoryCount
      ),
      true,
      { userInteraction: true }
    );
  }

  function handleChartWheel(event: React.WheelEvent<HTMLDivElement>) {
    activateBrowserGestureLock();
    markUserDataZoomInteraction();
    event.preventDefault();

    const gesture = classifyWheelGesture(event);
    if (!gesture || !candles.length) return;

    event.stopPropagation();
    if (!lockWheelGesture(gesture)) return;

    wheelAccumulatorRef.current.focusRatio = gesture.focusRatio;
    if (gesture.type === "pan") {
      wheelAccumulatorRef.current.panDelta += gesture.delta;
    } else {
      wheelAccumulatorRef.current.zoomDelta += gesture.delta;
    }
    scheduleWheelFlush();
  }

  function restoreWindowFromTimestamps(window: TradingPairVisibleWindow) {
    if (!candles.length || !window.visibleStartTs || !window.visibleEndTs) {
      return latestZoomWindow(candles.length);
    }

    let startValue = candles.findIndex(
      (candle) => candle.ts >= Number(window.visibleStartTs)
    );
    if (startValue < 0) startValue = 0;

    let endValue = -1;
    for (let index = candles.length - 1; index >= 0; index -= 1) {
      if (candles[index].ts <= Number(window.visibleEndTs)) {
        endValue = index;
        break;
      }
    }
    if (endValue < startValue) {
      endValue = Math.min(
        candles.length - 1,
        startValue + DEFAULT_VISIBLE_CANDLES - 1
      );
    }

    return normalizeZoomWindow({ startValue, endValue }, candles.length);
  }

  useEffect(() => {
    pendingRestoreRef.current = null;
    pendingRequestIdRef.current += 1;
    appliedResetKeyRef.current = null;
    pendingLatestResetRef.current = resetKey;
    latestAnchorRef.current = true;
    ignoringDataZoomUntilRef.current = Date.now() + RESET_DATA_ZOOM_GUARD_MS;
    gestureLockRef.current = null;
    wheelAccumulatorRef.current = {
      panDelta: 0,
      zoomDelta: 0,
      focusRatio: 0.5,
    };
    if (wheelRafRef.current !== null) {
      window.cancelAnimationFrame(wheelRafRef.current);
      wheelRafRef.current = null;
    }
    userDataZoomUntilRef.current = 0;
  }, [resetKey]);

  useEffect(
    () => () => {
      if (wheelRafRef.current !== null) {
        window.cancelAnimationFrame(wheelRafRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const preventBrowserGesture = (event: Event) => {
      if (
        !chartContainsEventTarget(event.target) &&
        !isBrowserGestureLocked()
      ) {
        return;
      }
      activateBrowserGestureLock();
      event.preventDefault();
    };
    const preventBrowserWheelGesture = (event: WheelEvent) => {
      if (
        !chartContainsEventTarget(event.target) &&
        !isBrowserGestureLocked()
      ) {
        return;
      }
      activateBrowserGestureLock();
      event.preventDefault();
    };
    const captureOptions = {
      capture: true,
      passive: false,
    } as AddEventListenerOptions;

    window.addEventListener(
      "wheel",
      preventBrowserWheelGesture,
      captureOptions
    );
    document.addEventListener(
      "wheel",
      preventBrowserWheelGesture,
      captureOptions
    );
    window.addEventListener(
      "gesturestart",
      preventBrowserGesture,
      captureOptions
    );
    window.addEventListener(
      "gesturechange",
      preventBrowserGesture,
      captureOptions
    );
    window.addEventListener(
      "gestureend",
      preventBrowserGesture,
      captureOptions
    );
    document.addEventListener(
      "gesturestart",
      preventBrowserGesture,
      captureOptions
    );
    document.addEventListener(
      "gesturechange",
      preventBrowserGesture,
      captureOptions
    );
    document.addEventListener(
      "gestureend",
      preventBrowserGesture,
      captureOptions
    );

    return () => {
      window.removeEventListener(
        "wheel",
        preventBrowserWheelGesture,
        captureOptions
      );
      document.removeEventListener(
        "wheel",
        preventBrowserWheelGesture,
        captureOptions
      );
      window.removeEventListener(
        "gesturestart",
        preventBrowserGesture,
        captureOptions
      );
      window.removeEventListener(
        "gesturechange",
        preventBrowserGesture,
        captureOptions
      );
      window.removeEventListener(
        "gestureend",
        preventBrowserGesture,
        captureOptions
      );
      document.removeEventListener(
        "gesturestart",
        preventBrowserGesture,
        captureOptions
      );
      document.removeEventListener(
        "gesturechange",
        preventBrowserGesture,
        captureOptions
      );
      document.removeEventListener(
        "gestureend",
        preventBrowserGesture,
        captureOptions
      );
      forceReleaseBrowserGestureLock();
    };
  }, []);

  useEffect(() => {
    if (!candles.length) {
      setZoomWindow({ startValue: 0, endValue: 0 });
      return;
    }

    if (pendingLatestResetRef.current === resetKey) {
      const nextWindow = latestZoomWindow(candles.length);
      pendingLatestResetRef.current = null;
      pendingRestoreRef.current = null;
      pendingRequestIdRef.current += 1;
      appliedResetKeyRef.current = resetKey;
      latestAnchorRef.current = true;
      ignoringDataZoomUntilRef.current = Date.now() + RESET_DATA_ZOOM_GUARD_MS;
      setZoomWindow(nextWindow);
      window.requestAnimationFrame(() => dispatchZoom(nextWindow));
      return;
    }

    const pendingRestore = pendingRestoreRef.current;
    if (pendingRestore && !historyLoading) {
      pendingRestoreRef.current = null;
      pendingRequestIdRef.current += 1;
      applyZoomWindow(restoreWindowFromTimestamps(pendingRestore), false);
      return;
    }

    if (appliedResetKeyRef.current !== resetKey) {
      appliedResetKeyRef.current = resetKey;
      const nextWindow = latestZoomWindow(candles.length);
      latestAnchorRef.current = true;
      setZoomWindow(nextWindow);
      window.requestAnimationFrame(() => dispatchZoom(nextWindow));
      return;
    }

    if (latestAnchorRef.current) {
      const nextWindow = latestZoomWindow(candles.length);
      if (!sameZoomWindow(zoomWindow, nextWindow)) {
        setZoomWindow(nextWindow);
        window.requestAnimationFrame(() => dispatchZoom(nextWindow));
      }
    } else if (isLatestZoomWindow(zoomWindow, candles.length)) {
      latestAnchorRef.current = true;
    }
  }, [
    candles,
    historyLoading,
    resetKey,
    zoomWindow.endValue,
    zoomWindow.startValue,
  ]);

  useEffect(() => {
    if (!isLocalDebugRuntime()) return;
    const latestWindow = latestZoomWindow(candles.length);
    const latestRealIndex = candles.length > 0 ? candles.length - 1 : null;
    (window as any).__cryptoCandlestickDebug = {
      range,
      resetKey,
      candleCount: candles.length,
      zoomWindow,
      latestWindow,
      latestRealIndex,
      latestVisible: windowIncludesLatestRealCandle(zoomWindow, candles.length),
      latestAnchored: latestAnchorRef.current,
      rightPadCount: rightPadCount(
        visibleCountFromWindow(zoomWindow),
        candles.length
      ),
      historyLoading,
      resetGuardActive: isResetGuardActive(),
    };
  }, [
    candles.length,
    historyLoading,
    range,
    resetKey,
    zoomWindow.endValue,
    zoomWindow.startValue,
  ]);

  const option = useMemo<EChartsOption>(
    () => ({
      animation: false,
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        show: showCrosshair,
        axisPointer: {
          type: "cross",
          crossStyle: { color: rgba(accentColor, 0.5) },
          label: {
            backgroundColor: "#111111",
            color: "#F8FAFC",
          },
        },
        borderWidth: 1,
        borderColor: rgba(accentColor, 0.28),
        backgroundColor: "rgba(8,8,8,.94)",
        textStyle: { color: "#F8FAFC", fontSize: 12 },
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params : [params];
          const first = list[0] as {
            dataIndex?: number;
            axisValue?: number | string;
          };
          const index =
            typeof first?.dataIndex === "number" ? first.dataIndex : -1;
          const axisIndex =
            index >= 0
              ? index
              : (indexFromCategoryValue(first?.axisValue, chartRows.length) ??
                -1);
          const candle = axisIndex >= 0 ? chartRows[axisIndex] : null;
          if (!candle) return "";
          const time = escapeHtml(formatTooltipTime(candle.ts, range));

          const up = Number(candle.close) >= Number(candle.open);
          const candleColor = up ? "#22C55E" : "#EF4444";
          return `<div style="min-width:204px;padding:2px 1px;">
            <div style="margin-bottom:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:800;color:#F8FAFC;">时间 ${time}</div>
            <div style="margin-bottom:6px;color:rgba(248,250,252,.9);font-weight:800;">
              <span style="width:8px;height:8px;border-radius:999px;background:${candleColor};display:inline-block;margin-right:7px;"></span>${escapeHtml(symbol)}
            </div>
            ${tooltipRow("开盘价", formatTooltipNumber(candle.open), candleColor)}
            ${tooltipRow("最高价", formatTooltipNumber(candle.high), candleColor)}
            ${tooltipRow("最低价", formatTooltipNumber(candle.low), candleColor)}
            ${tooltipRow("收盘价", formatTooltipNumber(candle.close), candleColor)}
            <div style="height:8px;"></div>
            ${tooltipRow("成交量", formatTooltipNumber(candle.volume), candleColor)}
          </div>`;
        },
      },
      axisPointer: {
        link: [{ xAxisIndex: [0, 1] }],
      },
      grid: [
        {
          left: 10,
          right: 78,
          top: 14,
          height: showVolume ? "60%" : "76%",
        },
        {
          left: 10,
          right: 78,
          bottom: 52,
          height: showVolume ? "18%" : 0,
        },
      ],
      xAxis: [
        {
          type: "category",
          data: categories,
          boundaryGap: false,
          axisLine: { lineStyle: { color: "rgba(255,255,255,.10)" } },
          axisTick: { show: false },
          axisLabel: {
            show: !showVolume,
            color: "rgba(248,250,252,.46)",
            fontSize: 10,
            hideOverlap: true,
            interval: labelInterval,
            formatter: (value: string) => {
              const index = indexFromCategoryValue(value, chartRows.length);
              return index === null
                ? ""
                : formatAxisTime(chartRows[index].ts, range);
            },
          },
          axisPointer: {
            label: {
              formatter: (params: { value?: unknown }) => {
                const index = indexFromCategoryValue(
                  params.value as number | string | undefined,
                  chartRows.length
                );
                return index === null
                  ? ""
                  : formatAxisTime(chartRows[index].ts, range);
              },
            },
          },
          splitLine: {
            show: showGrid,
            lineStyle: { color: GRID_LINE_COLOR },
          },
          min: 0,
          max: Math.max(0, totalCategoryCount - 1),
        },
        {
          type: "category",
          gridIndex: 1,
          data: categories,
          boundaryGap: false,
          axisLine: { lineStyle: { color: "rgba(255,255,255,.10)" } },
          axisTick: { show: false },
          axisLabel: {
            show: showVolume,
            color: "rgba(248,250,252,.46)",
            fontSize: 10,
            hideOverlap: true,
            interval: labelInterval,
            formatter: (value: string) => {
              const index = indexFromCategoryValue(value, chartRows.length);
              return index === null
                ? ""
                : formatAxisTime(chartRows[index].ts, range);
            },
          },
          axisPointer: {
            label: {
              formatter: (params: { value?: unknown }) => {
                const index = indexFromCategoryValue(
                  params.value as number | string | undefined,
                  chartRows.length
                );
                return index === null
                  ? ""
                  : formatAxisTime(chartRows[index].ts, range);
              },
            },
          },
          splitLine: { show: false },
          min: 0,
          max: Math.max(0, totalCategoryCount - 1),
        },
      ],
      yAxis: [
        {
          scale: true,
          position: "right",
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: "rgba(248,250,252,.52)",
            fontSize: 10,
            formatter: (value: number) =>
              new Intl.NumberFormat("en-US", {
                maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 4,
              }).format(value),
          },
          splitLine: {
            show: showGrid,
            lineStyle: { color: GRID_LINE_COLOR },
          },
        },
        {
          scale: true,
          gridIndex: 1,
          position: "right",
          name: showVolume ? "成交量" : "",
          nameGap: 8,
          nameTextStyle: {
            color: "rgba(248,250,252,.48)",
            fontSize: 10,
            fontWeight: 700,
          },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            show: showVolume,
            color: "rgba(248,250,252,.46)",
            fontSize: 10,
            formatter: (value: number) => formatVolumeAxis(value),
          },
          splitLine: {
            show: showVolume && showGrid,
            lineStyle: { color: GRID_LINE_COLOR },
          },
        },
      ],
      dataZoom: [
        {
          type: "inside",
          xAxisIndex: [0, 1],
          startValue: categoryValueForIndex(zoomWindow.startValue),
          endValue: categoryValueForIndex(zoomWindow.endValue),
          minValueSpan,
          maxValueSpan,
          filterMode: "filter",
          zoomOnMouseWheel: false,
          moveOnMouseWheel: false,
          moveOnMouseMove: true,
          preventDefaultMouseMove: true,
          throttle: 40,
        },
        {
          type: "slider",
          xAxisIndex: [0, 1],
          startValue: categoryValueForIndex(zoomWindow.startValue),
          endValue: categoryValueForIndex(zoomWindow.endValue),
          minValueSpan,
          maxValueSpan,
          filterMode: "filter",
          bottom: 10,
          height: 20,
          showDetail: false,
          brushSelect: false,
          borderColor: "rgba(255,255,255,.08)",
          backgroundColor: "rgba(255,255,255,.035)",
          fillerColor: rgba(accentColor, 0.14),
          handleSize: "70%",
          handleStyle: {
            color: accentColor,
            borderColor: rgba(accentColor, 0.65),
            opacity: 0.85,
          },
          moveHandleStyle: {
            color: rgba(accentColor, 0.32),
          },
          dataBackground: {
            lineStyle: { color: "rgba(255,255,255,.14)" },
            areaStyle: { color: "rgba(255,255,255,.045)" },
          },
          selectedDataBackground: {
            lineStyle: { color: rgba(accentColor, 0.5) },
            areaStyle: { color: rgba(accentColor, 0.13) },
          },
          textStyle: { color: "rgba(248,250,252,.45)" },
        },
      ],
      graphic: showVolume
        ? [
            {
              type: "text",
              left: 16,
              bottom: 116,
              style: {
                text: "成交量",
                fill: "rgba(248,250,252,.58)",
                font: "600 11px Inter, system-ui, sans-serif",
              },
            },
          ]
        : [],
      series: [
        {
          type: "candlestick",
          name: symbol,
          data: candleData,
          itemStyle: {
            color: "#22C55E",
            color0: "#EF4444",
            borderColor: "#22C55E",
            borderColor0: "#EF4444",
          },
          markLine:
            showCurrentPriceLine && price
              ? {
                  silent: true,
                  symbol: ["none", "none"],
                  label: {
                    show: true,
                    position: "end",
                    color: "#111111",
                    backgroundColor: accentColor,
                    borderRadius: 6,
                    padding: [3, 7],
                    formatter: () => formatMoney(price, quoteAsset),
                  },
                  lineStyle: {
                    color: accentColor,
                    type: "dashed",
                    width: 1,
                    opacity: 0.9,
                  },
                  data: [{ yAxis: Number(price) }],
                }
              : undefined,
        },
        ...(visibleExtrema
          ? [
              {
                type: "line" as const,
                name: "最高价辅助线",
                xAxisIndex: 0,
                yAxisIndex: 0,
                silent: true,
                showSymbol: false,
                connectNulls: true,
                data: categories.map((_, index) =>
                  index === visibleExtrema.high.index ||
                  index === visibleExtrema.high.labelIndex
                    ? visibleExtrema.high.value
                    : null
                ),
                lineStyle: {
                  color: "rgba(255,255,255,.92)",
                  width: 1,
                  type: "solid" as const,
                },
              },
              {
                type: "line" as const,
                name: "最低价辅助线",
                xAxisIndex: 0,
                yAxisIndex: 0,
                silent: true,
                showSymbol: false,
                connectNulls: true,
                data: categories.map((_, index) =>
                  index === visibleExtrema.low.index ||
                  index === visibleExtrema.low.labelIndex
                    ? visibleExtrema.low.value
                    : null
                ),
                lineStyle: {
                  color: "rgba(255,255,255,.92)",
                  width: 1,
                  type: "solid" as const,
                },
              },
              {
                type: "scatter" as const,
                name: "最高价标注",
                xAxisIndex: 0,
                yAxisIndex: 0,
                silent: true,
                symbolSize: 0,
                data: [
                  {
                    value: [
                      categoryValueForIndex(visibleExtrema.high.labelIndex),
                      visibleExtrema.high.value,
                    ],
                  },
                ],
                label: {
                  show: true,
                  position:
                    visibleExtrema.high.labelIndex >= visibleExtrema.high.index
                      ? ("right" as const)
                      : ("left" as const),
                  color: "#FFFFFF",
                  fontSize: 10,
                  fontWeight: 800,
                  textBorderColor: "rgba(0,0,0,.72)",
                  textBorderWidth: 3,
                  formatter: () => visibleExtrema.high.label,
                },
              },
              {
                type: "scatter" as const,
                name: "最低价标注",
                xAxisIndex: 0,
                yAxisIndex: 0,
                silent: true,
                symbolSize: 0,
                data: [
                  {
                    value: [
                      categoryValueForIndex(visibleExtrema.low.labelIndex),
                      visibleExtrema.low.value,
                    ],
                  },
                ],
                label: {
                  show: true,
                  position:
                    visibleExtrema.low.labelIndex >= visibleExtrema.low.index
                      ? ("right" as const)
                      : ("left" as const),
                  color: "#FFFFFF",
                  fontSize: 10,
                  fontWeight: 800,
                  textBorderColor: "rgba(0,0,0,.72)",
                  textBorderWidth: 3,
                  formatter: () => visibleExtrema.low.label,
                },
              },
            ]
          : []),
        ...(indicatorPreferences.showMA
          ? [
              {
                type: "line" as const,
                name: "MA5",
                xAxisIndex: 0,
                yAxisIndex: 0,
                data: paddedMa5Data,
                symbol: "none",
                smooth: false,
                connectNulls: false,
                lineStyle: { color: "#F7C948", width: 1.2, opacity: 0.95 },
              },
              {
                type: "line" as const,
                name: "MA10",
                xAxisIndex: 0,
                yAxisIndex: 0,
                data: paddedMa10Data,
                symbol: "none",
                smooth: false,
                connectNulls: false,
                lineStyle: { color: "#60A5FA", width: 1.1, opacity: 0.9 },
              },
              {
                type: "line" as const,
                name: "MA30",
                xAxisIndex: 0,
                yAxisIndex: 0,
                data: paddedMa30Data,
                symbol: "none",
                smooth: false,
                connectNulls: false,
                lineStyle: { color: "#C084FC", width: 1.1, opacity: 0.86 },
              },
            ]
          : []),
        ...(indicatorPreferences.showBoll
          ? [
              {
                type: "line" as const,
                name: "BOLL上轨",
                xAxisIndex: 0,
                yAxisIndex: 0,
                data: paddedBollData.upper,
                symbol: "none",
                smooth: false,
                connectNulls: false,
                lineStyle: { color: rgba(accentColor, 0.62), width: 1 },
              },
              {
                type: "line" as const,
                name: "BOLL中轨",
                xAxisIndex: 0,
                yAxisIndex: 0,
                data: paddedBollData.middle,
                symbol: "none",
                smooth: false,
                connectNulls: false,
                lineStyle: { color: "rgba(248,250,252,.34)", width: 1 },
              },
              {
                type: "line" as const,
                name: "BOLL下轨",
                xAxisIndex: 0,
                yAxisIndex: 0,
                data: paddedBollData.lower,
                symbol: "none",
                smooth: false,
                connectNulls: false,
                lineStyle: { color: rgba(accentColor, 0.62), width: 1 },
              },
            ]
          : []),
        {
          type: "bar",
          name: "成交量",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: showVolume ? volumeData : [],
          barWidth: "62%",
          itemStyle: { borderRadius: [2, 2, 0, 0] },
        },
      ],
    }),
    [
      accentColor,
      candleData,
      candles,
      chartRows,
      categories,
      indicatorPreferences.showBoll,
      indicatorPreferences.showMA,
      labelInterval,
      maxValueSpan,
      minValueSpan,
      paddedBollData.lower,
      paddedBollData.middle,
      paddedBollData.upper,
      paddedMa10Data,
      paddedMa30Data,
      paddedMa5Data,
      price,
      quoteAsset,
      range,
      showCrosshair,
      showCurrentPriceLine,
      showGrid,
      showVolume,
      symbol,
      totalCategoryCount,
      visibleExtrema,
      volumeData,
      zoomWindow.endValue,
      zoomWindow.startValue,
    ]
  );
  const latestDebugWindow = latestZoomWindow(candles.length);
  const latestDebugRealIndex = candles.length > 0 ? candles.length - 1 : null;
  const chartDebugAttributes = isLocalDebugRuntime()
    ? {
        "data-crypto-range": range,
        "data-crypto-candle-count": String(candles.length),
        "data-crypto-zoom-start": String(zoomWindow.startValue),
        "data-crypto-zoom-end": String(zoomWindow.endValue),
        "data-crypto-latest-start": String(latestDebugWindow.startValue),
        "data-crypto-latest-end": String(latestDebugWindow.endValue),
        "data-crypto-latest-real-index": String(latestDebugRealIndex ?? ""),
        "data-crypto-latest-visible": String(
          windowIncludesLatestRealCandle(zoomWindow, candles.length)
        ),
        "data-crypto-right-pad-count": String(
          rightPadCount(visibleCountFromWindow(zoomWindow), candles.length)
        ),
        "data-crypto-history-loading": String(historyLoading),
      }
    : {};

  return (
    <div
      className="relative overflow-hidden border bg-[#070707] text-white shadow-[0_24px_80px_rgb(0_0_0_/_0.34)]"
      style={{
        height: cardHeight,
        borderRadius,
        borderColor: rgba(accentColor, 0.18),
        boxShadow: `0 24px ${Math.round(70 * glowIntensity)}px ${rgba(
          accentColor,
          0.13 * glowIntensity
        )}, inset 0 1px 0 rgba(255,255,255,.08)`,
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,.045), transparent 30%), radial-gradient(circle at 18% 0%, rgba(214,168,79,.14), transparent 35%)",
        }}
      />

      <div className="relative flex h-full min-h-0 flex-col gap-3 p-4 md:p-5">
        <div className="flex shrink-0 items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <div
              className="shrink-0 overflow-hidden rounded-full border bg-black/35 font-black"
              style={{
                width: `${coinSize}px`,
                height: `${coinSize}px`,
                borderColor: rgba(accentColor, 0.45),
                color: accentColor,
                boxShadow: `0 0 ${compactMode ? 24 : 38}px ${rgba(
                  accentColor,
                  0.22
                )}, inset 0 1px 0 rgba(255,255,255,.12)`,
              }}
            >
              {iconImage ? (
                <img
                  src={iconImage}
                  alt={baseAsset}
                  className="h-full w-full object-cover"
                  style={{
                    transform: `translate(${iconCropX}px, ${iconCropY}px) scale(${coinScale})`,
                    transformOrigin: "center",
                  }}
                />
              ) : (
                iconText || baseAsset.slice(0, 3)
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-3">
                <h2
                  className={[
                    "min-w-0 truncate font-black leading-tight tracking-normal text-[#F8FAFC]",
                    compactMode ? "text-3xl" : "text-4xl xl:text-5xl",
                  ].join(" ")}
                >
                  {symbol}
                </h2>
                <div
                  className={[
                    "shrink-0 rounded-full border font-bold",
                    compactMode ? "px-3 py-1 text-sm" : "px-5 py-2 text-xl",
                  ].join(" ")}
                  style={{
                    borderColor: rgba(accentColor, 0.34),
                    color: accentColor,
                    backgroundColor: rgba(accentColor, 0.1),
                  }}
                >
                  {marketLabels[market]}
                </div>
              </div>
              <div
                className={[
                  "mt-2 truncate font-semibold text-[#A1A1AA]",
                  compactMode ? "text-base" : "text-2xl",
                ].join(" ")}
              >
                {assetDisplayName}
              </div>
            </div>
          </div>

          <div className="shrink-0 text-right">
            <div className="flex items-start justify-end gap-3">
              <div>
                <div
                  className="font-mono text-3xl font-black leading-none md:text-4xl"
                  style={{ color: accentColor }}
                >
                  {formatMoney(price, quoteAsset)}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs font-bold text-white/55">
                  <span>
                    {formatMoney(currentPriceUsd || price, "USDT")} USDT
                  </span>
                  <span
                    className={
                      change !== null && change < 0
                        ? "text-red-400"
                        : "text-emerald-400"
                    }
                  >
                    {formatPct(change24hPct)}
                  </span>
                </div>
              </div>
              <div
                className="flex w-fit shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm font-bold"
                style={{
                  color: statusDisplay.color,
                  backgroundColor: statusDisplay.bg,
                }}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full shadow-[0_0_16px_currentColor]"
                  style={{ backgroundColor: statusDisplay.color }}
                />
                {statusLabel}
              </div>
            </div>
            <div className="mt-1 text-xs font-bold text-white/50">
              {autoRefreshSeconds}秒自动刷新 · {dataModeLabel(mode)}
            </div>
          </div>
        </div>

        <div className="relative flex w-fit shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setRangeMenuOpen((current) => !current)}
            className="flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-black text-black transition"
            style={{
              borderColor: accentColor,
              backgroundColor: accentColor,
              boxShadow: `0 12px 28px ${rgba(accentColor, 0.18)}`,
            }}
          >
            <span>{rangeLabels[range]}</span>
            <span className="text-[10px] leading-none">▼</span>
          </button>
          <button
            type="button"
            aria-pressed={indicatorPreferences.showMA}
            onClick={() => toggleIndicator("showMA")}
            className="rounded-full border px-4 py-2 text-xs font-black transition hover:border-white/25"
            style={indicatorButtonStyle(
              indicatorPreferences.showMA,
              accentColor
            )}
          >
            MA
          </button>
          <button
            type="button"
            aria-pressed={indicatorPreferences.showBoll}
            onClick={() => toggleIndicator("showBoll")}
            className="rounded-full border px-4 py-2 text-xs font-black transition hover:border-white/25"
            style={indicatorButtonStyle(
              indicatorPreferences.showBoll,
              accentColor
            )}
          >
            BOLL
          </button>

          {rangeMenuOpen ? (
            <div
              className="absolute left-0 top-[calc(100%+8px)] z-20 grid min-w-[128px] gap-1 rounded-[18px] border bg-black/90 p-1.5 shadow-[0_18px_44px_rgb(0_0_0_/_0.38)] backdrop-blur"
              style={{ borderColor: rgba(accentColor, 0.24) }}
            >
              {rangeOptions.map((option) => {
                const active = option === range;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      onRangeChange?.(option);
                      setRangeMenuOpen(false);
                    }}
                    className={[
                      "rounded-full border px-3 py-2 text-left text-xs font-black transition",
                      active
                        ? "text-black"
                        : "border-transparent text-white hover:border-white/20 hover:bg-white/[.07]",
                    ].join(" ")}
                    style={
                      active
                        ? {
                            borderColor: accentColor,
                            backgroundColor: accentColor,
                          }
                        : {
                            color: "#F8FAFC",
                          }
                    }
                  >
                    {rangeLabels[option]}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div
          ref={chartContainerRef}
          {...chartDebugAttributes}
          className="relative -mx-2 min-h-0 flex-1 cursor-grab active:cursor-grabbing"
          onWheelCapture={handleChartWheel}
          onPointerDownCapture={markUserDataZoomInteraction}
          onPointerMoveCapture={(event) => {
            if (event.buttons) markUserDataZoomInteraction();
          }}
          onMouseDownCapture={markUserDataZoomInteraction}
          onTouchStartCapture={markUserDataZoomInteraction}
          onTouchMoveCapture={markUserDataZoomInteraction}
          onPointerEnter={() => activateBrowserGestureLock()}
          onFocusCapture={() => activateBrowserGestureLock()}
          onPointerLeave={() => activateBrowserGestureLock()}
          onBlurCapture={() => activateBrowserGestureLock()}
          style={{
            overscrollBehavior: "contain",
            overscrollBehaviorX: "contain",
            touchAction: "none",
          }}
        >
          {chartBackgroundImageUrl ? (
            <div
              className="pointer-events-none absolute inset-0 z-0"
              style={{
                backgroundImage: `linear-gradient(180deg, rgba(7,7,7,.18), rgba(7,7,7,.54)), url("${chartBackgroundImageUrl}")`,
                backgroundPosition: "center",
                backgroundSize: "cover",
                opacity: 0.34,
              }}
            />
          ) : null}

          {indicatorPreferences.showMA ? (
            <div className="pointer-events-none absolute left-5 top-2 z-10 flex flex-wrap items-center gap-3 rounded-full bg-black/35 px-2.5 py-1 text-[10px] font-black leading-none backdrop-blur-sm">
              <span style={{ color: "#F7C948" }}>
                MA5 {formatIndicatorValue(currentMAValues.ma5)}
              </span>
              <span style={{ color: "#60A5FA" }}>
                MA10 {formatIndicatorValue(currentMAValues.ma10)}
              </span>
              <span style={{ color: "#C084FC" }}>
                MA30 {formatIndicatorValue(currentMAValues.ma30)}
              </span>
            </div>
          ) : null}

          <ReactECharts
            key={resetKey}
            ref={chartRef}
            option={option}
            notMerge={false}
            replaceMerge={["xAxis", "series", "dataZoom"]}
            lazyUpdate={false}
            className="relative z-[1] h-full"
            style={{ height: "100%", width: "100%" }}
            onEvents={{
              datazoom: handleDataZoom,
            }}
          />

          {loading && !candles.length ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/35 text-xs font-bold text-white/50">
              正在加载K线...
            </div>
          ) : null}
          {historyLoading ? (
            <div
              className="absolute left-3 top-3 rounded-full border px-3 py-1 text-[11px] font-black"
              style={{
                borderColor: rgba(accentColor, 0.28),
                backgroundColor: "rgba(0,0,0,.68)",
                color: accentColor,
              }}
            >
              加载更早历史...
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="shrink-0 rounded-full border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
