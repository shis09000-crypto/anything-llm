import React, { useMemo } from "react";
import {
  ArrowClockwise,
  ArrowsOut,
  ChartLineUp,
  Clock,
  Coins,
  CurrencyBtc,
  Info,
  TrendUp,
} from "@phosphor-icons/react";
import type {
  BtcCardMode,
  BtcCandlePoint,
  BtcChartRange,
  BtcConnectionStatus,
  BtcSpotAssetCardProps,
} from "./btcSpotAssetTypes";

const statusMeta: Record<
  BtcConnectionStatus,
  { label: string; dot: string; text: string; bg: string }
> = {
  connected: {
    label: "Live",
    dot: "#22C55E",
    text: "text-[#4ADE80]",
    bg: "bg-[#22C55E]/10",
  },
  degraded: {
    label: "Degraded",
    dot: "#F5C451",
    text: "text-[#F5C451]",
    bg: "bg-[#F5C451]/10",
  },
  disconnected: {
    label: "Offline",
    dot: "#EF4444",
    text: "text-[#FCA5A5]",
    bg: "bg-[#EF4444]/10",
  },
};

function numeric(value: string | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatUsd(value: string | null | undefined, fallback = "--") {
  const number = numeric(value);
  if (number === null) return fallback;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function formatBtc(value: string | null | undefined) {
  const number = numeric(value);
  if (number === null) return "--";
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8,
  }).format(number)} BTC`;
}

function formatPct(value: string | null | undefined) {
  const number = numeric(value);
  if (number === null) return "--";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatSignedUsd(value: string | null | undefined) {
  const number = numeric(value);
  if (number === null) return "--";
  return `${number >= 0 ? "+" : "-"}${formatUsd(String(Math.abs(number)))}`;
}

function formatTime(ts: number | null) {
  if (!ts) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

function formatCnyEstimate(value: string | null | undefined) {
  const number = numeric(value);
  if (number === null) return "--";
  return `≈ ${new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number * 7.2)} CNY`;
}

function chartGeometry(candles: BtcCandlePoint[], mode: BtcCardMode) {
  const width = 860;
  const height = 430;
  const volumeHeight = 68;
  const padding = { top: 34, right: 82, bottom: 44, left: 64 };
  const priceHeight = height - padding.top - padding.bottom - volumeHeight - 12;
  const values = candles.flatMap((candle) => [
    Number(candle.high),
    Number(candle.low),
  ]);
  const volumes = candles.map((candle) => Number(candle.volume || 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, 1);
  const useReferenceScale = mode === "mock" && min >= 90_000 && max <= 110_000;
  const yMin = useReferenceScale ? 95_000 : min - spread * 0.08;
  const yMax = useReferenceScale ? 107_000 : max + spread * 0.08;
  const plotWidth = width - padding.left - padding.right;
  const candleStep = candles.length ? plotWidth / candles.length : plotWidth;
  const bodyWidth = Math.max(4, Math.min(12, candleStep * 0.56));
  const maxVolume = Math.max(...volumes, 1);

  function priceY(value: number) {
    return padding.top + ((yMax - value) / (yMax - yMin)) * priceHeight;
  }

  const points = candles.map((candle, index) => {
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume || 0);
    const x = padding.left + index * candleStep + candleStep / 2;
    const bodyTop = priceY(Math.max(open, close));
    const bodyBottom = priceY(Math.min(open, close));
    const volumeTop =
      height -
      padding.bottom -
      (Math.max(0, volume) / maxVolume) * volumeHeight;

    return {
      candle,
      x,
      open,
      high,
      low,
      close,
      up: close >= open,
      wickTop: priceY(high),
      wickBottom: priceY(low),
      bodyTop,
      bodyHeight: Math.max(2, bodyBottom - bodyTop),
      volumeTop,
      volumeHeight: height - padding.bottom - volumeTop,
    };
  });

  return {
    width,
    height,
    padding,
    priceHeight,
    volumeHeight,
    yMin,
    yMax,
    priceY,
    bodyWidth,
    useReferenceScale,
    points,
  };
}

function MetricRow({
  icon,
  label,
  value,
  subValue,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
  tone?: "neutral" | "positive" | "negative" | "gold";
}) {
  const toneClass =
    tone === "positive"
      ? "text-[#4ADE80]"
      : tone === "negative"
        ? "text-[#FCA5A5]"
        : tone === "gold"
          ? "text-[#F5C451]"
          : "text-[#F8FAFC]";

  return (
    <div className="flex items-center justify-between gap-5 border-t border-[#D6A84F]/20 py-4 first:border-t-0">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#D6A84F]/35 bg-[#D6A84F]/10 text-[#F5C451]">
          {icon}
        </div>
        <div className="min-w-0 text-base font-semibold text-[#E5E7EB]">
          {label}
        </div>
      </div>
      <div className="min-w-0 text-right">
        <div
          className={`truncate font-mono text-xl font-black leading-6 ${toneClass}`}
        >
          {value}
        </div>
        {subValue ? (
          <div className="mt-1 truncate text-sm font-semibold text-[#9CA3AF]">
            {subValue}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BtcCandleChart({
  mode,
  candles,
  currentPriceUsd,
  change24hPct,
  connectionStatus,
  range,
  showVolume,
  showAutoRefreshBadge,
  autoRefreshSeconds,
}: {
  mode: BtcCardMode;
  candles: BtcCandlePoint[];
  currentPriceUsd: string;
  change24hPct: string | null;
  connectionStatus: BtcConnectionStatus;
  range: BtcChartRange;
  showVolume: boolean;
  showAutoRefreshBadge: boolean;
  autoRefreshSeconds: number;
}) {
  const status = statusMeta[connectionStatus];
  const validCandles = candles.filter(
    (candle) =>
      Number(candle.open) > 0 &&
      Number(candle.high) > 0 &&
      Number(candle.low) > 0 &&
      Number(candle.close) > 0
  );
  const chart = useMemo(
    () => chartGeometry(validCandles, mode),
    [mode, validCandles]
  );
  const lastPoint = chart.points[chart.points.length - 1] || null;
  const priceY = lastPoint ? chart.priceY(lastPoint.close) : null;
  const currentPrice = numeric(currentPriceUsd);
  const currentPriceY = currentPrice ? chart.priceY(currentPrice) : priceY;
  const yTicks = chart.useReferenceScale
    ? [107_000, 105_000, 103_000, 101_000, 99_000, 97_000, 95_000]
    : Array.from({ length: 7 }).map((_, index) => {
        const ratio = index / 6;
        return chart.yMax - (chart.yMax - chart.yMin) * ratio;
      });
  const timeLabels = [
    "08:00",
    "10:00",
    "12:00",
    "14:00",
    "16:00",
    "18:00",
    "20:00",
    "22:00",
    "00:00",
    "02:00",
    "04:00",
    "06:00",
    "08:00",
  ];

  if (!validCandles.length) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center rounded-[24px] border border-[#D6A84F]/25 bg-black/30 text-sm font-bold text-[#9CA3AF]">
        K线数据加载中
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-[26px] border border-[#D6A84F]/30 bg-black/35 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,.06)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#D6A84F]/25 bg-[#D6A84F]/10 text-[#F5C451]">
            <ChartLineUp size={22} weight="bold" />
          </div>
          <div>
            <div className="text-xl font-bold text-[#F8FAFC]">BTC 价格趋势</div>
            <div className="mt-1 text-xs font-semibold text-[#9CA3AF]">
              BTC_USDT · 1D
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-3 text-right">
          <div className="flex flex-wrap justify-end gap-2">
            <span
              className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold ${status.bg} ${status.text}`}
            >
              <span
                className="h-2 w-2 rounded-full shadow-[0_0_16px_currentColor]"
                style={{ backgroundColor: status.dot }}
              />
              {status.label}
            </span>
            {showAutoRefreshBadge ? (
              <span className="inline-flex items-center gap-2 rounded-xl border border-[#D6A84F]/20 bg-[#D6A84F]/10 px-4 py-2 text-sm font-bold text-[#F5C451]">
                <ArrowClockwise size={18} weight="bold" />
                {autoRefreshSeconds}s 自动刷新
              </span>
            ) : null}
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-xl font-semibold text-[#A1A1AA]">
              24H 涨跌
            </span>
            <span
              className={[
                "font-mono text-xl font-bold",
                Number(change24hPct) >= 0 ? "text-[#22C55E]" : "text-[#EF4444]",
              ].join(" ")}
            >
              {formatPct(change24hPct)}
            </span>
          </div>
        </div>
      </div>

      <div className="mb-3 font-mono text-5xl font-black text-[#F5C451]">
        {formatUsd(currentPriceUsd)}
      </div>

      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className="min-h-0 flex-1 overflow-visible"
        role="img"
        aria-label="BTC 1D K线图"
      >
        <defs>
          <linearGradient id="btcGridFade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="rgba(214,168,79,.10)" />
            <stop offset="55%" stopColor="rgba(255,255,255,.045)" />
            <stop offset="100%" stopColor="rgba(214,168,79,.08)" />
          </linearGradient>
        </defs>
        {Array.from({ length: 13 }).map((_, index) => {
          const x =
            chart.padding.left +
            ((chart.width - chart.padding.left - chart.padding.right) / 12) *
              index;
          return (
            <line
              key={`v-${index}`}
              x1={x}
              x2={x}
              y1={chart.padding.top}
              y2={chart.height - chart.padding.bottom}
              stroke="rgba(255,255,255,.045)"
            />
          );
        })}
        {yTicks.map((tick) => {
          const y = chart.priceY(tick);
          return (
            <g key={tick}>
              <line
                x1={chart.padding.left}
                x2={chart.width - chart.padding.right}
                y1={y}
                y2={y}
                stroke="url(#btcGridFade)"
                strokeDasharray="6 7"
              />
              <text
                x={chart.width - chart.padding.right + 16}
                y={y + 4}
                textAnchor="start"
                fill="#9CA3AF"
                fontSize="12"
                fontWeight="700"
              >
                {Math.round(tick).toLocaleString("en-US")}
              </text>
            </g>
          );
        })}

        {chart.points.map((point) => {
          const color = point.up ? "#22C55E" : "#EF4444";
          return (
            <g key={point.candle.ts}>
              <line
                x1={point.x}
                x2={point.x}
                y1={point.wickTop}
                y2={point.wickBottom}
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
              />
              <rect
                x={point.x - chart.bodyWidth / 2}
                y={point.bodyTop}
                width={chart.bodyWidth}
                height={point.bodyHeight}
                rx="2"
                fill={color}
                opacity="0.92"
              />
              {showVolume && (
                <rect
                  x={point.x - chart.bodyWidth / 2}
                  y={point.volumeTop}
                  width={chart.bodyWidth}
                  height={point.volumeHeight}
                  rx="2"
                  fill={color}
                  opacity="0.22"
                />
              )}
            </g>
          );
        })}

        {currentPriceY !== null && lastPoint && (
          <g>
            <line
              x1={chart.padding.left}
              x2={chart.width - chart.padding.right + 8}
              y1={currentPriceY}
              y2={currentPriceY}
              stroke="#D6A84F"
              strokeDasharray="4 5"
              opacity="0.55"
            />
            <rect
              x={chart.width - chart.padding.right + 10}
              y={currentPriceY - 13}
              width="92"
              height="26"
              rx="8"
              fill="rgba(8,9,11,.86)"
              stroke="rgba(214,168,79,.82)"
            />
            <text
              x={chart.width - chart.padding.right + 56}
              y={currentPriceY + 5}
              textAnchor="middle"
              fill="#F5C451"
              fontSize="12"
              fontWeight="800"
            >
              {formatUsd(currentPriceUsd).replace("$", "")}
            </text>
          </g>
        )}

        {timeLabels.map((label, index) => {
          const x =
            chart.padding.left +
            ((chart.width - chart.padding.left - chart.padding.right) / 12) *
              index;
          return (
            <text
              key={`${label}-${index}`}
              x={x}
              y={chart.height - 8}
              textAnchor={
                index === 0
                  ? "start"
                  : index === timeLabels.length - 1
                    ? "end"
                    : "middle"
              }
              fill="#9CA3AF"
              fontSize="12"
              fontWeight="700"
            >
              {label}
            </text>
          );
        })}
      </svg>

      <div className="mt-4 grid grid-cols-[1fr_auto] gap-4">
        <div className="grid grid-cols-5 gap-2 rounded-2xl border border-white/10 bg-black/25 p-2">
          {(["1d", "7d", "30d", "90d", "1y"] as const).map((item) => (
            <span
              key={item}
              className={[
                "rounded-xl px-4 py-3 text-center text-lg font-bold",
                item === range
                  ? "bg-[#D6A84F]/30 text-[#FFE08A] shadow-[0_0_22px_rgba(214,168,79,.18)]"
                  : "text-[#9CA3AF]",
              ].join(" ")}
            >
              {item.toUpperCase()}
            </span>
          ))}
        </div>
        <div className="flex h-full min-w-[56px] items-center justify-center rounded-2xl border border-white/10 bg-black/25 text-[#9CA3AF]">
          <ArrowsOut size={24} />
        </div>
      </div>
    </div>
  );
}

