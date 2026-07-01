import React, { useEffect, useMemo, useState } from "react";
import {
  CRYPTO_CONFIG_KINDS,
  loadCryptoConfig,
  saveCryptoConfig,
} from "@/lib/communication/crypto/cryptoConfigClient";
import AssetAllocationDonutCard from "./AssetAllocationDonutCard";
import { useAssetAllocationDonutData } from "./useAssetAllocationDonutData";
import type { AssetAllocationDonutCardProps } from "./assetAllocationDonutTypes";
import {
  assetAllocationDonutDefaultVisual,
  sanitizeAssetAllocationDonutVisual,
  type AssetAllocationDonutVisualParams,
} from "./assetAllocationDonutVisual";

type SavedVisualConfig = {
  version: 1;
  savedAt: string;
  visual: AssetAllocationDonutVisualParams;
};

const REMOTE_CONFIG_KIND = CRYPTO_CONFIG_KINDS.assetAllocationDonut;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

export default function AssetAllocationDonutExperiment() {
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [visual, setVisual] = useState(assetAllocationDonutDefaultVisual);
  const [saveStatus, setSaveStatus] =
    useState("后台参数尚未保存到本次实验预览。");
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const {
    activeItems,
    activeTotalValueUsd,
    connectRealGate,
    gateStatus,
    gateStatusText,
    useRealGateData,
    switchToMockData,
  } = useAssetAllocationDonutData();

  useEffect(() => {
    let mounted = true;

    async function loadSavedConfig() {
      try {
        const config = (await loadCryptoConfig(
          REMOTE_CONFIG_KIND
        )) as SavedVisualConfig | null;
        if (!mounted || !isRecord(config?.visual)) return;

        setVisual(sanitizeAssetAllocationDonutVisual(config.visual));
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

  const cardProps = useMemo<AssetAllocationDonutCardProps>(
    () => ({
      title: "资产分布",
      totalValueUsd: activeTotalValueUsd,
      items: activeItems,
      selectedAsset,
      onSelectAsset: setSelectedAsset,
      ...visual,
    }),
    [activeItems, activeTotalValueUsd, selectedAsset, visual]
  );

  function updateVisual<
    K extends keyof typeof assetAllocationDonutDefaultVisual,
  >(key: K, value: (typeof assetAllocationDonutDefaultVisual)[K]) {
    setVisual((current) => ({ ...current, [key]: value }));
  }

  const previewParams = [
    `dataMode: ${useRealGateData ? "gate" : "mock"}`,
    `maxVisibleItems: ${visual.maxVisibleItems}`,
    `cardWidth: ${visual.cardWidth}px`,
    `cardHeight: ${visual.cardHeight}px`,
    `donutSize: ${visual.donutSize}px`,
    `donutThickness: ${visual.donutThickness}px`,
    `borderRadius: ${visual.borderRadius}px`,
    `glowIntensity: ${visual.glowIntensity.toFixed(2)}`,
    `showFooterNote: ${visual.showFooterNote}`,
    `dimInactiveOnFocus: ${visual.dimInactiveOnFocus}`,
    `compactMode: ${visual.compactMode}`,
    `selectedAsset: ${selectedAsset || "none"}`,
  ];

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

  return (
    <section className="mt-8 rounded-[28px] border border-white/10 bg-white/[.035] p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.16)] light:border-slate-200 light:bg-white/70">
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-white light:text-slate-900">
            资产分布组件实验
          </div>
          <p className="mt-1 text-xs leading-5 text-white/60 light:text-slate-500">
            Asset Allocation Donut · 默认 1/2 尺寸 · 支持真实 Gate API
          </p>
        </div>
        <div className="w-fit rounded-full bg-[#D6A84F]/10 px-3 py-1 text-xs font-bold text-[#D6A84F] shadow-[0_10px_28px_rgb(214_168_79_/_0.10)]">
          Asset Allocation Donut
        </div>
      </div>

      <div className="grid gap-5">
        <AssetAllocationDonutCard {...cardProps} />

        <div className="rounded-[24px] border border-[#D6A84F]/15 bg-black/25 p-4 text-white shadow-[0_18px_48px_rgb(0_0_0_/_0.18)] light:border-slate-200 light:bg-white/80 light:text-slate-900">
          <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-sm font-bold">资产分布调控面板</div>
              <div className="mt-1 text-xs text-white/50 light:text-slate-500">
                只控制实验预览参数；组件本体不显示这些调控项。
              </div>
            </div>
            <div className="flex flex-col items-start gap-2 md:items-end">
              <div className="flex flex-wrap justify-start gap-2 md:justify-end">
                <button
                  type="button"
                  onClick={saveVisualConfig}
                  disabled={isSavingConfig}
                  className="h-9 w-fit rounded-xl bg-[#D6A84F] px-3 text-xs font-black text-black transition hover:bg-[#f0c766] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSavingConfig ? "保存中..." : "保存参数"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setVisual(assetAllocationDonutDefaultVisual);
                    setSelectedAsset(null);
                    switchToMockData();
                    setSaveStatus("已重置为默认参数，尚未保存到后台。");
                  }}
                  className="h-9 w-fit rounded-xl border border-white/15 bg-white/10 px-3 text-xs font-bold text-white transition hover:bg-white/15 light:border-slate-200 light:bg-white light:text-slate-800 light:hover:bg-slate-50"
                >
                  重置参数
                </button>
              </div>
              <div className="max-w-[320px] text-left text-[11px] leading-4 text-white/45 light:text-slate-500 md:text-right">
                {saveStatus}
              </div>
            </div>
          </div>

          <div className="mb-4 grid gap-3 rounded-2xl border border-white/10 bg-white/[.035] p-3 text-xs font-bold text-white/70 light:border-slate-200 light:bg-white/70 light:text-slate-700 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
            <div>
              <div className="text-sm text-white light:text-slate-900">
                Gate 真实 API Key
              </div>
              <div
                className={[
                  "mt-1",
                  gateStatus === "connected"
                    ? "text-emerald-300"
                    : gateStatus === "degraded"
                      ? "text-[#D6A84F]"
                      : gateStatus === "error"
                        ? "text-rose-300"
                        : "text-white/50 light:text-slate-500",
                ].join(" ")}
              >
                {gateStatusText}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedAsset(null);
                connectRealGate();
              }}
              disabled={gateStatus === "loading"}
              className="h-10 rounded-xl bg-[#D6A84F] px-4 text-xs font-black text-black transition hover:bg-[#f0c766] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {gateStatus === "loading" ? "连接中..." : "连接真实 Gate"}
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedAsset(null);
                switchToMockData();
              }}
              className="h-10 rounded-xl border border-white/15 bg-white/10 px-4 text-xs font-black text-white transition hover:bg-white/15 light:border-slate-200 light:bg-white light:text-slate-800"
            >
              使用 Mock
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <RangeControl
              label="最多展示资产"
              value={visual.maxVisibleItems}
              min={2}
              max={8}
              onChange={(value) => updateVisual("maxVisibleItems", value)}
            />
            <RangeControl
              label="卡片宽度"
              value={visual.cardWidth}
              min={420}
              max={1120}
              suffix="px"
              onChange={(value) => updateVisual("cardWidth", value)}
            />
            <RangeControl
              label="卡片高度"
              value={visual.cardHeight}
              min={260}
              max={760}
              suffix="px"
              onChange={(value) => updateVisual("cardHeight", value)}
            />
            <RangeControl
              label="圆环尺寸"
              value={visual.donutSize}
              min={150}
              max={440}
              suffix="px"
              onChange={(value) => updateVisual("donutSize", value)}
            />
            <RangeControl
              label="圆环厚度"
              value={visual.donutThickness}
              min={30}
              max={110}
              suffix="px"
              onChange={(value) => updateVisual("donutThickness", value)}
            />
            <RangeControl
              label="卡片圆角"
              value={visual.borderRadius}
              min={16}
              max={42}
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
            <ToggleControl
              label="显示底部注记"
              checked={visual.showFooterNote}
              onChange={(value) => updateVisual("showFooterNote", value)}
            />
            <ToggleControl
              label="聚焦时模糊背景"
              checked={visual.dimInactiveOnFocus}
              onChange={(value) => updateVisual("dimInactiveOnFocus", value)}
            />
            <ToggleControl
              label="紧凑模式"
              checked={visual.compactMode}
              onChange={(value) => updateVisual("compactMode", value)}
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
