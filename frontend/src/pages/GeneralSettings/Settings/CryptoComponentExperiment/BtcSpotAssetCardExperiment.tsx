import React, { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import BtcSpotAssetCard from "./BtcSpotAssetCard";
import { btcMockCandles } from "./btcMockCandles";
import type {
  BtcBackgroundMode,
  BtcCardMode,
  BtcChartRange,
  BtcSpotAssetCardProps,
  BtcSpotSummaryResponse,
} from "./btcSpotAssetTypes";

const btcRangeLabels: Record<BtcChartRange, string> = {
  "1d": "1D",
  "7d": "7D（占位）",
  "30d": "30D（占位）",
  "90d": "90D（占位）",
  "1y": "1Y（占位）",
};

const backgroundModeLabels: Record<BtcBackgroundMode, string> = {
  none: "纯深色",
  gradient: "暗金渐变",
  image: "图片背景",
};

const mockDefaults = {
  totalValueUsd: "128567.32",
  btcAmount: "1.228743",
  averageBuyPriceUsd: "62842.15",
  currentPriceUsd: "104567.89",
  change24hPct: "1.82",
  change24hUsd: "2296.41",
};

const visualDefaults = {
  backgroundMode: "gradient" as BtcBackgroundMode,
  backgroundImage: "",
  cardHeight: 640,
  borderRadius: 30,
  glowIntensity: 0.72,
  showVolume: true,
  showCnyEstimate: true,
  showAutoRefreshBadge: true,
  compactMode: false,
};

function normalizeRefreshSeconds(value: number) {
  if (!Number.isFinite(value)) return 5;
  return Math.max(5, Math.min(60, Math.round(value)));
}

function freshnessText(summary: BtcSpotSummaryResponse | null) {
  if (!summary) return "未连接，使用 mock 数据";
  if (!summary.success) return summary.safeErrorMessage || "刷新失败";
  if (summary.freshness?.rateLimitMode === "slow")
    return "RateLimit 低，已降频";
  if (summary.connectionStatus === "degraded")
    return "部分数据降级，继续展示缓存";
  return "Gate Real Mode 已连接";
}

function modeStatusTone(summary: BtcSpotSummaryResponse | null) {
  if (!summary) return "text-[#D6A84F]";
  if (!summary.success || summary.connectionStatus === "disconnected")
    return "text-red-400";
  if (summary.connectionStatus === "degraded") return "text-[#D6A84F]";
  return "text-emerald-400";
}

export default function BtcSpotAssetCardExperiment() {
  const [mode, setMode] = useState<BtcCardMode>("mock");
  const [range, setRange] = useState<BtcChartRange>("1d");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(5);
  const [visual, setVisual] = useState(visualDefaults);
  const [mock, setMock] = useState(mockDefaults);
  const [gateSummary, setGateSummary] = useState<BtcSpotSummaryResponse | null>(
    null
  );
  const [gateError, setGateError] = useState<string | null>(null);
  const lastAsOfRef = useRef<number | null>(null);

  const cardProps = useMemo<BtcSpotAssetCardProps>(() => {
    const real = mode === "gate-real" && gateSummary?.success;
    return {
      mode,
      totalValueUsd: real
        ? gateSummary.totalValueUsd || mock.totalValueUsd
        : mock.totalValueUsd,
      btcAmount: real ? gateSummary.btcAmount || "0" : mock.btcAmount,
      averageBuyPriceUsd: real
        ? (gateSummary.averageBuyPriceUsd ?? null)
        : mock.averageBuyPriceUsd || null,
      averageBuyPriceScope: real
        ? gateSummary.averageBuyPriceScope || "unknown"
        : "full",
      averageBuyPriceMethod: real
        ? gateSummary.averageBuyPriceMethod
        : "fifo_remaining_cost",
      averageBuyTradeCount: real ? gateSummary.averageBuyTradeCount : 0,
      averageBuyHistoryComplete: real
        ? gateSummary.averageBuyHistoryComplete
        : true,
      currentPriceUsd: real
        ? gateSummary.currentPriceUsd || mock.currentPriceUsd
        : mock.currentPriceUsd,
      change24hPct: real
        ? (gateSummary.change24hPct ?? null)
        : mock.change24hPct,
      change24hUsd: real
        ? (gateSummary.change24hUsd ?? null)
        : mock.change24hUsd,
      lastUpdatedAt: real ? gateSummary.asOf : Date.now(),
      connectionStatus: real
        ? gateSummary.connectionStatus
        : mode === "gate-real"
          ? "degraded"
          : "connected",
      range,
      candles: real ? gateSummary.candles || [] : btcMockCandles,
      autoRefreshSeconds: normalizeRefreshSeconds(autoRefreshSeconds),
      ...visual,
    };
  }, [autoRefreshSeconds, gateSummary, mock, mode, range, visual]);

  useEffect(() => {
    if (mode !== "gate-real") {
      setGateError(null);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    async function loadSummary() {
      if (range !== "1d") return;
      try {
        const response = await fetch(
          `${API_BASE}/crypto/gate/spot/btc-summary?range=1d`,
          { headers: baseHeaders() }
        );
        const payload = (await response.json()) as BtcSpotSummaryResponse;
        if (!response.ok || !payload?.success) {
          throw new Error(payload?.safeErrorMessage || "BTC summary 读取失败");
        }
        if (cancelled) return;
        if (lastAsOfRef.current === payload.asOf) return;
        lastAsOfRef.current = payload.asOf;
        setGateSummary(payload);
        setGateError(null);
      } catch (error) {
        if (cancelled) return;
        setGateError(
          error instanceof Error ? error.message : "BTC summary 读取失败"
        );
      }
    }

    function schedule() {
      if (!autoRefresh) return;
      const hidden = document.visibilityState === "hidden";
      const delay = hidden
        ? 30_000
        : normalizeRefreshSeconds(autoRefreshSeconds) * 1_000;
      timer = window.setTimeout(async () => {
        await loadSummary();
        if (!cancelled) schedule();
      }, delay);
    }

    loadSummary();
    schedule();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [autoRefresh, autoRefreshSeconds, mode, range]);

  function updateVisual<K extends keyof typeof visualDefaults>(
    key: K,
    value: (typeof visualDefaults)[K]
  ) {
    setVisual((current) => ({ ...current, [key]: value }));
  }

  function updateMock<K extends keyof typeof mockDefaults>(
    key: K,
    value: (typeof mockDefaults)[K]
  ) {
    setMock((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="mt-8 rounded-[28px] border border-white/10 bg-white/[.035] p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.16)] light:border-slate-200 light:bg-white/70">
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-white light:text-slate-900">
            BTC Spot Card Experiment
          </div>
          <p className="mt-1 text-xs leading-5 text-white/60 light:text-slate-500">
            独立实验分栏 · Mock / Gate Real Mode · 只读 BTC_USDT 数据
          </p>
        </div>
        <div className="w-fit rounded-full bg-[#D6A84F]/10 px-3 py-1 text-xs font-bold text-[#D6A84F] shadow-[0_10px_28px_rgb(214_168_79_/_0.10)]">
          BTC Spot
        </div>
      </div>

      <div className="grid gap-5">
        <BtcSpotAssetCard {...cardProps} />

        <div className="rounded-[24px] border border-[#D6A84F]/15 bg-black/25 p-4 text-white shadow-[0_18px_48px_rgb(0_0_0_/_0.18)] light:border-slate-200 light:bg-white/80 light:text-slate-900">
          <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-sm font-bold">BTC 调控分栏</div>
              <div className="mt-1 text-xs text-white/50 light:text-slate-500">
                组件固定在上方完整展示；下方参数每行最多三个，只控制 BTC Spot
                Card。
              </div>
            </div>
            <div
              className={`rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-bold ${modeStatusTone(
                gateSummary
              )}`}
            >
              {mode === "mock" ? "Mock" : "Gate"}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            <SelectControl<BtcCardMode>
              label="数据模式"
              value={mode}
              options={["mock", "gate-real"]}
              optionLabels={{
                mock: "Mock Mode",
                "gate-real": "Gate Real Mode",
              }}
              onChange={setMode}
            />
            <SelectControl<BtcChartRange>
              label="时间范围"
              value={range}
              options={["1d", "7d", "30d", "90d", "1y"]}
              optionLabels={btcRangeLabels}
              onChange={setRange}
            />
            <ToggleControl
              label="自动刷新"
              checked={autoRefresh}
              onChange={setAutoRefresh}
            />
            <RangeControl
              label="刷新秒数"
              value={autoRefreshSeconds}
              min={5}
              max={60}
              step={1}
              suffix="s"
              onChange={setAutoRefreshSeconds}
            />

            <div className="rounded-xl border border-white/10 bg-white/[.035] p-3 text-xs font-semibold light:border-slate-200 light:bg-white">
              <div className="flex items-center justify-between gap-3">
                <span>Gate 数据状态</span>
                <span className="font-mono text-[10px] text-white/35 light:text-slate-400">
                  btc-summary
                </span>
              </div>
              <div className={`mt-2 ${modeStatusTone(gateSummary)}`}>
                {mode === "mock"
                  ? "未启用，使用 mock 参数"
                  : gateError || freshnessText(gateSummary)}
              </div>
              {mode === "gate-real" && gateSummary?.partialFailures?.length ? (
                <div className="mt-2 text-[11px] leading-5 text-[#D6A84F]">
                  {gateSummary.partialFailures
                    .map((item) => item.source)
                    .join(", ")}{" "}
                  降级
                </div>
              ) : null}
            </div>

            <RangeControl
              label="卡片高度"
              value={visual.cardHeight}
              min={420}
              max={720}
              step={1}
              suffix="px"
              onChange={(value) => updateVisual("cardHeight", value)}
            />
            <RangeControl
              label="圆角"
              value={visual.borderRadius}
              min={16}
              max={40}
              step={1}
              suffix="px"
              onChange={(value) => updateVisual("borderRadius", value)}
            />
            <RangeControl
              label="发光强度"
              value={visual.glowIntensity}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => updateVisual("glowIntensity", value)}
            />
            <SelectControl<BtcBackgroundMode>
              label="背景模式"
              value={visual.backgroundMode}
              options={["none", "gradient", "image"]}
              optionLabels={backgroundModeLabels}
              onChange={(value) => updateVisual("backgroundMode", value)}
            />
            <TextControl
              label="背景图片"
              value={visual.backgroundImage}
              onChange={(value) => updateVisual("backgroundImage", value)}
            />
            <ToggleControl
              label="显示成交量"
              checked={visual.showVolume}
              onChange={(value) => updateVisual("showVolume", value)}
            />
            <ToggleControl
              label="显示人民币估算"
              checked={visual.showCnyEstimate}
              onChange={(value) => updateVisual("showCnyEstimate", value)}
            />
            <ToggleControl
              label="显示刷新徽标"
              checked={visual.showAutoRefreshBadge}
              onChange={(value) => updateVisual("showAutoRefreshBadge", value)}
            />
            <ToggleControl
              label="紧凑模式"
              checked={visual.compactMode}
              onChange={(value) => updateVisual("compactMode", value)}
            />
            <TextControl
              label="Mock 总价值 USD"
              value={mock.totalValueUsd}
              onChange={(value) => updateMock("totalValueUsd", value)}
            />
            <TextControl
              label="Mock BTC 数量"
              value={mock.btcAmount}
              onChange={(value) => updateMock("btcAmount", value)}
            />
            <TextControl
              label="Mock 平均买入价"
              value={mock.averageBuyPriceUsd}
              onChange={(value) => updateMock("averageBuyPriceUsd", value)}
            />
            <TextControl
              label="Mock 当前价格"
              value={mock.currentPriceUsd}
              onChange={(value) => updateMock("currentPriceUsd", value)}
            />
            <TextControl
              label="Mock 24H 涨跌%"
              value={mock.change24hPct}
              onChange={(value) => updateMock("change24hPct", value)}
            />
            <TextControl
              label="Mock 24H 涨跌额"
              value={mock.change24hUsd}
              onChange={(value) => updateMock("change24hUsd", value)}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function TextControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-2 rounded-xl border border-white/10 bg-white/[.035] p-3 light:border-slate-200 light:bg-white">
      <span className="text-xs font-semibold text-white/70 light:text-slate-700">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-lg border border-white/10 bg-black/30 px-3 text-sm font-semibold text-white outline-none focus:border-[#D6A84F] light:border-slate-200 light:bg-white light:text-slate-900"
      />
    </label>
  );
}

function SelectControl<T extends string>({
  label,
  value,
  options,
  optionLabels,
  onChange,
}: {
  label: string;
  value: T;
  options: T[];
  optionLabels?: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="grid gap-2 rounded-xl border border-white/10 bg-white/[.035] p-3 light:border-slate-200 light:bg-white">
      <span className="text-xs font-semibold text-white/70 light:text-slate-700">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-9 rounded-lg border border-white/10 bg-black/30 px-3 text-sm font-semibold text-white outline-none focus:border-[#D6A84F] light:border-slate-200 light:bg-white light:text-slate-900"
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

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2 rounded-xl border border-white/10 bg-white/[.035] p-3 light:border-slate-200 light:bg-white">
      <span className="flex items-center justify-between gap-3 text-xs font-semibold text-white/70 light:text-slate-700">
        <span>{label}</span>
        <span className="font-mono text-[11px] text-[#D6A84F]">
          {value}
          {suffix}
        </span>
      </span>
      <div className="grid grid-cols-[1fr_76px] gap-2">
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
          className="h-8 rounded-lg border border-white/10 bg-black/30 px-2 text-xs font-semibold text-white outline-none focus:border-[#D6A84F] light:border-slate-200 light:bg-white light:text-slate-900"
        />
      </div>
    </label>
  );
}

function ToggleControl({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[.035] p-3 text-left light:border-slate-200 light:bg-white"
    >
      <span className="text-xs font-semibold text-white/70 light:text-slate-700">
        {label}
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
