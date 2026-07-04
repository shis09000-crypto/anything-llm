import React, { useEffect, useMemo, useState } from "react";
import {
  CRYPTO_CONFIG_KINDS,
  loadCryptoConfig,
  saveCryptoConfig,
} from "@/lib/communication/crypto/cryptoConfigClient";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";
import OpenFuturesPositionsCard from "./OpenFuturesPositionsCard";
import {
  mockOpenFuturesPositions,
  mockOpenFuturesSummary,
} from "./openFuturesPositionsMockData";
import { useOpenFuturesPositionsData } from "./useOpenFuturesPositionsData";
import type { OpenFuturesPositionsCardProps } from "./openFuturesPositionsTypes";

type PreviewState = "normal" | "loading" | "error" | "empty";
type DataMode = "mock" | "gate-api";

const defaultVisual = {
  cardWidth: 980,
  cardHeight: 560,
  visiblePositionCount: 5,
  borderRadius: 28,
  compactMode: false,
  showSummaryFooter: true,
  showLeverageBars: true,
};

type VisualParams = typeof defaultVisual;

type SavedVisualConfig = {
  version: 1;
  savedAt: string;
  visual: VisualParams;
};

const REMOTE_CONFIG_KIND = CRYPTO_CONFIG_KINDS.openFuturesPositions;

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