export default function BtcSpotAssetCard({
  mode,
  totalValueUsd,
  btcAmount,
  averageBuyPriceUsd,
  averageBuyPriceScope,
  currentPriceUsd,
  change24hPct,
  change24hUsd,
  lastUpdatedAt,
  connectionStatus,
  range,
  candles,
  backgroundMode,
  backgroundImage,
  cardHeight,
  borderRadius,
  glowIntensity,
  showVolume,
  showCnyEstimate,
  showAutoRefreshBadge,
  autoRefreshSeconds,
  compactMode,
}: BtcSpotAssetCardProps) {
  const isPositive = Number(change24hPct) >= 0;
  const isSlim = compactMode || cardHeight < 500;
  const background =
    backgroundMode === "image" && backgroundImage
      ? `linear-gradient(115deg, rgba(8,9,11,.94), rgba(10,8,4,.84)), url("${backgroundImage}") center/cover`
      : backgroundMode === "gradient"
        ? "radial-gradient(circle at 27% 32%, rgba(214,168,79,.28) 0%, rgba(214,168,79,.11) 24%, rgba(214,168,79,0) 50%), radial-gradient(ellipse at 15% 76%, rgba(214,168,79,.18) 0%, rgba(214,168,79,.05) 42%, rgba(214,168,79,0) 72%), linear-gradient(135deg, #090907 0%, #10100D 34%, #08090B 72%, #050608 100%)"
        : "linear-gradient(135deg, #08090B 0%, #0B0D12 100%)";

  return (
    <section
      className="relative isolate w-full overflow-hidden border border-[#D6A84F]/30 text-[#F8FAFC] backdrop-blur-xl max-lg:min-h-[var(--btc-card-height)] lg:h-[var(--btc-card-height)]"
      style={
        {
          "--btc-card-height": `${cardHeight}px`,
          borderRadius: `${borderRadius}px`,
          background,
          boxShadow: `0 24px ${48 + glowIntensity * 42}px rgba(0,0,0,.48), 0 0 ${glowIntensity * 42}px rgba(214,168,79,${0.06 + glowIntensity * 0.09}), inset 0 1px 0 rgba(255,255,255,.08)`,
        } as React.CSSProperties
      }
    >
      <div className="pointer-events-none absolute inset-px -z-10 rounded-[inherit] border border-white/5" />
      <div className="pointer-events-none absolute -left-16 top-4 -z-10 h-[62%] w-[46%] rounded-full bg-[#D6A84F]/10 blur-[88px]" />
      <div className="pointer-events-none absolute left-[15%] top-[10%] -z-10 hidden aspect-square w-[34%] rounded-full border border-[#D6A84F]/20 bg-[radial-gradient(circle_at_42%_38%,rgba(245,196,81,.24),rgba(214,168,79,.08)_34%,rgba(0,0,0,0)_66%)] opacity-80 shadow-[0_0_80px_rgba(214,168,79,.22)] md:block">
        <div className="absolute inset-[12%] rounded-full border border-[#D6A84F]/20" />
        <div className="absolute inset-[23%] rounded-full border border-[#D6A84F]/20" />
        <div className="absolute inset-0 flex items-center justify-center font-mono text-[12vw] font-black text-[#D6A84F]/15">
          ₿
        </div>
      </div>

      <div className="grid h-full min-h-0 gap-5 p-5 md:p-7 lg:grid-cols-[minmax(320px,39%)_minmax(520px,1fr)]">
        <div className="relative flex min-w-0 flex-col justify-between gap-5 overflow-hidden">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-[#FFE08A]/70 bg-[radial-gradient(circle_at_35%_30%,#FFF3A2,#E5A712_62%,#9E6810)] text-white shadow-[0_0_38px_rgba(245,196,81,.26)]">
              <CurrencyBtc size={40} weight="bold" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-5xl font-black leading-none text-[#FFE7A3]">
                BTC
              </h2>
              <p className="mt-2 text-xl font-semibold text-[#D1D5DB]">
                Bitcoin / 比特币 · 现货
              </p>
            </div>
          </div>

          <div className="relative">
            <div className="flex items-center gap-2 text-xl font-semibold text-[#E5E7EB]">
              BTC 现货总价值
              <Info size={18} className="text-[#D6A84F]" />
            </div>
            <div
              className={[
                "mt-5 truncate font-mono font-black leading-none text-[#FFE08A]",
                isSlim ? "text-5xl" : "text-7xl",
              ].join(" ")}
            >
              {formatUsd(totalValueUsd)}
            </div>
            <div className="mt-4 text-2xl font-semibold text-[#E5E7EB]">
              {showCnyEstimate ? formatCnyEstimate(totalValueUsd) : "\u00A0"}
            </div>
            <div className="mt-6 inline-flex flex-wrap items-center gap-4 rounded-xl border border-[#D6A84F]/20 bg-[#D6A84F]/10 px-4 py-3 shadow-[0_12px_26px_rgba(214,168,79,.10)]">
              <span className="text-xl font-semibold text-[#FFE08A]">
                24H 涨跌
              </span>
              <span
                className={[
                  "inline-flex items-center gap-2 font-mono text-xl font-black",
                  isPositive ? "text-[#4ADE80]" : "text-[#FCA5A5]",
                ].join(" ")}
              >
                <TrendUp size={20} weight="bold" />
                {formatPct(change24hPct)}
              </span>
              <span
                className={[
                  "font-mono text-xl font-black",
                  isPositive ? "text-[#4ADE80]" : "text-[#FCA5A5]",
                ].join(" ")}
              >
                {formatSignedUsd(change24hUsd)}
              </span>
            </div>
          </div>

          <div className="border-t border-[#D6A84F]/25">
            <MetricRow
              icon={<TrendUp size={21} weight="bold" />}
              label="平均买入价"
              value={
                averageBuyPriceUsd
                  ? formatUsd(averageBuyPriceUsd)
                  : averageBuyPriceScope === "unknown" ||
                      averageBuyPriceScope === "insufficient_history"
                    ? "待统计"
                    : "--"
              }
              subValue={
                showCnyEstimate && averageBuyPriceUsd
                  ? formatCnyEstimate(averageBuyPriceUsd)
                  : undefined
              }
              tone="gold"
            />
            <MetricRow
              icon={<ChartLineUp size={21} weight="bold" />}
              label="当前价格"
              value={formatUsd(currentPriceUsd)}
              subValue={
                showCnyEstimate ? formatCnyEstimate(currentPriceUsd) : undefined
              }
              tone="gold"
            />
            <MetricRow
              icon={<Coins size={21} weight="bold" />}
              label="持有数量"
              value={formatBtc(btcAmount)}
              tone="gold"
            />
          </div>

          <div className="flex items-center gap-2 text-base font-semibold text-[#A1A1AA]">
            <Clock size={19} />
            <span>最后更新：{formatTime(lastUpdatedAt)}</span>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <BtcCandleChart
            mode={mode}
            candles={candles}
            currentPriceUsd={currentPriceUsd}
            change24hPct={change24hPct}
            connectionStatus={connectionStatus}
            range={range}
            showVolume={showVolume}
            showAutoRefreshBadge={showAutoRefreshBadge}
            autoRefreshSeconds={autoRefreshSeconds}
          />
        </div>
      </div>
    </section>
  );
}
