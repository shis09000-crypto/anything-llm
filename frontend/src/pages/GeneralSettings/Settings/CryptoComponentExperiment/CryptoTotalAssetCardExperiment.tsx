import React, { useEffect, useMemo, useRef, useState } from "react";
import { cryptoHubFetch } from "@/hooks/cryptoHub/useCryptoHubQuery";
import { useCryptoHubWatchedConnection } from "@/hooks/cryptoHub/useCryptoHubWatchdog";
import CryptoTotalAssetCard from "./CryptoTotalAssetCard";
import type {
  CryptoBackgroundMode,
  CryptoChartTone,
  CryptoConnectionStatus,
  CryptoLossChartTone,
  CryptoTotalAssetCardProps,
  CryptoTrendPoint,
  CryptoTrendScenario,
} from "./cryptoTotalAssetTypes";

const defaultParams: CryptoTotalAssetCardProps = {
  totalEquityUsd: 128430.52,
  todayPnlUsd: 3420.18,
  todayPnlPct: 2.74,
  yesterdayChangePct: 1.32,
  yesterdayBaselineUsd: 80000,
  connectionStatus: "connected",
  lastUpdatedAt: "09:42:18",
  lastUpdatedDate: "2026-06-05",
  cardHeight: 318,
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
  numberSize: 48,
  compactMode: false,
};

const connectionStatusLabels: Record<CryptoConnectionStatus, string> = {
  connected: "已连接 / Live",
  degraded: "不稳定 / Degraded",
  disconnected: "已断开 / Offline",
};

const backgroundModeLabels: Record<CryptoBackgroundMode, string> = {
  none: "纯深色",
  gradient: "金融渐变",
  image: "图片背景",
};

const chartToneLabels: Record<CryptoChartTone, string> = {
  green: "盈利绿",
  gold: "金融金",
  cyan: "数据青",
};

const lossChartToneLabels: Record<CryptoLossChartTone, string> = {
  red: "亏损红",
  gold: "风险金",
  cyan: "数据青",
};

const trendScenarioLabels: Record<CryptoTrendScenario, string> = {
  profit: "盈利走势",
  loss: "亏损走势",
  mixed: "盈亏混合",
};

type GateEquityMode = "api_total" | "net_equity" | "account_sum";

const gateEquityModeLabels: Record<GateEquityMode, string> = {
  api_total: "Gate API 总额",
  net_equity: "净权益（含未实现盈亏）",
  account_sum: "账户分项加总",
};

type GateEquityBreakdown = {
  apiTotalUsd: number;
  unrealizedPnlUsd: number;
  netEquityUsd: number;
  accountSumUsd: number;
  selectedEquityUsd: number;
  equityMode: GateEquityMode;
  accountAmounts: Record<string, number>;
};

type GateEquityHistory = {
  historyVersion: number;
  latestPointTs: number | null;
  incremental?: boolean;
  sinceTs?: number | null;
  latestEquityUsd: number;
  todayPnlUsd: number;
  todayPnlPct: number;
  yesterdayBaselineUsd: number;
  yesterdayChangePct: number;
  lastUpdatedAt: string | null;
  lastUpdatedDate?: string | null;
  filteredNeedles?: number;
  freshness?: {
    latestSnapshotAt: number | null;
    ageMs: number | null;
    lastRefreshSource: string | null;
    dirty: boolean;
    dirtySince: number | null;
    dirtyReason?: string | null;
    nextAllowedRestAt: number | null;
    rateLimitRemainPct: number | null;
    refreshIntervalMs: number;
    rateLimitMode: "normal" | "slow";
    lastError?: string | null;
  };
  equityBreakdown: GateEquityBreakdown | null;
  points: CryptoTrendPoint[];
};

type GateEquityHistoryResponse = {
  success?: boolean;
  error?: string;
  safeErrorMessage?: string;
  history?: GateEquityHistory;
};

