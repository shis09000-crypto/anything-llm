import React, { useEffect, useMemo, useState } from "react";
import {
  clearCryptoConfig,
  CRYPTO_CONFIG_KINDS,
  loadCryptoConfig,
  saveCryptoConfig,
} from "@/lib/communication/crypto/cryptoConfigClient";
import TradingPairDetailCard from "./TradingPairDetailCard";
import { presetById, tradingPairMockPresets } from "./tradingPairMockPresets";
import { useTradingPairDetailData } from "./useTradingPairDetailData";
import type {
  AverageBuyPriceMethod,
  TradingPairConnectionStatus,
  TradingPairDataMode,
  TradingPairDetailCardProps,
  TradingPairDetailResponse,
  TradingPairMarketType,
  TradingPairPreset,
} from "./tradingPairDetailTypes";

const marketLabels: Record<TradingPairMarketType, string> = {
  spot: "现货 / spot",
  futures: "合约 / futures",
  margin: "杠杆 / margin",
};

const averageMethodLabels: Record<AverageBuyPriceMethod, string> = {
  moving_weighted: "移动加权估算",
  recent_weighted: "最近成交估算",
  manual: "手动录入",
  unknown: "待统计",
};

const statusLabels: Record<TradingPairConnectionStatus, string> = {
  connected: "已连接 / Live",
  degraded: "降级 / Degraded",
  disconnected: "离线 / Offline",
};

const STORAGE_KEY = "anythingllm_crypto_trading_pair_detail_config_v1";
const REMOTE_CONFIG_KIND = CRYPTO_CONFIG_KINDS.tradingPairDetail;

const commonVisualDefaults = {
  cardWidth: 590,
  cardHeight: 487,
  borderRadius: 28,
  glowIntensity: 0.75,
  iconSize: 62,
  iconCropScale: 1.21,
  iconCropX: 0,
  iconCropY: 0,
  showUsdEstimate: true,
  showMarketBadge: true,
  showInfoIcons: true,
  compactMode: false,
};

const pairVisualDefaults = {
  iconSize: 62,
  iconCropScale: 1.21,
  iconCropX: 0,
  iconCropY: 0,
};

type CommonVisualParams = typeof commonVisualDefaults;
type PairVisualParams = typeof pairVisualDefaults;
type TradingPairMockParams = ReturnType<typeof initialMock>;

type TradingPairSavedPairParams = {
  accentColor: string;
  mock: TradingPairMockParams;
  useCustomIconCrop: boolean;
  visual: PairVisualParams;
};

type TradingPairSavedConfig = {
  version: 1;
  savedAt: string;
  common: {
    dataMode: TradingPairDataMode;
    pairPreset: string;
    marketType: TradingPairMarketType;
    visual: CommonVisualParams;
  };
  pairs: Record<string, TradingPairSavedPairParams>;
};

function initialMock(preset: TradingPairPreset) {
  return {
    holdingValueQuote: preset.holdingValueQuote,
    holdingValueUsd: preset.holdingValueUsd,
    change24hPct: preset.change24hPct,
    change24hQuote: preset.change24hQuote,
    averageBuyPriceQuote: preset.averageBuyPriceQuote || "",
    averageBuyPriceMethod: preset.averageBuyPriceMethod,
    currentPriceQuote: preset.currentPriceQuote,
    holdingAmountBase: preset.holdingAmountBase,
    lastUpdatedAt: new Date().toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    connectionStatus: "connected" as TradingPairConnectionStatus,
  };
}

function defaultPairParams(
  preset: TradingPairPreset
): TradingPairSavedPairParams {
  return {
    accentColor: preset.accentColor,
    mock: initialMock(preset),
    useCustomIconCrop: false,
    visual: { ...pairVisualDefaults },
  };
}

