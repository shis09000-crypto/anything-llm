import React from "react";
import {
  ArrowDown,
  ArrowUp,
  ChartLineUp,
  Clock,
  Info,
  Target,
  Wallet,
} from "@phosphor-icons/react";
import type {
  AverageBuyPriceMethod,
  TradingPairConnectionStatus,
  TradingPairDetailCardProps,
  TradingPairMarketType,
} from "./tradingPairDetailTypes";
import { useCryptoStatusLabel } from "./cryptoStatusI18n";

const statusMeta: Record<
  TradingPairConnectionStatus,
  { color: string; bg: string }
> = {
  connected: { color: "#22C55E", bg: "rgba(34,197,94,.10)" },
  degraded: { color: "#F4B23E", bg: "rgba(244,178,62,.10)" },
  disconnected: {
    color: "#EF4444",
    bg: "rgba(239,68,68,.10)",
  },
};

const marketLabels: Record<TradingPairMarketType, string> = {
  spot: "现货",
  futures: "合约",
  margin: "杠杆",
};

const averageHelper: Record<AverageBuyPriceMethod, string> = {
  moving_weighted: "移动加权估算",
  recent_weighted: "最近成交估算",
  manual: "手动录入",
  unknown: "暂无可靠成交历史",
};

function numeric(value: string | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(
  value: string | null | undefined,
  { decimals = 2, fallback = "--" } = {}
) {
  const number = numeric(value);
  if (number === null) return fallback;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(number);
}

function formatFlexible(value: string | null | undefined, fallback = "--") {
  const number = numeric(value);
  if (number === null) return fallback;
  const abs = Math.abs(number);
  const decimals = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(number);
}

function moneyPrefix(quoteAsset: string) {
  return quoteAsset === "USDT" || quoteAsset === "USD" ? "$" : "";
}

function formatQuoteMoney(
  value: string | null | undefined,
  quoteAsset: string,
  { decimals = 2, fallback = "--" } = {}
) {
  const formatted = formatNumber(value, { decimals, fallback });
  if (formatted === fallback) return fallback;
  return `${moneyPrefix(quoteAsset)}${formatted}`;
}

function formatFlexibleQuoteMoney(
  value: string | null | undefined,
  quoteAsset: string,
  fallback = "--"
) {
  const formatted = formatFlexible(value, fallback);
  if (formatted === fallback) return fallback;
  return `${moneyPrefix(quoteAsset)}${formatted}`;
}

function formatSignedQuoteMoney(
  value: string | null | undefined,
  quoteAsset: string
) {
  const number = numeric(value);
  if (number === null) return "--";
  const sign = number >= 0 ? "+" : "-";
  return `${sign}${moneyPrefix(quoteAsset)}${formatFlexible(
    String(Math.abs(number))
  )} ${quoteAsset}`;
}

function formatPct(value: string | null | undefined) {
  const number = numeric(value);
  if (number === null) return "--";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatTime(ts: number | null) {
  if (!ts) return "--:--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

function readableColor(hex = "#F4B23E", opacity = 1) {
  const normalized = hex.replace("#", "");
  if (!/^[0-9A-Fa-f]{6}$/.test(normalized)) {
    return `rgba(244,178,62,${opacity})`;
  }
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

function DetailRow({
  icon,
  label,
  helper,
  value,
  accentColor,
  compact,
}: {
  icon: React.ReactNode;
  label: string;
  helper?: string;
  value: string;
  accentColor: string;
  compact: boolean;
}) {
  return (
    <div
      className={[
        "grid grid-cols-[36px_minmax(0,1fr)_minmax(96px,auto)] items-center gap-3 border-t border-white/10",
        compact ? "py-3" : "py-5",
      ].join(" ")}
    >
      <div
        className="flex h-9 w-9 items-center justify-center rounded-full border"
        style={{
          borderColor: readableColor(accentColor, 0.35),
          color: accentColor,
          backgroundColor: readableColor(accentColor, 0.08),
        }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div
          className={[
            "truncate font-semibold text-[#D4D4D8]",
            compact ? "text-sm" : "text-xl",
          ].join(" ")}
        >
          {label}
        </div>
        {helper ? (
          <div
            className={[
              "mt-1 truncate font-medium text-[#71717A]",
              compact ? "text-xs" : "text-base",
            ].join(" ")}
          >
            {helper}
          </div>
        ) : null}
      </div>
      <div
        className={[
          "min-w-0 truncate text-right font-mono font-black text-[#F8FAFC]",
          compact ? "text-xl" : "text-3xl",
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}

function CoinIcon({
  baseAsset,
  iconText,
  iconImage,
  iconSize,
  iconCropScale,
  iconCropX,
  iconCropY,
  accentColor,
  compact,
}: {
  baseAsset: string;
  iconText?: string;
  iconImage?: string;
  iconSize: number;
  iconCropScale: number;
  iconCropX: number;
  iconCropY: number;
  accentColor: string;
  compact: boolean;
}) {
  if (iconImage) {
    const size = Math.max(28, Math.min(iconSize, 112));
    const scale = Math.max(0.6, Math.min(iconCropScale, 2.4));

    return (
      <div
        className="relative shrink-0 overflow-hidden rounded-full border bg-black/35"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderColor: readableColor(accentColor, 0.42),
          boxShadow: `0 0 ${compact ? 24 : 38}px ${readableColor(
            accentColor,
            0.22
          )}, inset 0 1px 0 rgba(255,255,255,.12)`,
        }}
      >
        <img
          src={iconImage}
          alt={baseAsset}
          className="h-full w-full object-cover"
          style={{
            transform: `translate(${iconCropX}px, ${iconCropY}px) scale(${scale})`,
            transformOrigin: "center",
          }}
        />
      </div>
    );
  }

  const asset = baseAsset.toUpperCase();
  const isBtc = asset === "BTC";
  const isEth = asset === "ETH";
  const fallbackCoinGradient = `radial-gradient(circle at 35% 30%, ${readableColor(
    accentColor,
    1
  )}, ${readableColor(accentColor, 0.68)} 64%, rgba(0,0,0,.2))`;
  const coinBackground = (() => {
    if (isBtc)
      return "radial-gradient(circle at 34% 28%, #ffe48d 0%, #ffb21a 30%, #ff8b00 68%, #7a3f00 100%)";
    if (isEth)
      return "radial-gradient(circle at 34% 28%, #f7fbff 0%, #93c5fd 30%, #60a5fa 68%, #1e3a8a 100%)";
    return fallbackCoinGradient;
  })();
  const coinShadow = (() => {
    if (isBtc)
      return "0 0 42px rgba(255,184,38,.34), 0 0 86px rgba(255,156,12,.16), inset 0 2px 8px rgba(255,255,255,.34), inset 0 -12px 22px rgba(89,43,0,.32)";
    if (isEth)
      return "0 0 42px rgba(147,197,253,.34), 0 0 92px rgba(96,165,250,.18), inset 0 2px 9px rgba(255,255,255,.46), inset 0 -12px 24px rgba(30,58,138,.28)";
    return `0 0 38px ${readableColor(accentColor, 0.24)}`;
  })();
  const coinColor = isBtc ? "rgba(70,38,0,.78)" : "#fff";

  return (
    <div
      className={[
        "relative flex shrink-0 items-center justify-center rounded-full border font-black",
        compact ? "h-14 w-14 text-3xl" : "h-20 w-20 text-5xl",
      ].join(" ")}
      style={{
        borderColor: readableColor(accentColor, 0.42),
        background: coinBackground,
        boxShadow: coinShadow,
        color: coinColor,
      }}
    >
      {isBtc ? (
        <>
          <span className="absolute inset-[7px] rounded-full border border-[#733800]/45" />
          <span className="absolute inset-[2px] rounded-full border border-[#ffdd74]/50" />
          <span className="-rotate-6 drop-shadow-[0_1px_0_rgba(255,238,172,.34)]">
            ₿
          </span>
        </>
      ) : isEth ? (
        <>
          <span className="absolute inset-[7px] rounded-full border border-[#1d4ed8]/65" />
          <span className="absolute inset-[2px] rounded-full border border-white/70" />
          <svg
            viewBox="0 0 64 64"
            className={compact ? "h-9 w-9" : "h-12 w-12"}
            aria-hidden="true"
          >
            <polygon
              points="32,4 14,32 32,24"
              fill="rgba(248,250,252,.86)"
              stroke="rgba(15,23,42,.25)"
              strokeWidth="1"
            />
            <polygon
              points="32,4 50,32 32,24"
              fill="rgba(71,85,105,.86)"
              stroke="rgba(15,23,42,.25)"
              strokeWidth="1"
            />
            <polygon points="14,36 32,46 32,28" fill="rgba(148,163,184,.92)" />
            <polygon points="50,36 32,46 32,28" fill="rgba(15,23,42,.92)" />
            <polygon points="16,40 32,62 32,50" fill="rgba(226,232,240,.88)" />
            <polygon points="48,40 32,62 32,50" fill="rgba(71,85,105,.88)" />
          </svg>
        </>
      ) : (
        iconText || baseAsset.slice(0, 1)
      )}
    </div>
  );
}

export default function TradingPairDetailCard({
  baseAsset,
  quoteAsset,
  symbol,
  assetName,
  assetNameCn,
  marketType,
  iconText,
  iconImage,
  iconSize,
  iconCropScale,
  iconCropX,
  iconCropY,
  accentColor = "#F4B23E",
  holdingValueQuote,
  holdingValueUsd,
  change24hPct,
  change24hQuote,
  averageBuyPriceQuote,
  averageBuyPriceMethod,
  averageBuyPriceScope,
  currentPriceQuote,
  holdingAmountBase,
  lastUpdatedAt,
  connectionStatus,
  showUsdEstimate,
  showMarketBadge,
  showInfoIcons,
  compactMode,
  cardWidth,
  cardHeight,
  borderRadius,
  glowIntensity,
}: TradingPairDetailCardProps) {
  const status = statusMeta[connectionStatus];
  const statusLabel = useCryptoStatusLabel(connectionStatus);
  const positive = (numeric(change24hPct) || 0) >= 0;
  const isCompact = compactMode || cardHeight < 390 || cardWidth < 760;
  const valueDecimals = quoteAsset === "USDT" || quoteAsset === "USD" ? 2 : 4;
  const averageIsCalculating = averageBuyPriceScope === "calculating";

  return (
    <section
      className="relative isolate max-w-full overflow-hidden border text-[#F8FAFC]"
      style={{
        width: `${cardWidth}px`,
        height: `${cardHeight}px`,
        borderRadius,
        borderColor: readableColor(accentColor, 0.18),
        background:
          "radial-gradient(circle at 18% 8%, rgba(244,178,62,.12), transparent 28%), linear-gradient(135deg, #050505 0%, #08090B 54%, #050505 100%)",
        boxShadow: `0 24px ${44 + glowIntensity * 52}px rgba(0,0,0,.48), 0 0 ${glowIntensity * 56}px ${readableColor(accentColor, 0.08)}, inset 0 1px 0 rgba(255,255,255,.06)`,
      }}
    >
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_72%_4%,rgba(255,255,255,.05),transparent_34%)]" />
      <div
        className={[
          "grid h-full overflow-hidden",
          isCompact ? "gap-4 p-5" : "gap-7 p-7 md:p-8",
        ].join(" ")}
      >
        <header className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <CoinIcon
              baseAsset={baseAsset}
              iconText={iconText}
              iconImage={iconImage}
              iconSize={iconSize}
              iconCropScale={iconCropScale}
              iconCropX={iconCropX}
              iconCropY={iconCropY}
              accentColor={accentColor}
              compact={isCompact}
            />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <h2
                  className={[
                    "truncate font-black leading-tight tracking-normal text-[#F8FAFC]",
                    isCompact ? "text-3xl" : "text-5xl",
                  ].join(" ")}
                >
                  {symbol}
                </h2>
                {showMarketBadge ? (
                  <span
                    className="rounded-full border px-3 py-1 text-sm font-bold"
                    style={{
                      borderColor: readableColor(accentColor, 0.24),
                      color: accentColor,
                      backgroundColor: readableColor(accentColor, 0.1),
                    }}
                  >
                    {marketLabels[marketType]}
                  </span>
                ) : null}
              </div>
              <p
                className={[
                  "mt-1 font-semibold text-[#A1A1AA]",
                  isCompact ? "text-base" : "text-2xl",
                ].join(" ")}
              >
                {assetName}
                {assetNameCn ? ` / ${assetNameCn}` : ""}
              </p>
            </div>
          </div>

          <div
            className="flex w-fit items-center gap-2 rounded-full px-3 py-2 text-sm font-bold"
            style={{ color: status.color, backgroundColor: status.bg }}
          >
            <span
              className="h-2.5 w-2.5 rounded-full shadow-[0_0_16px_currentColor]"
              style={{ backgroundColor: status.color }}
            />
            {statusLabel}
          </div>
        </header>

        <div
          className={[
            "grid md:items-center",
            isCompact
              ? "gap-4 md:grid-cols-[minmax(0,1fr)_minmax(200px,.72fr)]"
              : "gap-8 md:grid-cols-[minmax(0,1.35fr)_minmax(280px,.8fr)]",
          ].join(" ")}
        >
          <div>
            <div
              className={[
                "flex items-center gap-2 font-semibold text-[#A1A1AA]",
                isCompact ? "text-base" : "text-2xl",
              ].join(" ")}
            >
              持仓价值 ({quoteAsset})
              {showInfoIcons ? (
                <Info size={20} className="text-[#71717A]" />
              ) : null}
            </div>
            <div
              className={[
                "mt-4 truncate font-mono font-black leading-none",
                isCompact ? "text-4xl" : "text-7xl",
              ].join(" ")}
              style={{
                color: accentColor,
                textShadow: `0 0 ${18 + glowIntensity * 18}px ${readableColor(
                  accentColor,
                  0.18
                )}`,
              }}
            >
              {formatQuoteMoney(holdingValueQuote, quoteAsset, {
                decimals: valueDecimals,
              })}
            </div>
            <div
              className={[
                "mt-2 font-semibold text-[#A1A1AA]",
                isCompact ? "text-base" : "text-2xl",
              ].join(" ")}
            >
              {showUsdEstimate && holdingValueUsd
                ? `≈ ${formatQuoteMoney(holdingValueUsd, "USD")} USD`
                : "\u00A0"}
            </div>
          </div>

          <div className="border-white/15 md:border-l md:pl-6">
            <div
              className={[
                "font-semibold text-[#A1A1AA]",
                isCompact ? "text-base" : "text-2xl",
              ].join(" ")}
            >
              24H 涨跌
            </div>
            <div
              className={[
                "mt-3 flex items-center gap-3 font-mono font-black",
                positive ? "text-[#22C55E]" : "text-[#EF4444]",
                isCompact ? "text-4xl" : "text-6xl",
              ].join(" ")}
            >
              {positive ? (
                <ArrowUp size={isCompact ? 32 : 48} weight="bold" />
              ) : (
                <ArrowDown size={isCompact ? 32 : 48} weight="bold" />
              )}
              {formatPct(change24hPct)}
            </div>
            <div
              className={[
                "mt-2 font-mono font-bold",
                positive ? "text-[#22C55E]" : "text-[#EF4444]",
                isCompact ? "text-lg" : "text-2xl",
              ].join(" ")}
            >
              {formatSignedQuoteMoney(change24hQuote, quoteAsset)}
            </div>
          </div>
        </div>

        <div>
          <DetailRow
            icon={<Target size={isCompact ? 20 : 26} weight="bold" />}
            label={`平均买入价 (${quoteAsset})`}
            helper={
              averageIsCalculating
                ? "正在计算成交历史"
                : averageBuyPriceQuote
                  ? averageHelper[averageBuyPriceMethod]
                  : "暂无可靠成交历史"
            }
            value={
              averageIsCalculating
                ? "计算中"
                : averageBuyPriceQuote
                  ? formatFlexibleQuoteMoney(averageBuyPriceQuote, quoteAsset)
                  : "待统计"
            }
            accentColor={accentColor}
            compact={isCompact}
          />
          <DetailRow
            icon={<ChartLineUp size={isCompact ? 20 : 26} weight="bold" />}
            label={`当前价格 (${quoteAsset})`}
            value={formatFlexibleQuoteMoney(currentPriceQuote, quoteAsset)}
            accentColor={accentColor}
            compact={isCompact}
          />
          <DetailRow
            icon={<Wallet size={isCompact ? 20 : 26} weight="bold" />}
            label={`持有数量 (${baseAsset})`}
            value={`${formatFlexible(holdingAmountBase)} ${baseAsset}`}
            accentColor={accentColor}
            compact={isCompact}
          />
        </div>

        <footer
          className={[
            "flex items-center gap-3 border-t border-white/10 font-semibold text-[#A1A1AA]",
            isCompact ? "pt-3 text-base" : "pt-5 text-xl",
          ].join(" ")}
        >
          <Clock size={isCompact ? 20 : 28} />
          <span>最后更新</span>
          <span className="font-mono">{formatTime(lastUpdatedAt)}</span>
        </footer>
      </div>
    </section>
  );
}