function finiteNumber(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function formatUsd(value?: number | null) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
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

function normalizeParams(
  params: Partial<CryptoTotalAssetCardProps>
): CryptoTotalAssetCardProps {
  const isLegacyState =
    !Number.isFinite(params.yesterdayBaselineUsd) ||
    params.trendScenario === undefined;

  return {
    ...defaultParams,
    ...params,
    totalEquityUsd: finiteNumber(
      params.totalEquityUsd,
      defaultParams.totalEquityUsd
    ),
    todayPnlUsd: finiteNumber(params.todayPnlUsd, defaultParams.todayPnlUsd),
    todayPnlPct: finiteNumber(params.todayPnlPct, defaultParams.todayPnlPct),
    yesterdayChangePct: finiteNumber(
      params.yesterdayChangePct,
      defaultParams.yesterdayChangePct
    ),
    yesterdayBaselineUsd: finiteNumber(
      params.yesterdayBaselineUsd,
      defaultParams.yesterdayBaselineUsd
    ),
    cardHeight: isLegacyState
      ? defaultParams.cardHeight
      : finiteNumber(params.cardHeight, defaultParams.cardHeight),
    borderRadius: finiteNumber(params.borderRadius, defaultParams.borderRadius),
    glowIntensity: finiteNumber(
      params.glowIntensity,
      defaultParams.glowIntensity
    ),
    numberSize: finiteNumber(params.numberSize, defaultParams.numberSize),
    profitChartTone: params.profitChartTone || defaultParams.profitChartTone,
    lossChartTone: params.lossChartTone || defaultParams.lossChartTone,
    trendScenario: params.trendScenario || defaultParams.trendScenario,
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

export default function CryptoTotalAssetCardExperiment() {
  const [params, setParams] =
    useState<Partial<CryptoTotalAssetCardProps>>(defaultParams);
  const [useRealGateData, setUseRealGateData] = useState(true);
  const [gateHistory, setGateHistory] = useState<GateEquityHistory | null>(
    null
  );
  const [gateHistoryStatus, setGateHistoryStatus] = useState<
    "idle" | "loading" | "connected" | "error"
  >("idle");
  const [gateHistoryError, setGateHistoryError] = useState<string | null>(null);
  const [equityMode, setEquityMode] = useState<GateEquityMode>("api_total");
  const [watchdogRefreshNonce, setWatchdogRefreshNonce] = useState(0);
  const [currentDateTime, setCurrentDateTime] = useState(
    currentShanghaiDateTime
  );
  const gateHistoryRef = useRef<GateEquityHistory | null>(null);
  const activeParams = useMemo(() => normalizeParams(params), [params]);
  const previewParams = useMemo<CryptoTotalAssetCardProps>(() => {
    const timeStampedParams = {
      ...activeParams,
      lastUpdatedAt: currentDateTime.time,
      lastUpdatedDate: currentDateTime.date,
    };

    if (!useRealGateData || !gateHistory) return timeStampedParams;

    return {
      ...timeStampedParams,
      totalEquityUsd: gateHistory.latestEquityUsd,
      todayPnlUsd: gateHistory.todayPnlUsd,
      todayPnlPct: gateHistory.todayPnlPct,
      yesterdayBaselineUsd: gateHistory.yesterdayBaselineUsd,
      yesterdayChangePct: gateHistory.yesterdayChangePct,
      lastUpdatedAt: currentDateTime.time,
      lastUpdatedDate: currentDateTime.date,
      trendPoints: gateHistory.points,
    };
  }, [activeParams, currentDateTime, gateHistory, useRealGateData]);

  useEffect(() => {
    gateHistoryRef.current = gateHistory;
  }, [gateHistory]);

  useCryptoHubWatchedConnection({
    key: `equityHistory.rest.${equityMode}`,
    active: useRealGateData,
    status: gateHistoryStatus === "error" ? "error" : "connected",
    lastConnectedAt: gateHistory?.freshness?.latestSnapshotAt || null,
    reconnect: () => setWatchdogRefreshNonce((current) => current + 1),
  });

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentDateTime(currentShanghaiDateTime());
    }, 1_000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!useRealGateData) {
      setGateHistoryStatus("idle");
      setGateHistoryError(null);
      return;
    }

    async function startGateStream() {
      try {
        await cryptoHubFetch("/init", { method: "POST" });
      } catch {
        // The cached history request below owns the user-facing degraded state.
      }
    }

    startGateStream();

    return () => {
      // Crypto Hub owns the shared Gate WS lifecycle. Component unmount should
      // not stop private WS globally while other crypto surfaces may need it.
    };
  }, [useRealGateData]);

  useEffect(() => {
    if (!useRealGateData) {
      setGateHistoryStatus("idle");
      setGateHistoryError(null);
      return;
    }

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
        const payload = await cryptoHubFetch<GateEquityHistoryResponse>(
          `/equity-history?${query.toString()}`
        );
        if (!payload?.success || !payload?.history) {
          throw new Error(
            payload?.safeErrorMessage ||
              payload?.error ||
              "Gate 今日历史数据读取失败"
          );
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
        setGateHistoryError(null);
      } catch (error) {
        if (cancelled) return;
        setGateHistoryStatus("error");
        setGateHistoryError(
          error instanceof Error ? error.message : "Gate 今日历史数据读取失败"
        );
      }
    }

    loadHistory();
    timer = window.setInterval(loadHistory, 500);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [equityMode, useRealGateData, watchdogRefreshNonce]);

  const gateStatusText = useMemo(() => {
    if (!useRealGateData) return "未启用，使用 mock 参数";
    if (gateHistoryStatus === "error")
      return gateHistoryError || "刷新失败 / Degraded";
    if (gateHistoryStatus !== "connected") return "正在读取今日历史...";

    const freshness = gateHistory?.freshness;
    if (freshness?.rateLimitMode === "slow") return "RateLimit 低，30s 降频";
    if (freshness?.dirty) return "WS 合并刷新中";
    if (freshness?.refreshIntervalMs === 2_000) return "2s 真实刷新中";
    return "0.5s 缓存读取中";
  }, [gateHistory, gateHistoryError, gateHistoryStatus, useRealGateData]);

  function updateParam<K extends keyof CryptoTotalAssetCardProps>(
    key: K,
    value: CryptoTotalAssetCardProps[K]
  ) {
    setParams((current) => ({ ...normalizeParams(current), [key]: value }));
  }

  const cssPreview = useMemo(
    () => [
      `dataMode: ${useRealGateData ? "gate" : "mock"}`,
      `equityMode: ${equityMode}`,
      `cardHeight: ${previewParams.cardHeight}px`,
      `borderRadius: ${previewParams.borderRadius}px`,
      `backgroundMode: ${previewParams.backgroundMode}`,
      `showTrendChart: ${previewParams.showTrendChart}`,
      `yesterdayBaselineUsd: ${previewParams.yesterdayBaselineUsd}`,
      `trendScenario: ${previewParams.trendScenario}`,
      `trendPoints: ${previewParams.trendPoints?.length || "mock"}`,
      `glowIntensity: ${previewParams.glowIntensity.toFixed(2)}`,
      `profitChartTone: ${previewParams.profitChartTone}`,
      `lossChartTone: ${previewParams.lossChartTone}`,
      `numberSize: ${previewParams.numberSize}px`,
      `compactMode: ${previewParams.compactMode}`,
    ],
    [equityMode, previewParams, useRealGateData]
  );

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-[28px] bg-transparent p-0 text-slate-100">
        <div className="rounded-[28px] bg-transparent p-0">
          <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-900 light:text-slate-900 dark:text-white">
                CryptoTotalAssetCardExperiment
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                仅实验预览 · 可切换 Gate 今日真实历史数据
              </p>
            </div>
            <div className="w-fit rounded-full bg-[#D6A84F]/10 px-3 py-1 text-xs font-bold text-[#D6A84F] shadow-[0_10px_28px_rgb(214_168_79_/_0.10)]">
              预览
            </div>
          </div>
          <CryptoTotalAssetCard {...previewParams} />
        </div>
      </section>

      <section className="rounded-2xl border border-white/15 bg-white/10 p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.18)] backdrop-blur-2xl light:border-white/70 light:bg-white/65 light:shadow-[0_18px_54px_rgb(15_23_42_/_0.10)]">
        <div className="rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
          <div className="text-sm font-semibold text-white light:text-slate-900">
            调控面板
          </div>
          <p className="mt-2 text-xs leading-5 text-white/60 light:text-slate-500">
            组件固定在上方完整展示；下方参数每行最多三个，便于快速调试尺寸、
            状态、背景和趋势图表现。
          </p>
        </div>

        <ControlSection title="基础数据">
          <ToggleControl
            label="使用真实 Gate 今日数据"
            param="useRealGateData"
            checked={useRealGateData}
            onChange={setUseRealGateData}
          />
          <SelectControl<GateEquityMode>
            label="资产口径"
            param="equityMode"
            value={equityMode}
            options={["api_total", "net_equity", "account_sum"]}
            optionLabels={gateEquityModeLabels}
            onChange={setEquityMode}
          />
          <div className="grid gap-1 rounded-xl border border-white/10 bg-white/5 p-3 text-xs font-semibold text-white light:border-slate-200 light:bg-white/55 light:text-slate-700">
            <span className="flex items-center justify-between gap-3">
              <span>Gate 数据状态</span>
              <span className="font-mono text-[11px] text-slate-400">
                equity-history
              </span>
            </span>
            <span
              className={
                gateHistoryStatus === "connected"
                  ? "text-emerald-400"
                  : gateHistoryStatus === "error"
                    ? "text-red-400"
                    : "text-[#D6A84F]"
              }
            >
              {gateStatusText}
            </span>
            {useRealGateData && gateHistoryStatus === "connected" ? (
              <span className="text-[11px] font-medium text-slate-400">
                0.5s 缓存读取 · {gateHistory?.points?.length || 0} 个点
                {gateHistory?.filteredNeedles
                  ? ` · 已过滤 ${gateHistory.filteredNeedles} 个异常针点`
                  : ""}
              </span>
            ) : null}
          </div>
          <EquityBreakdownCard
            breakdown={gateHistory?.equityBreakdown || null}
            equityMode={equityMode}
          />
          <NumberControl
            label="总资产估值"
            param="totalEquityUsd"
            value={previewParams.totalEquityUsd}
            step={100}
            onChange={(value) => updateParam("totalEquityUsd", value)}
          />
          <NumberControl
            label="今日盈亏金额"
            param="todayPnlUsd"
            value={previewParams.todayPnlUsd}
            step={10}
            onChange={(value) => updateParam("todayPnlUsd", value)}
          />
          <NumberControl
            label="今日盈亏百分比"
            param="todayPnlPct"
            value={previewParams.todayPnlPct}
            step={0.01}
            onChange={(value) => updateParam("todayPnlPct", value)}
          />
          <NumberControl
            label="较基准变化"
            param="yesterdayChangePct"
            value={previewParams.yesterdayChangePct}
            step={0.01}
            onChange={(value) => updateParam("yesterdayChangePct", value)}
          />
          <NumberControl
            label="基准金额"
            param="yesterdayBaselineUsd"
            value={previewParams.yesterdayBaselineUsd}
            step={100}
            onChange={(value) => updateParam("yesterdayBaselineUsd", value)}
          />
          <SelectControl<CryptoConnectionStatus>
            label="连接状态"
            param="connectionStatus"
            value={activeParams.connectionStatus}
            options={["connected", "degraded", "disconnected"]}
            optionLabels={connectionStatusLabels}
            onChange={(value) => updateParam("connectionStatus", value)}
          />
          <TextControl
            label="最后更新时间"
            param="lastUpdatedAt"
            value={previewParams.lastUpdatedAt}
            onChange={(value) => updateParam("lastUpdatedAt", value)}
          />
        </ControlSection>

        <ControlSection title="视觉参数">
          <RangeNumberControl
            label="卡片高度"
            param="cardHeight"
            value={activeParams.cardHeight}
            min={150}
            max={320}
            suffix="px"
            onChange={(value) => updateParam("cardHeight", value)}
          />
          <RangeNumberControl
            label="卡片圆角"
            param="borderRadius"
            value={activeParams.borderRadius}
            min={8}
            max={42}
            suffix="px"
            onChange={(value) => updateParam("borderRadius", value)}
          />
          <SelectControl<CryptoBackgroundMode>
            label="背景模式"
            param="backgroundMode"
            value={activeParams.backgroundMode}
            options={["none", "gradient", "image"]}
            optionLabels={backgroundModeLabels}
            onChange={(value) => updateParam("backgroundMode", value)}
          />
          <TextControl
            label="背景图片地址"
            param="backgroundImage"
            value={activeParams.backgroundImage || ""}
            placeholder="https://..."
            onChange={(value) => updateParam("backgroundImage", value)}
          />
          <ToggleControl
            label="显示趋势图"
            param="showTrendChart"
            checked={activeParams.showTrendChart}
            onChange={(value) => updateParam("showTrendChart", value)}
          />
          <ToggleControl
            label="显示资产可见图标"
            param="showEyeIcon"
            checked={activeParams.showEyeIcon}
            onChange={(value) => updateParam("showEyeIcon", value)}
          />
          <ToggleControl
            label="显示状态徽标"
            param="showStatusBadge"
            checked={activeParams.showStatusBadge}
            onChange={(value) => updateParam("showStatusBadge", value)}
          />
          <RangeNumberControl
            label="发光强度"
            param="glowIntensity"
            value={activeParams.glowIntensity}
            min={0}
            max={1}
            step={0.01}
            onChange={(value) => updateParam("glowIntensity", value)}
          />
          <SelectControl<CryptoChartTone>
            label="盈利区域颜色"
            param="profitChartTone"
            value={activeParams.profitChartTone}
            options={["green", "gold", "cyan"]}
            optionLabels={chartToneLabels}
            onChange={(value) => updateParam("profitChartTone", value)}
          />
          <SelectControl<CryptoLossChartTone>
            label="亏损区域颜色"
            param="lossChartTone"
            value={activeParams.lossChartTone}
            options={["red", "gold", "cyan"]}
            optionLabels={lossChartToneLabels}
            onChange={(value) => updateParam("lossChartTone", value)}
          />
          <SelectControl<CryptoTrendScenario>
            label="趋势演示状态"
            param="trendScenario"
            value={activeParams.trendScenario}
            options={["mixed", "profit", "loss"]}
            optionLabels={trendScenarioLabels}
            onChange={(value) => updateParam("trendScenario", value)}
          />
          <RangeNumberControl
            label="总资产数字大小"
            param="numberSize"
            value={activeParams.numberSize}
            min={32}
            max={78}
            suffix="px"
            onChange={(value) => updateParam("numberSize", value)}
          />
          <ToggleControl
            label="紧凑模式"
            param="compactMode"
            checked={activeParams.compactMode}
            onChange={(value) => updateParam("compactMode", value)}
          />
        </ControlSection>

        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
          <button
            type="button"
            onClick={() => setParams(defaultParams)}
            className="h-11 w-full rounded-xl border border-white/15 bg-white/10 px-4 text-sm font-bold text-white shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08)] transition hover:bg-white/15 light:border-slate-200 light:bg-white light:text-slate-800 light:hover:bg-slate-50"
          >
            重置实验参数
          </button>

          <div className="rounded-2xl border border-white/15 bg-slate-950/70 p-4 light:border-slate-200 light:bg-slate-950">
            <div className="text-xs font-semibold text-sky-200">当前参数</div>
            <div className="mt-3 grid gap-1 rounded-xl bg-black/35 p-3 text-[11px] leading-5 text-sky-50">
              {cssPreview.map((item) => (
                <code key={item}>{item}</code>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function EquityBreakdownCard({
  breakdown,
  equityMode,
}: {
  breakdown: GateEquityBreakdown | null;
  equityMode: GateEquityMode;
}) {
  const accounts = breakdown?.accountAmounts || {};
  const visibleAccounts = [
    "spot",
    "finance",
    "futures",
    "delivery",
    "margin",
    "options",
    "payment",
    "quant",
    "meme_box",
  ];

  return (
    <div className="grid gap-3 rounded-xl border border-white/10 bg-slate-950/70 p-3 text-xs text-white light:border-slate-200 light:bg-white/55 light:text-slate-800 md:col-span-2 xl:col-span-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="font-semibold">资产口径调试</div>
          <div className="mt-1 text-[11px] text-white/45 light:text-slate-500">
            当前选择：{gateEquityModeLabels[equityMode]}；仅展示聚合金额。
          </div>
        </div>
        <div className="rounded-full bg-[#D6A84F]/10 px-3 py-1 font-mono text-[11px] font-bold text-[#D6A84F]">
          selected {formatUsd(breakdown?.selectedEquityUsd)}
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-4">
        <MetricChip label="Gate API 总额" value={breakdown?.apiTotalUsd} />
        <MetricChip label="净权益" value={breakdown?.netEquityUsd} />
        <MetricChip
          label="未实现盈亏"
          value={breakdown?.unrealizedPnlUsd}
          tone={
            (breakdown?.unrealizedPnlUsd || 0) < 0 ? "negative" : "positive"
          }
        />
        <MetricChip label="账户分项加总" value={breakdown?.accountSumUsd} />
      </div>

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {visibleAccounts.map((account) => (
          <div
            key={account}
            className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 light:border-slate-200 light:bg-white"
          >
            <div className="text-[10px] uppercase tracking-[0.14em] text-white/35 light:text-slate-400">
              {account}
            </div>
            <div className="mt-1 font-mono text-[12px] font-bold text-white light:text-slate-900">
              {formatUsd(accounts[account])}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricChip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value?: number | null;
  tone?: "neutral" | "positive" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-300 light:text-emerald-700"
      : tone === "negative"
        ? "text-red-300 light:text-red-700"
        : "text-white light:text-slate-900";

  return (
    <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 light:border-slate-200 light:bg-white">
      <div className="text-[10px] font-semibold text-white/45 light:text-slate-500">
        {label}
      </div>
      <div className={`mt-1 font-mono text-sm font-bold ${toneClass}`}>
        {formatUsd(value)}
      </div>
    </div>
  );
}

function ControlSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
      <div className="mb-3 text-xs font-semibold text-white light:text-slate-800">
        {title}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </div>
  );
}

function NumberControl({
  label,
  param,
  value,
  step = 1,
  onChange,
}: {
  label: string;
  param: string;
  value: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2 rounded-xl border border-white/10 bg-white/5 p-3 light:border-slate-200 light:bg-white/55">
      <span className="flex items-center justify-between gap-3 text-xs font-semibold text-white light:text-slate-700">
        <span>{label}</span>
        <span className="font-mono text-[10px] text-white/35 light:text-slate-400">
          {param}
        </span>
      </span>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(event) => onChange(Number(event.target.value || 0))}
        className="h-9 rounded-lg border border-white/10 bg-black/30 px-3 text-sm font-semibold text-white outline-none focus:border-sky-300 light:border-slate-200 light:bg-white light:text-slate-900"
      />
    </label>
  );
}

function TextControl({
  label,
  param,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  param: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-2 rounded-xl border border-white/10 bg-white/5 p-3 light:border-slate-200 light:bg-white/55">
      <span className="flex items-center justify-between gap-3 text-xs font-semibold text-white light:text-slate-700">
        <span>{label}</span>
        <span className="font-mono text-[10px] text-white/35 light:text-slate-400">
          {param}
        </span>
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-lg border border-white/10 bg-black/30 px-3 text-sm font-semibold text-white outline-none placeholder:text-white/30 focus:border-sky-300 light:border-slate-200 light:bg-white light:text-slate-900 light:placeholder:text-slate-400"
      />
    </label>
  );
}

function SelectControl<T extends string>({
  label,
  param,
  value,
  options,
  optionLabels,
  onChange,
}: {
  label: string;
  param: string;
  value: T;
  options: T[];
  optionLabels?: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="grid gap-2 rounded-xl border border-white/10 bg-white/5 p-3 light:border-slate-200 light:bg-white/55">
      <span className="flex items-center justify-between gap-3 text-xs font-semibold text-white light:text-slate-700">
        <span>{label}</span>
        <span className="font-mono text-[10px] text-white/35 light:text-slate-400">
          {param}
        </span>
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-9 rounded-lg border border-white/10 bg-black/30 px-3 text-sm font-semibold text-white outline-none focus:border-sky-300 light:border-slate-200 light:bg-white light:text-slate-900"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabels?.[option] || option}
          </option>
        ))}
      </select>
    </label>
  );
}

function RangeNumberControl({
  label,
  param,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  onChange,
}: {
  label: string;
  param: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2 rounded-xl border border-white/10 bg-white/5 p-3 light:border-slate-200 light:bg-white/55">
      <span className="flex items-center justify-between gap-3 text-xs font-semibold text-white light:text-slate-700">
        <span>
          {label}
          <span className="ml-2 font-mono text-[10px] text-white/35 light:text-slate-400">
            {param}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[11px] text-sky-200 light:text-sky-700">
          {value}
          {suffix}
        </span>
      </span>
      <div className="grid grid-cols-[1fr_78px] gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full accent-[#D6A84F]"
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value || 0))}
          className="h-8 rounded-lg border border-white/10 bg-black/30 px-2 text-xs font-semibold text-white outline-none focus:border-sky-300 light:border-slate-200 light:bg-white light:text-slate-900"
        />
      </div>
    </label>
  );
}

function ToggleControl({
  label,
  param,
  checked,
  onChange,
}: {
  label: string;
  param: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-3 text-left light:border-slate-200 light:bg-white/55"
    >
      <span className="min-w-0 text-xs font-semibold text-white light:text-slate-700">
        <span>{label}</span>
        <span className="ml-2 font-mono text-[10px] text-white/35 light:text-slate-400">
          {param}
        </span>
      </span>
      <span
        className={[
          "relative h-6 w-11 rounded-full border transition",
          checked
            ? "border-[#D6A84F]/50 bg-[#D6A84F]/40"
            : "border-white/15 bg-black/30 light:border-slate-300 light:bg-slate-100",
        ].join(" ")}
      >
        <span
          className={[
            "absolute top-1 h-4 w-4 rounded-full bg-white transition",
            checked ? "left-6" : "left-1",
          ].join(" ")}
        />
      </span>
    </button>
  );
}