function defaultPairParamsMap() {
  return Object.fromEntries(
    tradingPairMockPresets.map((preset) => [
      preset.id,
      defaultPairParams(preset),
    ])
  ) as Record<string, TradingPairSavedPairParams>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function optionValue<T extends string>(
  options: readonly T[],
  value: unknown,
  fallback: T
) {
  return typeof value === "string" && options.includes(value as T)
    ? (value as T)
    : fallback;
}

function savedPairPreset(value: unknown) {
  if (typeof value !== "string") return "BTC_USDT";
  return tradingPairMockPresets.some((preset) => preset.id === value)
    ? value
    : "BTC_USDT";
}

function sanitizeCommonVisual(
  value: unknown,
  legacyIconVisual: unknown = null
): CommonVisualParams {
  const source = isRecord(value) ? value : {};
  const iconSource = isRecord(legacyIconVisual) ? legacyIconVisual : source;
  return {
    cardWidth: numberValue(source.cardWidth, commonVisualDefaults.cardWidth),
    cardHeight: numberValue(source.cardHeight, commonVisualDefaults.cardHeight),
    borderRadius: numberValue(
      source.borderRadius,
      commonVisualDefaults.borderRadius
    ),
    glowIntensity: numberValue(
      source.glowIntensity,
      commonVisualDefaults.glowIntensity
    ),
    iconSize: numberValue(iconSource.iconSize, commonVisualDefaults.iconSize),
    iconCropScale: numberValue(
      iconSource.iconCropScale,
      commonVisualDefaults.iconCropScale
    ),
    iconCropX: numberValue(
      iconSource.iconCropX,
      commonVisualDefaults.iconCropX
    ),
    iconCropY: numberValue(
      iconSource.iconCropY,
      commonVisualDefaults.iconCropY
    ),
    showUsdEstimate: booleanValue(
      source.showUsdEstimate,
      commonVisualDefaults.showUsdEstimate
    ),
    showMarketBadge: booleanValue(
      source.showMarketBadge,
      commonVisualDefaults.showMarketBadge
    ),
    showInfoIcons: booleanValue(
      source.showInfoIcons,
      commonVisualDefaults.showInfoIcons
    ),
    compactMode: booleanValue(
      source.compactMode,
      commonVisualDefaults.compactMode
    ),
  };
}

function sanitizePairVisual(value: unknown): PairVisualParams {
  const source = isRecord(value) ? value : {};
  return {
    iconSize: numberValue(source.iconSize, pairVisualDefaults.iconSize),
    iconCropScale: numberValue(
      source.iconCropScale,
      pairVisualDefaults.iconCropScale
    ),
    iconCropX: numberValue(source.iconCropX, pairVisualDefaults.iconCropX),
    iconCropY: numberValue(source.iconCropY, pairVisualDefaults.iconCropY),
  };
}

function sanitizeMock(
  value: unknown,
  preset: TradingPairPreset
): TradingPairMockParams {
  const defaults = initialMock(preset);
  const source = isRecord(value) ? value : {};
  return {
    holdingValueQuote: stringValue(
      source.holdingValueQuote,
      defaults.holdingValueQuote
    ),
    holdingValueUsd: stringValue(
      source.holdingValueUsd,
      defaults.holdingValueUsd
    ),
    change24hPct: stringValue(source.change24hPct, defaults.change24hPct),
    change24hQuote: stringValue(source.change24hQuote, defaults.change24hQuote),
    averageBuyPriceQuote: stringValue(
      source.averageBuyPriceQuote,
      defaults.averageBuyPriceQuote
    ),
    averageBuyPriceMethod: optionValue(
      ["moving_weighted", "recent_weighted", "manual", "unknown"] as const,
      source.averageBuyPriceMethod,
      defaults.averageBuyPriceMethod
    ),
    currentPriceQuote: stringValue(
      source.currentPriceQuote,
      defaults.currentPriceQuote
    ),
    holdingAmountBase: stringValue(
      source.holdingAmountBase,
      defaults.holdingAmountBase
    ),
    lastUpdatedAt: stringValue(source.lastUpdatedAt, defaults.lastUpdatedAt),
    connectionStatus: optionValue(
      ["connected", "degraded", "disconnected"] as const,
      source.connectionStatus,
      defaults.connectionStatus
    ),
  };
}

function sanitizePairParams(
  value: unknown,
  preset: TradingPairPreset
): TradingPairSavedPairParams {
  const source = isRecord(value) ? value : {};
  return {
    accentColor: stringValue(source.accentColor, preset.accentColor),
    mock: sanitizeMock(source.mock, preset),
    useCustomIconCrop: booleanValue(source.useCustomIconCrop, false),
    visual: sanitizePairVisual(source.visual),
  };
}

function sanitizeSavedConfig(parsed: unknown): TradingPairSavedConfig | null {
  if (!isRecord(parsed)) return null;
  const common = isRecord(parsed.common) ? parsed.common : {};
  const pairs = isRecord(parsed.pairs) ? parsed.pairs : {};
  const btcPair = isRecord(pairs.BTC_USDT) ? pairs.BTC_USDT : {};
  const legacyBtcIconVisual = isRecord(btcPair.visual) ? btcPair.visual : null;

  return {
    version: 1,
    savedAt: stringValue(parsed.savedAt, ""),
    common: {
      dataMode: optionValue(
        ["mock", "gate-api"] as const,
        common.dataMode,
        "mock"
      ),
      pairPreset: savedPairPreset(common.pairPreset),
      marketType: optionValue(
        ["spot", "futures", "margin"] as const,
        common.marketType,
        "spot"
      ),
      visual: sanitizeCommonVisual(common.visual, legacyBtcIconVisual),
    },
    pairs: Object.fromEntries(
      tradingPairMockPresets.map((preset) => [
        preset.id,
        sanitizePairParams(pairs[preset.id], preset),
      ])
    ) as Record<string, TradingPairSavedPairParams>,
  };
}

function loadSavedConfig(): TradingPairSavedConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return sanitizeSavedConfig(parsed);
  } catch {
    return null;
  }
}

