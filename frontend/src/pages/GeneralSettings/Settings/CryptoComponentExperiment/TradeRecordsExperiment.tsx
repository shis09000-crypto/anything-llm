import React, { useEffect, useState } from "react";
import {
  CRYPTO_CONFIG_KINDS,
  loadCryptoConfig,
  saveCryptoConfig,
} from "@/lib/communication/crypto/cryptoConfigClient";
import TradeRecordsTable from "./TradeRecordsTable";
import {
  rangeLabels,
  type PreviewState,
  type RangePreset,
  useTradeRecordsTableController,
} from "./useTradeRecordsTableController";
import type { TradeRecordsDataMode } from "./useTradeRecordsData";

const defaultVisual = {
  cardWidth: 980,
  cardHeight: 680,
  borderRadius: 28,
  compactMode: false,
  defaultPageSize: 10,
  defaultRangePreset: "30d" as RangePreset,
};

type VisualParams = typeof defaultVisual;

type SavedVisualConfig = {
  version: 1;
  savedAt: string;
  visual: VisualParams;
};

const REMOTE_CONFIG_KIND = CRYPTO_CONFIG_KINDS.tradeRecords;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numberValue(
  value: unknown,
  fallback: number,
  min: number,
  max: number
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function rangePresetValue(value: unknown, fallback: RangePreset): RangePreset {
  return value === "today" || value === "30d" || value === "90d"
    ? value
    : fallback;
}

function sanitizeVisualConfig(value: unknown): VisualParams {
  const source = isRecord(value) ? value : {};
  const defaultPageSize = numberValue(
    source.defaultPageSize,
    defaultVisual.defaultPageSize,
    5,
    10
  );

  return {
    cardWidth: numberValue(
      source.cardWidth,
      defaultVisual.cardWidth,
      720,
      1320
    ),
    cardHeight: numberValue(
      source.cardHeight,
      defaultVisual.cardHeight,
      520,
      920
    ),
    borderRadius: numberValue(
      source.borderRadius,
      defaultVisual.borderRadius,
      16,
      42
    ),
    compactMode: booleanValue(source.compactMode, defaultVisual.compactMode),
    defaultPageSize: defaultPageSize <= 5 ? 5 : 10,
    defaultRangePreset: rangePresetValue(
      source.defaultRangePreset,
      defaultVisual.defaultRangePreset
    ),
  };
}

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
      <div className="mb-2 flex items-center justify-between gap-3">
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

export default function TradeRecordsExperiment() {
  const [visual, setVisual] = useState(defaultVisual);
  const [mode, setMode] = useState<TradeRecordsDataMode>("mock");
  const [previewState, setPreviewState] = useState<PreviewState>("normal");
  const [saveStatus, setSaveStatus] =
    useState("后台参数尚未保存到本次实验预览。");
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const tradeRecordsController = useTradeRecordsTableController({
    mode,
    previewState,
    initialRangePreset: defaultVisual.defaultRangePreset,
    initialPageSize: defaultVisual.defaultPageSize,
  });
  const {
    hasMoreHistory,
    pageSize,
    range,
    rangePreset,
    refreshCurrentRange,
    records,
    setPage,
    setPageSize,
    setRangePreset,
    tableProps,
    tableSummary,
  } = tradeRecordsController;

  useEffect(() => {
    let mounted = true;

    async function loadSavedConfig() {
      try {
        const config = (await loadCryptoConfig(
          REMOTE_CONFIG_KIND
        )) as SavedVisualConfig | null;
        if (!mounted || !isRecord(config?.visual)) return;

        const savedVisual = sanitizeVisualConfig(config.visual);
        setVisual(savedVisual);
        setPageSize(savedVisual.defaultPageSize);
        setRangePreset(savedVisual.defaultRangePreset);
        setSaveStatus(
          config.savedAt
            ? `已加载后台参数 · ${new Date(config.savedAt).toLocaleString()}`
            : "已加载后台参数。"
        );
      } catch (error) {
        if (!mounted) return;
        setSaveStatus(
          error instanceof Error
            ? `后台参数读取失败：${error.message}`
            : "后台参数读取失败"
        );
      }
    }

    loadSavedConfig();

    return () => {
      mounted = false;
    };
  }, [setPageSize, setRangePreset]);

  function updateRangePreset(preset: RangePreset) {
    setRangePreset(preset);
    updateVisual("defaultRangePreset", preset);
  }

  function updateVisual<K extends keyof VisualParams>(
    key: K,
    value: VisualParams[K]
  ) {
    setVisual((current) => ({ ...current, [key]: value }));
  }

  async function saveVisualConfig() {
    setIsSavingConfig(true);
    setSaveStatus("正在保存参数到后台...");

    try {
      const savedAt = new Date().toISOString();
      await saveCryptoConfig(REMOTE_CONFIG_KIND, {
        version: 1,
        savedAt,
        visual,
      } satisfies SavedVisualConfig);

      setSaveStatus(`已保存到后台 · ${new Date(savedAt).toLocaleString()}`);
    } catch (error) {
      setSaveStatus(
        error instanceof Error ? `保存失败：${error.message}` : "保存失败"
      );
    } finally {
      setIsSavingConfig(false);
    }
  }

  function resetVisualConfig() {
    setVisual(defaultVisual);
    tradeRecordsController.reset({
      nextRangePreset: defaultVisual.defaultRangePreset,
      nextPageSize: defaultVisual.defaultPageSize,
    });
    setMode("mock");
    setPreviewState("normal");
    setSaveStatus("已重置为默认参数，尚未保存到后台。");
  }

  return (
    <section className="mt-8 rounded-[28px] border border-white/10 bg-white/[.035] p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.16)] light:border-slate-200 light:bg-white/70">
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-white light:text-slate-900">
            交易明细组件实验
          </div>
          <p className="mt-1 text-xs leading-5 text-white/60 light:text-slate-500">
            Trade Records Experiment · 只读成交明细 · 无交易操作
          </p>
        </div>
        <div className="w-fit rounded-full bg-[#D6A84F]/10 px-3 py-1 text-xs font-bold text-[#D6A84F] shadow-[0_10px_28px_rgb(214_168_79_/_0.10)]">
          Trade Records
        </div>
      </div>

      <div className="grid gap-5">
        <TradeRecordsTable
          {...tableProps}
          cardWidth={visual.cardWidth}
          cardHeight={visual.cardHeight}
          borderRadius={visual.borderRadius}
          compactMode={visual.compactMode}
          onPageSizeChange={(nextPageSize) => {
            const safePageSize = nextPageSize === 5 ? 5 : 10;
            setPageSize(safePageSize);
            updateVisual("defaultPageSize", safePageSize);
          }}
        />

        <div className="rounded-[24px] border border-[#D6A84F]/15 bg-black/25 p-4 text-white shadow-[0_18px_48px_rgb(0_0_0_/_0.18)] light:border-slate-200 light:bg-white/80 light:text-slate-900">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-sm font-bold">交易明细调控面板</div>
              <div className="mt-1 text-xs text-white/50 light:text-slate-500">
                REST 每批最多 50 条；翻页需要更多历史时才继续拉取。
              </div>
            </div>
            <div className="flex flex-col items-start gap-2 md:items-end">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={saveVisualConfig}
                  disabled={isSavingConfig}
                  className="h-9 rounded-xl bg-[#D6A84F] px-3 text-xs font-black text-black transition hover:bg-[#f0c766] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSavingConfig ? "保存中..." : "保存参数"}
                </button>
                <button
                  type="button"
                  onClick={resetVisualConfig}
                  className="h-9 rounded-xl border border-white/15 bg-white/10 px-3 text-xs font-bold text-white transition hover:bg-white/15 light:border-slate-200 light:bg-white light:text-slate-800"
                >
                  重置参数
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("mock");
                    setPreviewState("normal");
                    setPage(1);
                  }}
                  className={[
                    "h-9 rounded-xl px-3 text-xs font-black transition",
                    mode === "mock"
                      ? "bg-[#D6A84F] text-black"
                      : "border border-white/15 bg-white/10 text-white hover:bg-white/15 light:border-slate-200 light:bg-white light:text-slate-800",
                  ].join(" ")}
                >
                  使用 Mock
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("gate-api");
                    setPreviewState("normal");
                    setPage(1);
                    refreshCurrentRange();
                  }}
                  className={[
                    "h-9 rounded-xl px-3 text-xs font-black transition",
                    mode === "gate-api"
                      ? "bg-[#D6A84F] text-black"
                      : "border border-white/15 bg-white/10 text-white hover:bg-white/15 light:border-slate-200 light:bg-white light:text-slate-800",
                  ].join(" ")}
                >
                  连接真实 Gate
                </button>
              </div>
              <div className="max-w-[340px] text-left text-[11px] leading-4 text-white/45 light:text-slate-500 md:text-right">
                {saveStatus}
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-[16px] border border-white/10 bg-white/[.035] p-3 light:border-slate-200 light:bg-white/70">
              <div className="mb-2 text-xs font-bold text-white/70 light:text-slate-700">
                时间范围
              </div>
              <div className="flex flex-wrap gap-2">
                {(["today", "30d", "90d"] as RangePreset[]).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => updateRangePreset(preset)}
                    className={[
                      "h-8 rounded-xl px-3 text-xs font-black transition",
                      rangePreset === preset
                        ? "bg-[#D6A84F] text-black"
                        : "border border-white/15 bg-white/10 text-white hover:bg-white/15 light:border-slate-200 light:bg-white light:text-slate-800",
                    ].join(" ")}
                  >
                    {rangeLabels[preset]}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-[16px] border border-white/10 bg-white/[.035] p-3 light:border-slate-200 light:bg-white/70">
              <div className="mb-2 text-xs font-bold text-white/70 light:text-slate-700">
                Mock 状态
              </div>
              <div className="flex flex-wrap gap-2">
                {(
                  ["normal", "loading", "error", "empty"] as PreviewState[]
                ).map((state) => (
                  <button
                    key={state}
                    type="button"
                    onClick={() => {
                      setMode("mock");
                      setPreviewState(state);
                      setPage(1);
                    }}
                    className={[
                      "h-8 rounded-xl px-3 text-xs font-black transition",
                      mode === "mock" && previewState === state
                        ? "bg-[#D6A84F] text-black"
                        : "border border-white/15 bg-white/10 text-white hover:bg-white/15 light:border-slate-200 light:bg-white light:text-slate-800",
                    ].join(" ")}
                  >
                    {state === "normal"
                      ? "正常"
                      : state === "loading"
                        ? "Loading"
                        : state === "error"
                          ? "Error"
                          : "Empty"}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-[16px] border border-white/10 bg-white/[.035] p-3 text-xs font-bold leading-5 text-white/55 light:border-slate-200 light:bg-white/70 light:text-slate-600">
              <div>from: {new Date(range.fromSec * 1000).toLocaleString()}</div>
              <div>to: {new Date(range.toSec * 1000).toLocaleString()}</div>
              <div>loaded: {records.length}</div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <RangeControl
              label="卡片宽度"
              value={visual.cardWidth}
              min={720}
              max={1320}
              suffix="px"
              onChange={(value) => updateVisual("cardWidth", value)}
            />
            <RangeControl
              label="卡片高度"
              value={visual.cardHeight}
              min={520}
              max={920}
              suffix="px"
              onChange={(value) => updateVisual("cardHeight", value)}
            />
            <RangeControl
              label="卡片圆角"
              value={visual.borderRadius}
              min={16}
              max={42}
              suffix="px"
              onChange={(value) => updateVisual("borderRadius", value)}
            />
            <div className="rounded-[16px] border border-white/10 bg-white/[.035] p-3 light:border-slate-200 light:bg-white/70">
              <div className="mb-2 text-xs font-bold text-white/70 light:text-slate-700">
                默认每页数量
              </div>
              <div className="flex flex-wrap gap-2">
                {[5, 10].map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => {
                      const safePageSize = size === 5 ? 5 : 10;
                      setPageSize(safePageSize);
                      updateVisual("defaultPageSize", safePageSize);
                      setPage(1);
                    }}
                    className={[
                      "h-8 rounded-xl px-3 text-xs font-black transition",
                      pageSize === size
                        ? "bg-[#D6A84F] text-black"
                        : "border border-white/15 bg-white/10 text-white hover:bg-white/15 light:border-slate-200 light:bg-white light:text-slate-800",
                    ].join(" ")}
                  >
                    {size} / 页
                  </button>
                ))}
              </div>
            </div>
            <ToggleControl
              label="紧凑模式"
              checked={visual.compactMode}
              onChange={(value) => updateVisual("compactMode", value)}
            />
          </div>

          <div className="mt-4 rounded-2xl border border-white/15 bg-slate-950/70 p-4 light:border-slate-200 light:bg-slate-950">
            <div className="text-xs font-semibold text-sky-200">当前参数</div>
            <div className="mt-3 grid gap-1 rounded-xl bg-black/35 p-3 text-[11px] leading-5 text-sky-50 md:grid-cols-2">
              <code>dataMode: {mode}</code>
              <code>rangePreset: {rangePreset}</code>
              <code>pageSize: {pageSize}</code>
              <code>cardWidth: {visual.cardWidth}px</code>
              <code>cardHeight: {visual.cardHeight}px</code>
              <code>borderRadius: {visual.borderRadius}px</code>
              <code>compactMode: {String(visual.compactMode)}</code>
              <code>loadedRecords: {records.length}</code>
              <code>hasMoreHistory: {String(hasMoreHistory)}</code>
              <code>feeTotalRange: {tableSummary.totalFeeUsd} USD</code>
              <code>
                feeTotalYear: {tableSummary.yearTotalFeeUsd || "--"} USD
              </code>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
