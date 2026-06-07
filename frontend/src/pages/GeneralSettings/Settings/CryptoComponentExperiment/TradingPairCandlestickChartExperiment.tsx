import React, { useState } from "react";
import TradingPairCandlestickChart from "./TradingPairCandlestickChart";
import { presetById, tradingPairMockPresets } from "./tradingPairMockPresets";
import { useTradingPairCandlestickData } from "./useTradingPairCandlestickData";
import type { TradingPairCandlestickRange } from "./tradingPairCandlestickTypes";
import type {
  TradingPairDataMode,
  TradingPairMarketType,
} from "./tradingPairDetailTypes";

const defaultVisual = {
  cardHeight: 560,
  borderRadius: 24,
  glowIntensity: 0.72,
  accentColor: "#D6A84F",
  iconSize: 62,
  iconCropScale: 1.21,
  iconCropX: 0,
  iconCropY: 0,
  showVolume: true,
  showCrosshair: true,
  showCurrentPriceLine: true,
  showGrid: true,
  compactMode: true,
};

const dataModeLabels: Record<TradingPairDataMode, string> = {
  mock: "模拟模式",
  "gate-api": "Gate API模式",
};

function ToggleControl({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-[16px] border border-white/10 bg-white/[.035] px-3 py-3 text-xs font-bold text-white/72 light:border-slate-200 light:bg-white/70 light:text-slate-700">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-[#D6A84F]"
      />
    </label>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="rounded-[16px] border border-white/10 bg-white/[.035] px-3 py-3 text-xs font-bold text-white/72 light:border-slate-200 light:bg-white/70 light:text-slate-700">
      <div className="mb-2 flex items-center justify-between">
        <span>{label}</span>
        <span className="font-mono text-[#D6A84F]">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-[#D6A84F]"
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
  optionLabels?: Record<string, string>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="rounded-[16px] border border-white/10 bg-white/[.035] px-3 py-3 text-xs font-bold text-white/72 light:border-slate-200 light:bg-white/70 light:text-slate-700">
      <div className="mb-2">{label}</div>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="w-full rounded-[12px] border border-white/10 bg-black/40 px-3 py-2 text-white outline-none light:border-slate-200 light:bg-white light:text-slate-900"
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

export default function TradingPairCandlestickChartExperiment() {
  const [mode, setMode] = useState<TradingPairDataMode>("mock");
  const [pair, setPair] = useState("BTC_USDT");
  const [market, setMarket] = useState<TradingPairMarketType>("spot");
  const [range, setRange] = useState<TradingPairCandlestickRange>("1d");
  const [visual, setVisual] = useState(defaultVisual);

  const preset = presetById(pair);
  const {
    activeCandles,
    currentPriceQuote: currentPrice,
    change24hPct,
    status,
    error,
    loading,
    historyLoading,
    loadMoreHistory,
  } = useTradingPairCandlestickData({
    mode,
    pair,
    range,
    market,
    currentPriceFallback: preset.currentPriceQuote,
    change24hPctFallback: preset.change24hPct,
  });

  return (
    <section className="mt-8 rounded-[28px] border border-white/10 bg-white/[.035] p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.16)] light:border-slate-200 light:bg-white/70">
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-white light:text-slate-900">
            交易对K线趋势图组件实验
          </div>
          <p className="mt-1 text-xs leading-5 text-white/60 light:text-slate-500">
            通用交易对K线趋势图组件实验 · 图内滑动缩放 · 分段历史加载
          </p>
        </div>
        <div className="w-fit rounded-full bg-[#D6A84F]/10 px-3 py-1 text-xs font-bold text-[#D6A84F] shadow-[0_10px_28px_rgb(214_168_79_/_0.10)]">
          K线图
        </div>
      </div>

      <div className="grid gap-5">
        <TradingPairCandlestickChart
          mode={mode}
          pair={pair}
          range={range}
          market={market}
          baseAsset={preset.baseAsset}
          quoteAsset={preset.quoteAsset}
          symbol={preset.symbol}
          assetName={preset.assetName}
          assetNameCn={preset.assetNameCn}
          iconText={preset.iconText}
          iconImage={preset.iconImage}
          iconSize={visual.iconSize}
          iconCropScale={visual.iconCropScale}
          iconCropX={visual.iconCropX}
          iconCropY={visual.iconCropY}
          candles={activeCandles}
          currentPriceQuote={currentPrice}
          currentPriceUsd={currentPrice}
          change24hPct={change24hPct}
          status={status}
          autoRefreshSeconds={30}
          showVolume={visual.showVolume}
          showCrosshair={visual.showCrosshair}
          showCurrentPriceLine={visual.showCurrentPriceLine}
          showGrid={visual.showGrid}
          compactMode={true}
          cardHeight={visual.cardHeight}
          borderRadius={visual.borderRadius}
          glowIntensity={visual.glowIntensity}
          accentColor={visual.accentColor}
          loading={loading}
          historyLoading={historyLoading}
          error={error}
          onRangeChange={setRange}
          onLoadMoreHistory={loadMoreHistory}
        />

        <div className="rounded-[24px] border border-white/10 bg-black/25 p-4 text-white shadow-[0_18px_48px_rgb(0_0_0_/_0.18)] light:border-slate-200 light:bg-white/80 light:text-slate-900">
          <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-sm font-bold">K 线趋势图调控分栏</div>
              <div className="mt-1 text-xs text-white/50 light:text-slate-500">
                模拟模式不请求后端；Gate API模式使用只读现货K线。
              </div>
            </div>
            <div className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-bold text-[#D6A84F]">
              {dataModeLabels[mode]}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <SelectControl<TradingPairDataMode>
              label="数据模式"
              value={mode}
              options={["mock", "gate-api"]}
              optionLabels={dataModeLabels}
              onChange={setMode}
            />
            <SelectControl<TradingPairMarketType>
              label="市场类型"
              value={market}
              options={["spot", "futures", "margin"]}
              optionLabels={{
                spot: "现货 / spot",
                futures: "合约 / futures",
                margin: "杠杆 / margin",
              }}
              onChange={setMarket}
            />
            <SelectControl
              label="交易对示例"
              value={pair}
              options={tradingPairMockPresets.map((item) => item.id)}
              optionLabels={Object.fromEntries(
                tradingPairMockPresets.map((item) => [item.id, item.symbol])
              )}
              onChange={setPair}
            />
            <RangeControl
              label="卡片高度"
              value={visual.cardHeight}
              min={420}
              max={760}
              suffix="px"
              onChange={(value) =>
                setVisual((current) => ({ ...current, cardHeight: value }))
              }
            />
            <RangeControl
              label="圆角"
              value={visual.borderRadius}
              min={16}
              max={36}
              suffix="px"
              onChange={(value) =>
                setVisual((current) => ({ ...current, borderRadius: value }))
              }
            />
            <RangeControl
              label="发光强度"
              value={visual.glowIntensity}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) =>
                setVisual((current) => ({ ...current, glowIntensity: value }))
              }
            />
            <label className="rounded-[16px] border border-white/10 bg-white/[.035] px-3 py-3 text-xs font-bold text-white/72 light:border-slate-200 light:bg-white/70 light:text-slate-700">
              <div className="mb-2">强调色</div>
              <input
                type="color"
                value={visual.accentColor}
                onChange={(event) =>
                  setVisual((current) => ({
                    ...current,
                    accentColor: event.target.value,
                  }))
                }
                className="h-10 w-full rounded-[12px] border border-white/10 bg-black/40"
              />
            </label>
            <ToggleControl
              label="显示成交量"
              checked={visual.showVolume}
              onChange={(value) =>
                setVisual((current) => ({ ...current, showVolume: value }))
              }
            />
            <ToggleControl
              label="显示 crosshair"
              checked={visual.showCrosshair}
              onChange={(value) =>
                setVisual((current) => ({ ...current, showCrosshair: value }))
              }
            />
            <ToggleControl
              label="当前价线"
              checked={visual.showCurrentPriceLine}
              onChange={(value) =>
                setVisual((current) => ({
                  ...current,
                  showCurrentPriceLine: value,
                }))
              }
            />
            <ToggleControl
              label="显示网格"
              checked={visual.showGrid}
              onChange={(value) =>
                setVisual((current) => ({ ...current, showGrid: value }))
              }
            />
          </div>
        </div>
      </div>
    </section>
  );
}