function saveConfig(config: TradingPairSavedConfig) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

async function loadRemoteSavedConfig(): Promise<TradingPairSavedConfig | null> {
  try {
    const config = await loadCryptoConfig(REMOTE_CONFIG_KIND);
    return sanitizeSavedConfig(config);
  } catch {
    return null;
  }
}

async function saveRemoteConfig(config: TradingPairSavedConfig) {
  try {
    return await saveCryptoConfig(REMOTE_CONFIG_KIND, config);
  } catch {
    return false;
  }
}

async function clearRemoteSavedConfig() {
  try {
    return await clearCryptoConfig(REMOTE_CONFIG_KIND);
  } catch {
    return false;
  }
}

function clearSavedConfig() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort cleanup only.
  }
}

function timestampFromTime(value: string) {
  if (!value) return null;
  const [hour, minute, second] = value.split(":").map(Number);
  if (![hour, minute, second].every(Number.isFinite)) return Date.now();
  const date = new Date();
  date.setHours(hour, minute, second || 0, 0);
  return date.getTime();
}

function apiStatusText({
  mode,
  marketType,
  response,
  error,
  reconnectAttempt,
}: {
  mode: TradingPairDataMode;
  marketType: TradingPairMarketType;
  response: TradingPairDetailResponse | null;
  error: string | null;
  reconnectAttempt: number;
}) {
  if (mode === "mock") return "未启用，使用 mock 参数";
  if (marketType !== "spot") return "真实 API 暂仅支持现货";
  if (error) {
    return response
      ? `断联重连中 · 第 ${reconnectAttempt} 次重试 · ${error}`
      : `连接失败，正在重连 · ${error}`;
  }
  if (!response) return "准备读取 Gate 现货数据";
  if (response.freshness?.rateLimitMode === "slow")
    return "RateLimit 低，已降频";
  if (response.connectionStatus === "degraded")
    return "部分数据降级，继续展示缓存";
  return "Gate API Mode 已连接";
}

function statusTone(
  response: TradingPairDetailResponse | null,
  error: string | null
) {
  if (error) return "text-red-400";
  if (!response) return "text-[#D6A84F]";
  if (!response.success || response.connectionStatus === "disconnected")
    return "text-red-400";
  if (response.connectionStatus === "degraded") return "text-[#D6A84F]";
  return "text-emerald-400";
}

function iconCropStyle({
  iconCropScale,
  iconCropX,
  iconCropY,
}: {
  iconCropScale: number;
  iconCropX: number;
  iconCropY: number;
}) {
  const scale = Math.max(0.6, Math.min(iconCropScale, 2.4));
  return {
    transform: `translate(${iconCropX}px, ${iconCropY}px) scale(${scale})`,
    transformOrigin: "center",
  };
}