function sanitizeVisualConfig(value: unknown): VisualParams {
  const source = isRecord(value) ? value : {};
  return {
    cardWidth: numberValue(
      source.cardWidth,
      defaultVisual.cardWidth,
      720,
      1280
    ),
    cardHeight: numberValue(
      source.cardHeight,
      defaultVisual.cardHeight,
      360,
      760
    ),
    visiblePositionCount: numberValue(
      source.visiblePositionCount,
      defaultVisual.visiblePositionCount,
      2,
      10
    ),
    borderRadius: numberValue(
      source.borderRadius,
      defaultVisual.borderRadius,
      16,
      42
    ),
    compactMode: booleanValue(source.compactMode, defaultVisual.compactMode),
    showSummaryFooter: booleanValue(
      source.showSummaryFooter,
      defaultVisual.showSummaryFooter
    ),
    showLeverageBars: booleanValue(
      source.showLeverageBars,
      defaultVisual.showLeverageBars
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

export default function OpenFuturesPositionsExperiment() {
  const [visual, setVisual] = useState(defaultVisual);
  const [previewState, setPreviewState] = useState<PreviewState>("normal");
  const [dataMode, setDataMode] = useState<DataMode>("mock");
  const [saveStatus, setSaveStatus] =
    useState("后台参数尚未保存到本次实验预览。");
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const openPositions = useOpenFuturesPositionsData({
    mode: dataMode,
    mockPositions: mockOpenFuturesPositions,
    mockSummary: mockOpenFuturesSummary,
  });

  useEffect(() => {
    let mounted = true;

    async function loadSavedConfig() {
      try {
        const config = (await loadCryptoConfig(
          REMOTE_CONFIG_KIND
        )) as SavedVisualConfig | null;
        if (!mounted || !isRecord(config?.visual)) return;

        setVisual(sanitizeVisualConfig(config.visual));
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
  }, []);

  const cardProps = useMemo<OpenFuturesPositionsCardProps>(() => {
    const usingMock = dataMode === "mock";
    return {
      positions:
        usingMock && previewState === "empty" ? [] : openPositions.positions,
      summary: openPositions.summary,
      filterLabel: "全部合约",
      lastUpdatedAt: openPositions.lastUpdatedAt,
      loading: usingMock ? previewState === "loading" : openPositions.loading,
      error:
        usingMock && previewState === "error"
          ? "合约持仓读取失败，请稍后重试。当前组件不会执行任何交易请求。"
          : openPositions.error,
      status: openPositions.status,
      onRefresh: openPositions.refresh,
      ...visual,
    };
  }, [dataMode, openPositions, previewState, visual]);

  function updateVisual<K extends keyof typeof defaultVisual>(
    key: K,
    value: (typeof defaultVisual)[K]
  ) {
    setVisual((current) => ({ ...current, [key]: value }));
  }

  const previewParams = [
    `dataMode: ${dataMode}`,
    `connectionStatus: ${openPositions.status}`,
    `lastRestFetchAt: ${
      openPositions.lastRestFetchAt
        ? new Date(openPositions.lastRestFetchAt).toLocaleTimeString()
        : "--"
    }`,
    `lastWsMessageAt: ${
      openPositions.lastWsMessageAt
        ? new Date(openPositions.lastWsMessageAt).toLocaleTimeString()
        : "--"
    }`,
    `previewState: ${previewState}`,
    `cardWidth: ${visual.cardWidth}px`,
    `cardHeight: ${visual.cardHeight}px`,
    `visiblePositionCount: ${visual.visiblePositionCount}`,
    `borderRadius: ${visual.borderRadius}px`,
    `compactMode: ${visual.compactMode}`,
    `showSummaryFooter: ${visual.showSummaryFooter}`,
    `showLeverageBars: ${visual.showLeverageBars}`,
  ];

  async function saveVisualConfig() {
    setIsSavingConfig(true);
    setSaveStatus("正在保存参数到后台...");

    const savedAt = new Date().toISOString();
    const action = optimisticActionCenter.run({
      type: "crypto.ui.openFutures.save",
      scope: {
        route: "settings",
        surface: "crypto-center",
        setting: "open_futures_visual",
      },
      priority: "P1",
      policy: "visible",
      intentRank: 0,
      protected: true,
      abortable: false,
      label: "optimistic:crypto-open-futures-config",
      optimisticPatch: () =>
        setSaveStatus(`正在同步后台 · ${new Date(savedAt).toLocaleString()}`),
      rollbackPatch: () => setSaveStatus("保存失败"),
      serverCall: async ({ signal }) =>
        await saveCryptoConfig(
          REMOTE_CONFIG_KIND,
          {
            version: 1,
            savedAt,
            visual,
          } satisfies SavedVisualConfig,
          { signal, task: false }
        ),
    });

    try {
      const outcome = await action.promise;
      if (!outcome.ok) throw outcome.error;
      setSaveStatus(`已保存到后台 · ${new Date(savedAt).toLocaleString()}`);
    } catch (error) {
      setSaveStatus(
        error instanceof Error ? `保存失败：${error.message}` : "保存失败"
      );
    } finally {
      setIsSavingConfig(false);
    }
  }

  return (
    <section className="mt-8 rounded-[28px] border border-white/10 bg-white/[.035] p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.16)] light:border-slate-200 light:bg-white/70">
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-white light:text-slate-900">
            未平仓合约显示组件实验
          </div>
          <p className="mt-1 text-xs leading-5 text-white/60 light:text-slate-500">
            Open Futures Positions · 只读持仓展示 · 无交易操作
          </p>
        </div>
        <div className="w-fit rounded-full bg-[#D6A84F]/10 px-3 py-1 text-xs font-bold text-[#D6A84F] shadow-[0_10px_28px_rgb(214_168_79_/_0.10)]">
          Open Futures Positions
        </div>
      </div>

      <div className="grid gap-5">
        <OpenFuturesPositionsCard {...cardProps} />

        <div className="rounded-[24px] border border-[#D6A84F]/15 bg-black/25 p-4 text-white shadow-[0_18px_48px_rgb(0_0_0_/_0.18)] light:border-slate-200 light:bg-white/80 light:text-slate-900">
          <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-sm font-bold">未平仓合约调控面板</div>
              <div className="mt-1 text-xs text-white/50 light:text-slate-500">
                只控制实验预览参数；组件本体不包含任何交易按钮。
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
                {(
                  ["normal", "loading", "error", "empty"] as PreviewState[]
                ).map((state) => (
                  <button
                    key={state}
                    type="button"
                    onClick={() => {
                      setPreviewState(state);
                      if (dataMode === "mock") openPositions.refresh();
                    }}
                    className={[
                      "h-9 rounded-xl px-3 text-xs font-black transition",
                      previewState === state
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
                <button
                  type="button"
                  onClick={() => {
                    setVisual(defaultVisual);
                    setPreviewState("normal");
                    setDataMode("mock");
                    setSaveStatus("已重置为默认参数，尚未保存到后台。");
                    openPositions.refresh();
                  }}
                  className="h-9 rounded-xl border border-white/15 bg-white/10 px-3 text-xs font-bold text-white transition hover:bg-white/15 light:border-slate-200 light:bg-white light:text-slate-800"
                >
                  重置参数
                </button>
              </div>
              <div className="max-w-[340px] text-left text-[11px] leading-4 text-white/45 light:text-slate-500 md:text-right">
                {saveStatus}
              </div>
            </div>
          </div>

          <div className="mb-4 grid gap-3 rounded-2xl border border-white/10 bg-white/[.035] p-3 text-xs font-bold text-white/70 light:border-slate-200 light:bg-white/70 light:text-slate-700 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
            <div>
              <div className="text-sm text-white light:text-slate-900">
                Gate 真实 Futures API
              </div>
              <div
                className={[
                  "mt-1",
                  openPositions.status === "connected"
                    ? "text-emerald-300"
                    : openPositions.status === "degraded"
                      ? "text-[#D6A84F]"
                      : "text-rose-300",
                ].join(" ")}
              >
                {dataMode === "gate-api"
                  ? openPositions.error ||
                    "REST 快照 + 私有 WS 实时更新；仅展示持仓，不发送交易请求。"
                  : "使用 mock 数据；真实数据开关不会保存到后台。"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setPreviewState("normal");
                setDataMode("gate-api");
              }}
              disabled={dataMode === "gate-api" && openPositions.loading}
              className="h-10 rounded-xl bg-[#D6A84F] px-4 text-xs font-black text-black transition hover:bg-[#f0c766] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {dataMode === "gate-api" && openPositions.loading
                ? "连接中..."
                : "连接真实 Gate"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDataMode("mock");
                setPreviewState("normal");
              }}
              className="h-10 rounded-xl border border-white/15 bg-white/10 px-4 text-xs font-black text-white transition hover:bg-white/15 light:border-slate-200 light:bg-white light:text-slate-800"
            >
              使用 Mock
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <RangeControl
              label="卡片宽度"
              value={visual.cardWidth}
              min={720}
              max={1280}
              suffix="px"
              onChange={(value) => updateVisual("cardWidth", value)}
            />
            <RangeControl
              label="卡片高度"
              value={visual.cardHeight}
              min={360}
              max={760}
              suffix="px"
              onChange={(value) => updateVisual("cardHeight", value)}
            />
            <RangeControl
              label="单页面显示合约个数"
              value={visual.visiblePositionCount}
              min={2}
              max={10}
              onChange={(value) => updateVisual("visiblePositionCount", value)}
            />
            <RangeControl
              label="卡片圆角"
              value={visual.borderRadius}
              min={16}
              max={42}
              suffix="px"
              onChange={(value) => updateVisual("borderRadius", value)}
            />
            <ToggleControl
              label="紧凑模式"
              checked={visual.compactMode}
              onChange={(value) => updateVisual("compactMode", value)}
            />
            <ToggleControl
              label="显示底部汇总"
              checked={visual.showSummaryFooter}
              onChange={(value) => updateVisual("showSummaryFooter", value)}
            />
            <ToggleControl
              label="显示强平风险灯"
              checked={visual.showLeverageBars}
              onChange={(value) => updateVisual("showLeverageBars", value)}
            />
          </div>

          <div className="mt-4 rounded-2xl border border-white/15 bg-slate-950/70 p-4 light:border-slate-200 light:bg-slate-950">
            <div className="text-xs font-semibold text-sky-200">当前参数</div>
            <div className="mt-3 grid gap-1 rounded-xl bg-black/35 p-3 text-[11px] leading-5 text-sky-50 md:grid-cols-2">
              {previewParams.map((item) => (
                <code key={item}>{item}</code>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