export default function TradingPairDetailCardExperiment() {
  const savedConfig = useMemo(() => loadSavedConfig(), []);
  const [dataMode, setDataMode] = useState<TradingPairDataMode>(
    () => savedConfig?.common.dataMode || "mock"
  );
  const [pairPreset, setPairPreset] = useState(
    () => savedConfig?.common.pairPreset || "BTC_USDT"
  );
  const [marketType, setMarketType] = useState<TradingPairMarketType>(
    () => savedConfig?.common.marketType || "spot"
  );
  const [commonVisual, setCommonVisual] = useState<CommonVisualParams>(
    () => savedConfig?.common.visual || commonVisualDefaults
  );
  const [pairParamsById, setPairParamsById] = useState<
    Record<string, TradingPairSavedPairParams>
  >(() => savedConfig?.pairs || defaultPairParamsMap());
  const [saveStatus, setSaveStatus] = useState<string | null>(
    savedConfig?.savedAt ? "已加载上次保存配置" : null
  );
  const preset = presetById(pairPreset);
  const {
    response: apiResponse,
    error: apiError,
    reconnectAttempt,
    clear: clearApiState,
  } = useTradingPairDetailData({
    mode: dataMode,
    pair: preset.gateCurrencyPair,
    market: marketType,
  });

  function applySavedConfig(config: TradingPairSavedConfig) {
    setDataMode(config.common.dataMode);
    setPairPreset(config.common.pairPreset);
    setMarketType(config.common.marketType);
    setCommonVisual(config.common.visual);
    setPairParamsById(config.pairs);
    clearApiState();
  }

  const btcPairParams =
    pairParamsById.BTC_USDT || defaultPairParams(presetById("BTC_USDT"));
  const currentPairParams =
    pairParamsById[pairPreset] || defaultPairParams(preset);
  const { accentColor, mock } = currentPairParams;
  const effectiveIconVisual =
    pairPreset === "BTC_USDT" || currentPairParams.useCustomIconCrop
      ? currentPairParams.visual
      : btcPairParams.visual;
  const isUsingBtcCropTemplate =
    pairPreset !== "BTC_USDT" && !currentPairParams.useCustomIconCrop;
  const visual = useMemo(
    () => ({ ...commonVisual, ...effectiveIconVisual }),
    [commonVisual, effectiveIconVisual]
  );

  const cardProps = useMemo<TradingPairDetailCardProps>(() => {
    const real =
      dataMode === "gate-api" && marketType === "spot" && apiResponse?.success;
    return {
      baseAsset: real
        ? apiResponse.baseAsset || preset.baseAsset
        : preset.baseAsset,
      quoteAsset: real
        ? apiResponse.quoteAsset || preset.quoteAsset
        : preset.quoteAsset,
      symbol: real ? apiResponse.symbol || preset.symbol : preset.symbol,
      gateCurrencyPair: preset.gateCurrencyPair,
      assetName: preset.assetName,
      assetNameCn: preset.assetNameCn,
      marketType,
      iconText: preset.iconText,
      iconImage: preset.iconImage,
      accentColor,
      holdingValueQuote: real
        ? apiResponse.holdingValueQuote || mock.holdingValueQuote
        : mock.holdingValueQuote,
      holdingValueUsd: real
        ? (apiResponse.holdingValueUsd ?? mock.holdingValueUsd)
        : mock.holdingValueUsd,
      change24hPct: real
        ? (apiResponse.change24hPct ?? null)
        : mock.change24hPct,
      change24hQuote: real
        ? (apiResponse.change24hQuote ?? null)
        : mock.change24hQuote,
      averageBuyPriceQuote: real
        ? (apiResponse.averageBuyPriceQuote ?? null)
        : mock.averageBuyPriceQuote || null,
      averageBuyPriceMethod: real
        ? apiResponse.averageBuyPriceMethod || "unknown"
        : mock.averageBuyPriceMethod,
      averageBuyPriceScope: real
        ? apiResponse.averageBuyPriceScope || "unknown"
        : "full",
      currentPriceQuote: real
        ? apiResponse.currentPriceQuote || mock.currentPriceQuote
        : mock.currentPriceQuote,
      holdingAmountBase: real
        ? apiResponse.holdingAmountBase || mock.holdingAmountBase
        : mock.holdingAmountBase,
      lastUpdatedAt: real
        ? apiResponse.lastUpdatedAt || apiResponse.asOf
        : timestampFromTime(mock.lastUpdatedAt),
      connectionStatus: real
        ? apiResponse.connectionStatus || "connected"
        : dataMode === "gate-api" && marketType !== "spot"
          ? "degraded"
          : mock.connectionStatus,
      ...visual,
    };
  }, [accentColor, apiResponse, dataMode, marketType, mock, preset, visual]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateRemoteConfig() {
      const remoteConfig = await loadRemoteSavedConfig();
      if (cancelled) return;

      if (!remoteConfig) {
        if (!savedConfig) return;
        const synced = await saveRemoteConfig(savedConfig);
        if (!cancelled) {
          setSaveStatus(
            synced
              ? "已将本地配置同步到后端长期配置"
              : "已加载本地配置，后端长期配置暂未同步"
          );
        }
        return;
      }

      const remoteSavedAt = Date.parse(remoteConfig.savedAt || "");
      const localSavedAt = Date.parse(savedConfig?.savedAt || "");
      if (!savedConfig || remoteSavedAt >= localSavedAt) {
        saveConfig(remoteConfig);
        applySavedConfig(remoteConfig);
        setSaveStatus("已加载后端长期配置");
      }
    }

    hydrateRemoteConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  function updateCurrentPairParams(
    updater: (current: TradingPairSavedPairParams) => TradingPairSavedPairParams
  ) {
    setPairParamsById((current) => {
      const activePreset = presetById(pairPreset);
      return {
        ...current,
        [pairPreset]: updater(
          current[pairPreset] || defaultPairParams(activePreset)
        ),
      };
    });
  }

  function updateCurrentMock(
    updater: (current: TradingPairMockParams) => TradingPairMockParams
  ) {
    updateCurrentPairParams((current) => ({
      ...current,
      mock: updater(current.mock),
    }));
  }

  function updateCurrentPairVisual(
    updater: (current: PairVisualParams) => PairVisualParams
  ) {
    updateCurrentPairParams((current) => ({
      ...current,
      useCustomIconCrop:
        pairPreset === "BTC_USDT" ? current.useCustomIconCrop : true,
      visual: updater(current.visual),
    }));
  }

  function resetCurrentPreset(nextPreset = preset) {
    setPairParamsById((current) => ({
      ...current,
      [nextPreset.id]: defaultPairParams(nextPreset),
    }));
    clearApiState();
    setSaveStatus("已重置当前交易对，保存后会写入长期配置");
  }

  function handlePresetChange(value: string) {
    setPairPreset(value);
    clearApiState();
    setSaveStatus(null);
  }

  async function handleSaveAllConfig() {
    const payload: TradingPairSavedConfig = {
      version: 1,
      savedAt: new Date().toISOString(),
      common: {
        dataMode,
        pairPreset,
        marketType,
        visual: commonVisual,
      },
      pairs: pairParamsById,
    };

    const localSaved = saveConfig(payload);
    if (!localSaved) {
      setSaveStatus("保存失败，浏览器存储不可用");
      return;
    }

    setSaveStatus("已保存到浏览器，正在同步后端长期配置...");
    const remoteSaved = await saveRemoteConfig(payload);
    setSaveStatus(
      remoteSaved
        ? "已保存所有通用参数、交易对分别参数和后端长期配置"
        : "已保存到浏览器，后端长期配置同步失败"
    );
  }

  async function handleResetAll() {
    setMarketType("spot");
    setDataMode("mock");
    setCommonVisual(commonVisualDefaults);
    setPairPreset("BTC_USDT");
    setPairParamsById(defaultPairParamsMap());
    clearSavedConfig();
    await clearRemoteSavedConfig();
    clearApiState();
    setSaveStatus("已重置全部参数并清除长期配置");
  }

  return (
    <section className="mt-8 rounded-[28px] border border-white/10 bg-white/[.035] p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.16)] light:border-slate-200 light:bg-white/70">
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-white light:text-slate-900">
            Trading Pair Detail Card Experiment
          </div>
          <p className="mt-1 text-xs leading-5 text-white/60 light:text-slate-500">
            通用交易对详情组件实验 · Mock / Gate API Mode · v1
            真实数据仅支持现货
          </p>
        </div>
        <div className="w-fit rounded-full bg-[#D6A84F]/10 px-3 py-1 text-xs font-bold text-[#D6A84F] shadow-[0_10px_28px_rgb(214_168_79_/_0.10)]">
          Trading Pair
        </div>
      </div>

      <div className="grid gap-5">
        <TradingPairDetailCard {...cardProps} />

        <div className="rounded-[24px] border border-white/10 bg-black/25 p-4 text-white shadow-[0_18px_48px_rgb(0_0_0_/_0.18)] light:border-slate-200 light:bg-white/80 light:text-slate-900">
          <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-sm font-bold">通用交易对调控分栏</div>
              <div className="mt-1 text-xs text-white/50 light:text-slate-500">
                只控制
                TradingPairDetailCard；组件固定在上方，下方参数每行最多三个。
              </div>
            </div>
            <div
              className={`rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-bold ${statusTone(
                apiResponse,
                apiError
              )}`}
            >
              {dataMode === "mock" ? "Mock" : "Gate API"}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <ConfigMemoryPanel
              saveStatus={saveStatus}
              onSave={handleSaveAllConfig}
            />
            <SectionLabel title="通用参数" />
            <SelectControl<TradingPairDataMode>
              label="数据模式"
              value={dataMode}
              options={["mock", "gate-api"]}
              optionLabels={{ mock: "Mock Mode", "gate-api": "Gate API Mode" }}
              onChange={setDataMode}
            />
            <SelectControl<TradingPairMarketType>
              label="市场类型"
              value={marketType}
              options={["spot", "futures", "margin"]}
              optionLabels={marketLabels}
              onChange={setMarketType}
            />
            <RangeControl
              label="卡片宽度"
              value={visual.cardWidth}
              min={420}
              max={920}
              step={1}
              suffix="px"
              onChange={(value) =>
                setCommonVisual((current) => ({ ...current, cardWidth: value }))
              }
            />
            <RangeControl
              label="卡片高度"
              value={visual.cardHeight}
              min={260}
              max={560}
              step={1}
              suffix="px"
              onChange={(value) =>
                setCommonVisual((current) => ({
                  ...current,
                  cardHeight: value,
                }))
              }
            />
            <RangeControl
              label="圆角"
              value={visual.borderRadius}
              min={16}
              max={42}
              step={1}
              suffix="px"
              onChange={(value) =>
                setCommonVisual((current) => ({
                  ...current,
                  borderRadius: value,
                }))
              }
            />
            <RangeControl
              label="发光强度"
              value={visual.glowIntensity}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) =>
                setCommonVisual((current) => ({
                  ...current,
                  glowIntensity: value,
                }))
              }
            />
            <ToggleControl
              label="显示 USD 估算"
              checked={visual.showUsdEstimate}
              onChange={(value) =>
                setCommonVisual((current) => ({
                  ...current,
                  showUsdEstimate: value,
                }))
              }
            />
            <ToggleControl
              label="显示市场标签"
              checked={visual.showMarketBadge}
              onChange={(value) =>
                setCommonVisual((current) => ({
                  ...current,
                  showMarketBadge: value,
                }))
              }
            />
            <ToggleControl
              label="显示 info 图标"
              checked={visual.showInfoIcons}
              onChange={(value) =>
                setCommonVisual((current) => ({
                  ...current,
                  showInfoIcons: value,
                }))
              }
            />
            <ToggleControl
              label="紧凑模式"
              checked={visual.compactMode}
              onChange={(value) =>
                setCommonVisual((current) => ({
                  ...current,
                  compactMode: value,
                }))
              }
            />
            <SectionLabel title="当前交易对参数" />
            <SelectControl
              label="交易对示例"
              value={pairPreset}
              options={tradingPairMockPresets.map((item) => item.id)}
              optionLabels={Object.fromEntries(
                tradingPairMockPresets.map((item) => [item.id, item.symbol])
              )}
              onChange={handlePresetChange}
            />
            <InfoPanel
              label="Gate API 状态"
              code="trading-pair/detail"
              value={apiStatusText({
                mode: dataMode,
                marketType,
                response: apiResponse,
                error: apiError,
                reconnectAttempt,
              })}
              tone={statusTone(apiResponse, apiError)}
              extra={
                dataMode === "gate-api" && apiResponse?.partialFailures?.length
                  ? `${apiResponse.partialFailures
                      .map((item) => item.source)
                      .join(", ")} 降级`
                  : null
              }
            />
            <TextControl
              label="持仓价值"
              value={mock.holdingValueQuote}
              onChange={(value) =>
                updateCurrentMock((current) => ({
                  ...current,
                  holdingValueQuote: value,
                }))
              }
            />
            <TextControl
              label="USD 估算"
              value={mock.holdingValueUsd}
              onChange={(value) =>
                updateCurrentMock((current) => ({
                  ...current,
                  holdingValueUsd: value,
                }))
              }
            />
            <TextControl
              label="24H 涨跌%"
              value={mock.change24hPct}
              onChange={(value) =>
                updateCurrentMock((current) => ({
                  ...current,
                  change24hPct: value,
                }))
              }
            />
            <TextControl
              label="24H 涨跌额"
              value={mock.change24hQuote}
              onChange={(value) =>
                updateCurrentMock((current) => ({
                  ...current,
                  change24hQuote: value,
                }))
              }
            />
            <TextControl
              label="平均买入价"
              value={mock.averageBuyPriceQuote}
              onChange={(value) =>
                updateCurrentMock((current) => ({
                  ...current,
                  averageBuyPriceQuote: value,
                }))
              }
            />
            <SelectControl<AverageBuyPriceMethod>
              label="平均价方法"
              value={mock.averageBuyPriceMethod}
              options={[
                "moving_weighted",
                "recent_weighted",
                "manual",
                "unknown",
              ]}
              optionLabels={averageMethodLabels}
              onChange={(value) =>
                updateCurrentMock((current) => ({
                  ...current,
                  averageBuyPriceMethod: value,
                }))
              }
            />
            <TextControl
              label="当前价格"
              value={mock.currentPriceQuote}
              onChange={(value) =>
                updateCurrentMock((current) => ({
                  ...current,
                  currentPriceQuote: value,
                }))
              }
            />
            <TextControl
              label="持有数量"
              value={mock.holdingAmountBase}
              onChange={(value) =>
                updateCurrentMock((current) => ({
                  ...current,
                  holdingAmountBase: value,
                }))
              }
            />
            <TextControl
              label="最后更新时间"
              value={mock.lastUpdatedAt}
              onChange={(value) =>
                updateCurrentMock((current) => ({
                  ...current,
                  lastUpdatedAt: value,
                }))
              }
            />
            <SelectControl<TradingPairConnectionStatus>
              label="连接状态"
              value={mock.connectionStatus}
              options={["connected", "degraded", "disconnected"]}
              optionLabels={statusLabels}
              onChange={(value) =>
                updateCurrentMock((current) => ({
                  ...current,
                  connectionStatus: value,
                }))
              }
            />
            <ColorControl
              label="强调色"
              value={accentColor}
              onChange={(value) =>
                updateCurrentPairParams((current) => ({
                  ...current,
                  accentColor: value,
                }))
              }
            />
            <IconCropControl
              iconImage={preset.iconImage}
              iconText={preset.iconText}
              baseAsset={preset.baseAsset}
              accentColor={accentColor}
              iconSize={visual.iconSize}
              iconCropScale={visual.iconCropScale}
              iconCropX={visual.iconCropX}
              iconCropY={visual.iconCropY}
              cropModeLabel={
                pairPreset === "BTC_USDT"
                  ? "BTC 默认裁切"
                  : isUsingBtcCropTemplate
                    ? "跟随 BTC 裁切"
                    : "单独裁切"
              }
              onIconSizeChange={(value) =>
                updateCurrentPairVisual((current) => ({
                  ...current,
                  iconSize: value,
                }))
              }
              onIconCropScaleChange={(value) =>
                updateCurrentPairVisual((current) => ({
                  ...current,
                  iconCropScale: value,
                }))
              }
              onIconCropXChange={(value) =>
                updateCurrentPairVisual((current) => ({
                  ...current,
                  iconCropX: value,
                }))
              }
              onIconCropYChange={(value) =>
                updateCurrentPairVisual((current) => ({
                  ...current,
                  iconCropY: value,
                }))
              }
            />
            <button
              type="button"
              onClick={() => resetCurrentPreset()}
              className="rounded-xl border border-white/10 bg-white/[.035] px-4 py-3 text-sm font-bold text-white transition hover:border-[#D6A84F]/40 light:border-slate-200 light:bg-white light:text-slate-900"
            >
              重置当前交易对
            </button>
            <button
              type="button"
              onClick={handleResetAll}
              className="rounded-xl border border-[#D6A84F]/25 bg-[#D6A84F]/10 px-4 py-3 text-sm font-bold text-[#D6A84F] transition hover:bg-[#D6A84F]/15"
            >
              重置全部参数
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ConfigMemoryPanel({
  saveStatus,
  onSave,
}: {
  saveStatus: string | null;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#D6A84F]/20 bg-[#D6A84F]/10 p-3 md:col-span-3 light:bg-[#D6A84F]/10">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-bold text-[#D6A84F]">配置记忆</div>
          <div className="mt-1 flex flex-wrap gap-2 text-[11px] font-bold">
            <span className="rounded-full bg-black/20 px-2 py-1 text-white/70 light:bg-white/70 light:text-slate-700">
              通用参数
            </span>
            <span className="rounded-full bg-black/20 px-2 py-1 text-white/70 light:bg-white/70 light:text-slate-700">
              交易对分别参数
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onSave}
          className="rounded-xl border border-[#D6A84F]/30 bg-[#D6A84F]/20 px-4 py-3 text-sm font-black text-[#F4B23E] transition hover:bg-[#D6A84F]/25 light:text-[#B7791F]"
        >
          保存所有配置
        </button>
      </div>
      {saveStatus ? (
        <div className="text-[11px] font-semibold text-white/60 light:text-slate-600">
          {saveStatus}
        </div>
      ) : null}
    </div>
  );
}

function SectionLabel({ title }: { title: string }) {
  return (
    <div className="mt-1 border-t border-white/10 pt-3 text-xs font-black text-white/60 md:col-span-3 light:border-slate-200 light:text-slate-500">
      {title}
    </div>
  );
}

function IconCropControl({
  iconImage,
  iconText,
  baseAsset,
  accentColor,
  iconSize,
  iconCropScale,
  iconCropX,
  iconCropY,
  cropModeLabel,
  onIconSizeChange,
  onIconCropScaleChange,
  onIconCropXChange,
  onIconCropYChange,
}: {
  iconImage?: string;
  iconText?: string;
  baseAsset: string;
  accentColor: string;
  iconSize: number;
  iconCropScale: number;
  iconCropX: number;
  iconCropY: number;
  cropModeLabel: string;
  onIconSizeChange: (value: number) => void;
  onIconCropScaleChange: (value: number) => void;
  onIconCropXChange: (value: number) => void;
  onIconCropYChange: (value: number) => void;
}) {
  const previewSize = Math.max(44, Math.min(iconSize, 112));

  return (
    <div className="grid gap-4 rounded-xl border border-white/10 bg-white/[.035] p-4 md:col-span-3 light:border-slate-200 light:bg-white">
      <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-xs font-bold text-white/80 light:text-slate-800">
            图标裁切 / Icon Crop
          </div>
          <div className="mt-1 text-[11px] font-semibold text-white/45 light:text-slate-500">
            圆形预览只影响卡片内 PNG 显示，不生成新图片文件。
          </div>
        </div>
        <div className="w-fit rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-bold text-[#D6A84F]">
          {iconImage ? cropModeLabel : "Fallback Icon"}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[180px_minmax(0,1fr)]">
        <div className="flex min-h-[150px] items-center justify-center rounded-xl border border-white/10 bg-black/25 light:border-slate-200 light:bg-slate-50">
          <div
            className="relative shrink-0 overflow-hidden rounded-full border bg-black/35"
            style={{
              width: `${previewSize}px`,
              height: `${previewSize}px`,
              borderColor: accentColor,
              boxShadow: `0 0 34px ${accentColor}33`,
            }}
          >
            {iconImage ? (
              <img
                src={iconImage}
                alt={baseAsset}
                className="h-full w-full object-cover"
                style={iconCropStyle({
                  iconCropScale,
                  iconCropX,
                  iconCropY,
                })}
              />
            ) : (
              <div
                className="flex h-full w-full items-center justify-center text-sm font-black text-black"
                style={{ backgroundColor: accentColor }}
              >
                {iconText || baseAsset.slice(0, 1)}
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          <RangeControl
            label="图标大小"
            value={iconSize}
            min={32}
            max={104}
            step={1}
            suffix="px"
            onChange={onIconSizeChange}
          />
          <RangeControl
            label="裁切缩放"
            value={iconCropScale}
            min={0.7}
            max={2.2}
            step={0.01}
            onChange={onIconCropScaleChange}
          />
          <RangeControl
            label="水平裁切"
            value={iconCropX}
            min={-40}
            max={40}
            step={1}
            suffix="px"
            onChange={onIconCropXChange}
          />
          <RangeControl
            label="垂直裁切"
            value={iconCropY}
            min={-40}
            max={40}
            step={1}
            suffix="px"
            onChange={onIconCropYChange}
          />
        </div>
      </div>
    </div>
  );
}

function InfoPanel({
  label,
  code,
  value,
  tone,
  extra,
}: {
  label: string;
  code: string;
  value: string;
  tone: string;
  extra?: string | null;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[.035] p-3 text-xs font-semibold light:border-slate-200 light:bg-white">
      <div className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <span className="font-mono text-[10px] text-white/35 light:text-slate-400">
          {code}
        </span>
      </div>
      <div className={`mt-2 ${tone}`}>{value}</div>
      {extra ? (
        <div className="mt-2 text-[11px] text-[#D6A84F]">{extra}</div>
      ) : null}
    </div>
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

function ColorControl({
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
      <div className="grid grid-cols-[44px_1fr] gap-2">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-11 rounded-lg border border-white/10 bg-black/30 p-1"
        />
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 rounded-lg border border-white/10 bg-black/30 px-3 text-sm font-semibold text-white outline-none focus:border-[#D6A84F] light:border-slate-200 light:bg-white light:text-slate-900"
        />
      </div>
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
      <div className="grid grid-cols-[minmax(0,1fr)_64px] gap-2">
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
          className="h-8 min-w-0 rounded-lg border border-white/10 bg-black/30 px-2 text-xs font-semibold text-white outline-none focus:border-[#D6A84F] light:border-slate-200 light:bg-white light:text-slate-900"
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
