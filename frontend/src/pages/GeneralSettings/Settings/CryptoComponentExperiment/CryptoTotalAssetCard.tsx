import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Eye, EyeSlash, Wallet } from "@phosphor-icons/react";
import { cryptoMockTrend } from "./cryptoMockTrend";
import type {
  CryptoChartTone,
  CryptoConnectionStatus,
  CryptoLossChartTone,
  CryptoTotalAssetCardProps,
  CryptoTrendScenario,
  CryptoTrendPoint,
} from "./cryptoTotalAssetTypes";
import { useCryptoStatusLabel } from "./cryptoStatusI18n";

const statusMeta: Record<
  CryptoConnectionStatus,
  { dot: string; text: string; bg: string }
> = {
  connected: {
    dot: "#22C55E",
    text: "text-[#4ADE80]",
    bg: "bg-[#22C55E]/10",
  },
  degraded: {
    dot: "#F5C451",
    text: "text-[#F5C451]",
    bg: "bg-[#F5C451]/10",
  },
  disconnected: {
    dot: "#EF4444",
    text: "text-[#FCA5A5]",
    bg: "bg-[#EF4444]/10",
  },
};

const chartToneColor: Record<CryptoChartTone, string> = {
  green: "#22C55E",
  gold: "#D6A84F",
  cyan: "#43D4FF",
};

const lossToneColor: Record<CryptoLossChartTone, string> = {
  red: "#EF4444",
  gold: "#D6A84F",
  cyan: "#43D4FF",
};

const rollingDigits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const rollingWheelDigits = Array.from(
  { length: 70 },
  (_, index) => rollingDigits[index % rollingDigits.length]
);
const rollingBaseOffset = 20;
const trendAxisStartMinutes = 8 * 60;
const trendAxisWindowMinutes = 24 * 60;
const trendAxisLabels = [
  { label: "08:00", minutes: 0 },
  { label: "12:00", minutes: 4 * 60 },
  { label: "16:00", minutes: 8 * 60 },
  { label: "20:00", minutes: 12 * 60 },
  { label: "00:00", minutes: 16 * 60 },
  { label: "04:00", minutes: 20 * 60 },
  { label: "08:00", minutes: 24 * 60 },
];

type AmountSlotPhase = "entering" | "present" | "exiting";

type AmountDigitSlot = {
  bonusSpin: boolean;
  changed: boolean;
  digit: number;
  key: string;
  phase: AmountSlotPhase;
  sort: number;
  type: "digit";
};

type AmountStaticSlot = {
  char: string;
  key: string;
  phase: AmountSlotPhase;
  sort: number;
  type: "static";
};

type AmountSlot = AmountDigitSlot | AmountStaticSlot;

type ParsedAmountSlot =
  | Omit<AmountDigitSlot, "bonusSpin" | "changed" | "phase">
  | Omit<AmountStaticSlot, "phase">;

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function scenarioTrendPoints(
  baseline: number,
  scenario: CryptoTrendScenario
): CryptoTrendPoint[] {
  const times = cryptoMockTrend.map((point) => point.time);
  const offsets: Record<CryptoTrendScenario, number[]> = {
    profit: [-920, -760, -520, -280, 60, 340, 620, 940, 1180],
    loss: [960, 720, 480, 180, -120, -360, -560, -860, -1120],
    mixed: [-760, -220, 460, 820, -140, -620, 300, 760, -180],
  };
  return times.map((time, index) => ({
    time,
    value: baseline + offsets[scenario][index],
  }));
}

function formatSignedUsd(value: number) {
  const formatted = formatUsd(Math.abs(value));
  return `${value >= 0 ? "+" : "-"}${formatted}`;
}

function formatSignedPct(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function compactValue(value: number) {
  return `${Math.round(value / 1_000)}K`;
}

function secondsFromTimeLabel(time: string) {
  const [hour = "0", minute = "0", second = "0"] = time.split(":");
  return Number(hour) * 60 * 60 + Number(minute) * 60 + Number(second);
}

function shanghaiOffsetSecondsFromTimestamp(ts: number) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(ts)).map((part) => [part.type, part.value])
  );
  return (
    Number(parts.hour || 0) * 60 * 60 +
    Number(parts.minute || 0) * 60 +
    Number(parts.second || 0)
  );
}

function trendPointClockSeconds(point: CryptoTrendPoint) {
  if (point.time) return secondsFromTimeLabel(point.time);
  if (point.ts) return shanghaiOffsetSecondsFromTimestamp(point.ts);
  return 0;
}

function rawTrendWindowOffsetMinutes(point: CryptoTrendPoint) {
  const pointSeconds = trendPointClockSeconds(point);
  let offsetSeconds = pointSeconds - trendAxisStartMinutes * 60;
  const trendAxisWindowSeconds = trendAxisWindowMinutes * 60;
  if (offsetSeconds < 0) offsetSeconds += trendAxisWindowSeconds;

  return Math.max(0, Math.min(offsetSeconds / 60, trendAxisWindowMinutes));
}

function trendWindowOffsets(points: CryptoTrendPoint[]) {
  let previousOffset: number | null = null;
  let dayOffset = 0;

  return points.map((point) => {
    const rawOffset = rawTrendWindowOffsetMinutes(point);
    while (
      previousOffset !== null &&
      rawOffset + dayOffset < previousOffset - 0.001
    ) {
      dayOffset += trendAxisWindowMinutes;
    }

    const offset = Math.max(
      0,
      Math.min(rawOffset + dayOffset, trendAxisWindowMinutes)
    );
    previousOffset = offset;
    return offset;
  });
}

function formatDeltaUsd(value: number) {
  return `${value >= 0 ? "+" : "-"}${formatUsd(Math.abs(value))}`;
}

function formatDeltaPct(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function snapshotDateTime(
  point: CryptoTrendPoint,
  index: number,
  points: CryptoTrendPoint[]
) {
  if (point.ts) {
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
      formatter
        .formatToParts(new Date(point.ts))
        .map((part) => [part.type, part.value])
    );
    return {
      date: point.date || `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}:${parts.second}`,
    };
  }

  const offset =
    "offsetMinutes" in point && typeof point.offsetMinutes === "number"
      ? point.offsetMinutes
      : trendWindowOffsets(points)[index] || 0;
  const clockMinutes =
    (trendAxisStartMinutes + offset) % trendAxisWindowMinutes;
  const hour = Math.floor(clockMinutes / 60);
  const minute = clockMinutes % 60;
  const date = new Date();
  date.setHours(hour, minute, (index * 7 + 18) % 60, 0);
  if (offset >= 16 * 60) date.setDate(date.getDate() + 1);

  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");

  return {
    date: `${year}-${month}-${day}`,
    time: `${hours}:${minutes}:${seconds}`,
  };
}

function parseAmountSlots(value: string): ParsedAmountSlot[] {
  const decimalIndex = value.indexOf(".");
  const integerEnd = decimalIndex === -1 ? value.length : decimalIndex;
  const integerPart = value.slice(0, integerEnd);
  const fractionPart = decimalIndex === -1 ? "" : value.slice(decimalIndex + 1);
  const integerDigitCount = Array.from(integerPart).filter((character) =>
    /\d/.test(character)
  ).length;
  const slots: ParsedAmountSlot[] = [];
  let integerDigitsSeen = 0;

  Array.from(integerPart).forEach((character, index) => {
    if (/\d/.test(character)) {
      const integerPlace = integerDigitCount - integerDigitsSeen - 1;
      slots.push({
        digit: Number(character),
        key: `digit-int-${integerPlace}`,
        sort: 10_000 - integerPlace * 10,
        type: "digit",
      });
      integerDigitsSeen += 1;
      return;
    }

    if (character === ",") {
      const remainingDigits = integerDigitCount - integerDigitsSeen;
      slots.push({
        char: character,
        key: `group-before-${remainingDigits}`,
        sort: 10_000 - remainingDigits * 10 + 5,
        type: "static",
      });
      return;
    }

    slots.push({
      char: character,
      key: `prefix-${character}-${index}`,
      sort: -1_000 + index,
      type: "static",
    });
  });

  if (decimalIndex !== -1) {
    slots.push({
      char: ".",
      key: "decimal-point",
      sort: 10_010,
      type: "static",
    });
  }

  Array.from(fractionPart).forEach((character, index) => {
    if (/\d/.test(character)) {
      slots.push({
        digit: Number(character),
        key: `digit-frac-${index}`,
        sort: 10_020 + index * 10,
        type: "digit",
      });
      return;
    }

    slots.push({
      char: character,
      key: `fraction-static-${character}-${index}`,
      sort: 10_020 + index * 10,
      type: "static",
    });
  });

  return slots.sort((left, right) => left.sort - right.sort);
}

function presentAmountSlots(value: string): AmountSlot[] {
  return parseAmountSlots(value).map((slot) =>
    slot.type === "digit"
      ? { ...slot, bonusSpin: false, changed: false, phase: "present" }
      : { ...slot, phase: "present" }
  );
}

function mergeAmountSlots(
  currentSlots: AmountSlot[],
  nextSlots: ParsedAmountSlot[],
  bonusSpin: boolean
): AmountSlot[] {
  const currentByKey = new Map(currentSlots.map((slot) => [slot.key, slot]));
  const nextKeys = new Set(nextSlots.map((slot) => slot.key));
  const mergedSlots: AmountSlot[] = nextSlots.map((slot) => {
    const currentSlot = currentByKey.get(slot.key);

    if (slot.type === "digit") {
      const changed =
        currentSlot?.type === "digit" && currentSlot.digit !== slot.digit;
      return {
        ...slot,
        bonusSpin: bonusSpin && changed,
        changed,
        phase: currentSlot ? "present" : "entering",
      };
    }

    return {
      ...slot,
      phase: currentSlot ? "present" : "entering",
    };
  });

  const exitingSlots = currentSlots
    .filter((slot) => !nextKeys.has(slot.key))
    .map((slot) => ({ ...slot, phase: "exiting" as const }));

  return [...mergedSlots, ...exitingSlots].sort(
    (left, right) => left.sort - right.sort
  );
}

function chartGeometry(points: CryptoTrendPoint[], baseline: number) {
  const width = 700;
  const height = 500;
  const padding = { top: 58, right: 26, bottom: 60, left: 64 };
  const values = [...points.map((point) => point.value), baseline];
  const min = Math.min(...values) - 280;
  const max = Math.max(...values) + 280;
  const xSpan = width - padding.left - padding.right;
  const ySpan = height - padding.top - padding.bottom;
  const offsets = trendWindowOffsets(points);
  const coords = points.map((point, index) => {
    const x = padding.left + (offsets[index] / trendAxisWindowMinutes) * xSpan;
    const y = padding.top + ((max - point.value) / (max - min)) * ySpan;
    return { ...point, offsetMinutes: offsets[index], x, y };
  });
  const displayCoords = downsampleCoords(coords);
  const linePath = displayCoords
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const baselineY = padding.top + ((max - baseline) / (max - min)) * ySpan;
  const baselineAreaPath = displayCoords.length
    ? `${linePath} L ${
        displayCoords[displayCoords.length - 1].x
      } ${baselineY} L ${displayCoords[0].x} ${baselineY} Z`
    : "";

  return {
    width,
    height,
    padding,
    min,
    max,
    coords,
    displayCoords,
    linePath,
    baselineY,
    baselineAreaPath,
    ticks: [max, baseline, min],
    xLabels: trendAxisLabels.map((label) => ({
      ...label,
      x: padding.left + (label.minutes / trendAxisWindowMinutes) * xSpan,
    })),
  };
}

type ChartGeometry = ReturnType<typeof chartGeometry>;
type ChartCoord = ChartGeometry["coords"][number];

function clampNumber(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function downsampleCoords<T extends { x: number; y: number }>(
  coords: T[],
  maxPoints = 1400
) {
  if (coords.length <= maxPoints) return coords;

  const sampled: T[] = [];
  const stride = Math.ceil(coords.length / maxPoints);
  for (let index = 0; index < coords.length; index += stride) {
    sampled.push(coords[index]);
  }

  const last = coords[coords.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function findNearestCoordIndex(coords: ChartCoord[], x: number) {
  if (!coords.length) return null;
  let left = 0;
  let right = coords.length - 1;

  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (coords[middle].x < x) left = middle + 1;
    else right = middle;
  }

  const previous = Math.max(0, left - 1);
  return Math.abs(coords[left].x - x) < Math.abs(coords[previous].x - x)
    ? left
    : previous;
}

export default function CryptoTotalAssetCard({
  totalEquityUsd,
  todayPnlUsd,
  todayPnlPct,
  yesterdayBaselineUsd,
  connectionStatus,
  lastUpdatedAt,
  lastUpdatedDate,
  cardHeight,
  borderRadius,
  backgroundMode,
  backgroundImage,
  showTrendChart,
  showEyeIcon,
  showStatusBadge,
  glowIntensity,
  profitChartTone,
  lossChartTone,
  trendPoints: providedTrendPoints,
  trendScenario,
  numberSize,
  compactMode,
}: CryptoTotalAssetCardProps) {
  const [amountVisible, setAmountVisible] = useState(true);
  const safeBaseline = Number.isFinite(yesterdayBaselineUsd)
    ? yesterdayBaselineUsd
    : defaultBaselineFromTrend();
  const status = statusMeta[connectionStatus];
  const statusLabel = useCryptoStatusLabel(connectionStatus);
  const tone = todayPnlUsd >= 0 ? "text-[#4ADE80]" : "text-[#FCA5A5]";
  const isSlim = compactMode || cardHeight <= 220;
  const cardPadding = isSlim ? "p-4 md:p-5" : "p-5 md:p-6";
  const profitColor = chartToneColor[profitChartTone];
  const lossColor = lossToneColor[lossChartTone];
  const trendPoints = useMemo(() => {
    if (providedTrendPoints?.length) return providedTrendPoints;
    return scenarioTrendPoints(safeBaseline, trendScenario);
  }, [providedTrendPoints, safeBaseline, trendScenario]);
  const background =
    backgroundMode === "image" && backgroundImage
      ? `linear-gradient(115deg, rgba(8,9,11,.94), rgba(11,13,18,.86)), url("${backgroundImage}") center/cover`
      : backgroundMode === "gradient"
        ? "radial-gradient(ellipse 42% 78% at 7% 8%, rgba(214,168,79,.10) 0%, rgba(214,168,79,.045) 28%, rgba(214,168,79,0) 66%), radial-gradient(ellipse 34% 58% at 88% 12%, rgba(34,197,94,.08) 0%, rgba(34,197,94,.035) 30%, rgba(34,197,94,0) 68%), linear-gradient(135deg, #08090B 0%, #0B0D12 55%, #050608 100%)"
        : "linear-gradient(135deg, #08090B 0%, #0B0D12 100%)";

  return (
    <section
      className={`relative isolate w-full overflow-hidden text-[#F8FAFC] backdrop-blur-xl max-lg:min-h-[var(--crypto-card-height)] lg:h-[var(--crypto-card-height)] ${cardPadding}`}
      style={
        {
          "--crypto-card-height": `${cardHeight}px`,
          borderRadius: `${borderRadius}px`,
          background,
          boxShadow: `0 18px ${38 + glowIntensity * 34}px rgba(0,0,0,.42), 0 0 ${glowIntensity * 32}px rgba(214,168,79,${0.02 + glowIntensity * 0.06}), inset 0 1px 0 rgba(255,255,255,.08)`,
        } as React.CSSProperties
      }
    >
      <div className="pointer-events-none absolute inset-px -z-10 rounded-[inherit] bg-[linear-gradient(180deg,rgba(255,255,255,.07),transparent_38%)]" />
      <div
        className="pointer-events-none absolute -left-20 -top-24 -z-10 h-72 w-96 rounded-full blur-[86px]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(214,168,79,.08) 0%, rgba(214,168,79,.032) 42%, rgba(214,168,79,0) 74%)",
        }}
      />

      <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(330px,46%)]">
        <div className="flex min-w-0 flex-col justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[#D6A84F]/20 bg-[#D6A84F]/10 shadow-[inset_0_1px_0_rgba(255,255,255,.08)] md:h-14 md:w-14">
              <Wallet size={isSlim ? 24 : 28} color="#D6A84F" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-xl font-bold leading-tight md:text-2xl">
                总资产概览
              </h2>
            </div>
          </div>

          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-3 text-xs font-bold text-[#9CA3AF] md:text-sm">
              <span>总资产估值 (USD)</span>
              {showEyeIcon && (
                <button
                  type="button"
                  aria-label={
                    amountVisible ? "隐藏总资产金额" : "显示总资产金额"
                  }
                  title={amountVisible ? "隐藏总资产金额" : "显示总资产金额"}
                  onClick={() => setAmountVisible((visible) => !visible)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/[.06] text-[#D1D5DB] transition hover:bg-white/[.12] hover:text-white"
                >
                  {amountVisible ? (
                    <Eye size={17} weight="fill" />
                  ) : (
                    <EyeSlash size={17} weight="fill" />
                  )}
                </button>
              )}
            </div>
            <div
              className="relative z-10 max-w-full overflow-hidden whitespace-nowrap font-bold leading-none tracking-normal"
              style={{
                fontSize: `clamp(30px, 5vw, ${numberSize}px)`,
                color: "#F8FAFC",
                filter: "drop-shadow(0 10px 22px rgba(0,0,0,.38))",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {amountVisible ? (
                <RollingAmount value={formatUsd(totalEquityUsd)} />
              ) : (
                <span className="text-[#F8FAFC]">$••••••</span>
              )}
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-2 items-end gap-4">
            <AssetStat
              label="今日盈亏 (USD)"
              value={formatSignedUsd(todayPnlUsd)}
              tone={tone}
            />
            <AssetStat
              label="今日盈亏 (%)"
              value={formatSignedPct(todayPnlPct)}
              tone={tone}
            />
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="flex h-11 shrink-0 items-start justify-between gap-3 text-sm font-semibold text-[#9CA3AF]">
            {showStatusBadge && (
              <span
                className={`inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-sm font-bold ${status.bg} ${status.text}`}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full shadow-[0_0_18px_currentColor]"
                  style={{ backgroundColor: status.dot }}
                />
                {statusLabel}
              </span>
            )}
            <div className="grid min-w-0 justify-items-end gap-1 leading-none">
              <div className="flex min-w-0 items-center gap-2 text-[11px] font-bold text-[#9CA3AF]">
                <span className="truncate font-mono text-[#D1D5DB]">
                  {lastUpdatedDate}
                </span>
                <span className="shrink-0">当前时间</span>
              </div>
              <span className="min-w-[150px] text-right font-mono text-[34px] font-black leading-none tracking-[0.1em] text-[#F8FAFC]">
                {lastUpdatedAt}
              </span>
            </div>
          </div>

          {showTrendChart && (
            <TrendChart
              points={trendPoints}
              baseline={safeBaseline}
              profitColor={profitColor}
              lossColor={lossColor}
            />
          )}
        </div>
      </div>
    </section>
  );
}

const RollingAmount = React.memo(function RollingAmount({
  value,
}: {
  value: string;
}) {
  const [slots, setSlots] = useState<AmountSlot[]>(() =>
    presentAmountSlots(value)
  );
  const valueRef = useRef(value);

  useEffect(() => {
    function settlePausedAnimation() {
      setSlots((currentSlots) =>
        currentSlots
          .filter((slot) => slot.phase !== "exiting")
          .map((slot) =>
            slot.phase === "entering" ? { ...slot, phase: "present" } : slot
          )
      );
    }

    document.addEventListener("visibilitychange", settlePausedAnimation);
    window.addEventListener("focus", settlePausedAnimation);

    return () => {
      document.removeEventListener("visibilitychange", settlePausedAnimation);
      window.removeEventListener("focus", settlePausedAnimation);
    };
  }, []);

  useEffect(() => {
    if (valueRef.current === value) return;

    const nextSlots = parseAmountSlots(value);
    const bonusSpin = Math.random() < 0.5;
    valueRef.current = value;

    setSlots((currentSlots) =>
      mergeAmountSlots(currentSlots, nextSlots, bonusSpin)
    );

    const enterFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setSlots((currentSlots) =>
          currentSlots.map((slot) =>
            slot.phase === "entering" ? { ...slot, phase: "present" } : slot
          )
        );
      });
    });
    const cleanupTimer = window.setTimeout(() => {
      setSlots((currentSlots) =>
        currentSlots.filter((slot) => slot.phase !== "exiting")
      );
    }, 760);

    return () => {
      window.cancelAnimationFrame(enterFrame);
      window.clearTimeout(cleanupTimer);
    };
  }, [value]);

  return (
    <span className="inline-flex max-w-full items-center overflow-hidden align-bottom leading-none text-[#F8FAFC]">
      {slots.map((slot, index) => (
        <RollingAmountSlot key={slot.key} phase={slot.phase} slot={slot}>
          {slot.type === "digit" ? (
            <RollingDigit
              bonusSpin={slot.bonusSpin}
              digit={slot.digit}
              index={index}
            />
          ) : (
            <span className="inline-block shrink-0 leading-none text-[#F8FAFC]">
              {slot.char}
            </span>
          )}
        </RollingAmountSlot>
      ))}
    </span>
  );
});

function RollingAmountSlot({
  children,
  phase,
  slot,
}: {
  children: React.ReactNode;
  phase: AmountSlotPhase;
  slot: AmountSlot;
}) {
  const slotWidth =
    slot.type === "digit"
      ? "0.58em"
      : slot.char === ","
        ? "0.28em"
        : slot.char === "."
          ? "0.24em"
          : slot.char === "-"
            ? "0.34em"
            : "0.62em";
  const isVisible = phase !== "exiting";

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden align-bottom leading-none transition-[max-width,opacity,transform] duration-500 motion-reduce:transition-none"
      style={{
        maxWidth: isVisible ? slotWidth : "0em",
        opacity: isVisible ? 1 : 0,
        transform:
          phase === "entering"
            ? "translateY(-0.18em) scaleX(.72)"
            : phase === "exiting"
              ? "translateY(0.18em) scaleX(.72)"
              : "translateY(0) scaleX(1)",
        transitionDelay:
          phase === "present" ? `${Math.min(slot.sort / 800, 80)}ms` : "0ms",
        transitionTimingFunction: "cubic-bezier(.65,0,.35,1)",
      }}
    >
      {children}
    </span>
  );
}

const RollingDigit = React.memo(function RollingDigit({
  bonusSpin,
  digit,
  index,
}: {
  bonusSpin: boolean;
  digit: number;
  index: number;
}) {
  const [position, setPosition] = useState(() => rollingBaseOffset + digit);
  const [animate, setAnimate] = useState(false);
  const digitRef = useRef(digit);

  useEffect(() => {
    if (digitRef.current === digit) return;

    setPosition((currentPosition) => {
      const currentDigit = currentPosition % 10;
      const normalDistance = (digit - currentDigit + 10) % 10 || 10;
      return currentPosition + normalDistance + (bonusSpin ? 10 : 0);
    });
    setAnimate(true);
    digitRef.current = digit;
  }, [bonusSpin, digit]);

  function normalizeWheelPosition() {
    if (position <= rollingBaseOffset + 19) return;

    setAnimate(false);
    setPosition(rollingBaseOffset + digit);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setAnimate(true));
    });
  }

  return (
    <span className="inline-block h-[1em] min-w-[0.58em] shrink-0 overflow-hidden align-bottom leading-none text-[#F8FAFC]">
      <span
        className="flex flex-col leading-none motion-reduce:transition-none"
        onTransitionEnd={normalizeWheelPosition}
        style={{
          transform: `translate3d(0, -${position}em, 0)`,
          transitionDuration: animate ? "860ms" : "0ms",
          transitionDelay: `${Math.min(index * 18, 144)}ms`,
          transitionProperty: "transform",
          transitionTimingFunction: "cubic-bezier(.65,0,.35,1)",
          willChange: "transform",
        }}
      >
        {rollingWheelDigits.map((item, wheelIndex) => (
          <span
            key={`${item}-${wheelIndex}`}
            className="block h-[1em] leading-none text-[#F8FAFC]"
          >
            {item}
          </span>
        ))}
      </span>
    </span>
  );
});

const AssetStat = React.memo(function AssetStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-bold text-[#9CA3AF]">{label}</div>
      <div
        className={`mt-1 truncate text-xl font-bold leading-none md:text-2xl ${tone}`}
      >
        {value}
      </div>
    </div>
  );
});

const TrendChart = React.memo(function TrendChart({
  points,
  baseline,
  profitColor,
  lossColor,
}: {
  points: CryptoTrendPoint[];
  baseline: number;
  profitColor: string;
  lossColor: string;
}) {
  const gradientId = useId().replace(/:/g, "");
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const hoverFrameRef = useRef<number | null>(null);
  const pendingHoverXRef = useRef<number | null>(null);
  const chart = useMemo(
    () => chartGeometry(points, baseline),
    [baseline, points]
  );
  const hoveredPoint =
    hoveredIndex === null ? null : chart.coords[hoveredIndex] || null;
  const tooltipWidth = 390;
  const tooltipHeight = 190;
  const tooltipGap = 18;
  const tooltipMinX = chart.padding.left + 4;
  const tooltipMaxX = chart.width - chart.padding.right - tooltipWidth;
  const tooltipMinY = chart.padding.top + 4;
  const tooltipMaxY = chart.height - chart.padding.bottom - tooltipHeight;
  const tooltipX = hoveredPoint
    ? clampNumber(hoveredPoint.x + tooltipGap, tooltipMinX, tooltipMaxX)
    : 0;
  const tooltipY = hoveredPoint
    ? clampNumber(hoveredPoint.y + tooltipGap, tooltipMinY, tooltipMaxY)
    : 0;
  const hoveredDelta = hoveredPoint ? hoveredPoint.value - baseline : 0;
  const hoveredDeltaPct = baseline ? (hoveredDelta / baseline) * 100 : 0;
  const hoveredTone = hoveredDelta >= 0 ? profitColor : lossColor;
  const hoveredDateTime =
    hoveredPoint && hoveredIndex !== null
      ? snapshotDateTime(hoveredPoint, hoveredIndex, chart.coords)
      : null;
  const hasDrawablePoints = chart.coords.length > 0;
  const lastPoint = chart.coords[chart.coords.length - 1];

  useEffect(() => {
    return () => {
      if (hoverFrameRef.current !== null) {
        window.cancelAnimationFrame(hoverFrameRef.current);
      }
    };
  }, []);

  function flushHoverPosition() {
    hoverFrameRef.current = null;
    const x = pendingHoverXRef.current;
    if (x === null) return;

    const nextIndex = findNearestCoordIndex(chart.coords, x);
    setHoveredIndex((currentIndex) =>
      currentIndex === nextIndex ? currentIndex : nextIndex
    );
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!hasDrawablePoints || !svgRef.current) return;

    const rect = svgRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * chart.width;
    pendingHoverXRef.current = Math.max(
      chart.padding.left,
      Math.min(x, chart.width - chart.padding.right)
    );

    if (hoverFrameRef.current !== null) return;
    hoverFrameRef.current = window.requestAnimationFrame(flushHoverPosition);
  }

  function handlePointerLeave() {
    if (hoverFrameRef.current !== null) {
      window.cancelAnimationFrame(hoverFrameRef.current);
      hoverFrameRef.current = null;
    }
    pendingHoverXRef.current = null;
    setHoveredIndex(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-[14px] bg-transparent p-1">
      <div className="mb-1 flex items-center justify-between gap-3 text-sm font-bold text-[#9CA3AF]">
        <span>24H 资产趋势</span>
        <span className="font-mono text-[11px] text-[#D6A84F]">
          基准 {formatUsd(baseline)}
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className="min-h-0 w-full flex-1 overflow-visible"
        role="img"
        aria-label="以基准金额为参考的24H资产趋势折线图"
        onPointerLeave={handlePointerLeave}
        onPointerMove={handlePointerMove}
      >
        <TrendStaticLayer
          baseline={baseline}
          chart={chart}
          gradientId={gradientId}
          hasDrawablePoints={hasDrawablePoints}
          lastPoint={lastPoint}
          lossColor={lossColor}
          profitColor={profitColor}
        />

        <rect
          x={chart.padding.left}
          y={chart.padding.top - 12}
          width={chart.width - chart.padding.left - chart.padding.right}
          height={chart.height - chart.padding.top - chart.padding.bottom + 24}
          fill="transparent"
          pointerEvents="all"
        />

        {!hasDrawablePoints && (
          <text
            x={chart.width / 2}
            y={chart.height / 2}
            textAnchor="middle"
            fill="#9CA3AF"
            fontSize="16"
            fontWeight="700"
          >
            等待真实快照
          </text>
        )}

        {hoveredPoint && hoveredDateTime && (
          <TrendHoverLayer
            chart={chart}
            gradientId={gradientId}
            hoveredDateTime={hoveredDateTime}
            hoveredDelta={hoveredDelta}
            hoveredDeltaPct={hoveredDeltaPct}
            hoveredPoint={hoveredPoint}
            hoveredTone={hoveredTone}
            tooltipHeight={tooltipHeight}
            tooltipWidth={tooltipWidth}
            tooltipX={tooltipX}
            tooltipY={tooltipY}
          />
        )}
      </svg>
    </div>
  );
});

const TrendStaticLayer = React.memo(function TrendStaticLayer({
  baseline,
  chart,
  gradientId,
  hasDrawablePoints,
  lastPoint,
  lossColor,
  profitColor,
}: {
  baseline: number;
  chart: ChartGeometry;
  gradientId: string;
  hasDrawablePoints: boolean;
  lastPoint?: ChartCoord;
  lossColor: string;
  profitColor: string;
}) {
  return (
    <>
      <defs>
        <linearGradient id={`${gradientId}-profit`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={profitColor} stopOpacity="0.42" />
          <stop offset="100%" stopColor={profitColor} stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id={`${gradientId}-loss`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={lossColor} stopOpacity="0.28" />
          <stop offset="100%" stopColor={lossColor} stopOpacity="0.04" />
        </linearGradient>
        <clipPath id={`${gradientId}-profit-clip`}>
          <rect x="0" y="0" width={chart.width} height={chart.baselineY} />
        </clipPath>
        <clipPath id={`${gradientId}-loss-clip`}>
          <rect
            x="0"
            y={chart.baselineY}
            width={chart.width}
            height={chart.height - chart.baselineY}
          />
        </clipPath>
        <filter id={`${gradientId}-glow`}>
          <feGaussianBlur stdDeviation="4" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {chart.ticks.map((tick) => {
        const y =
          chart.padding.top +
          ((chart.max - tick) / (chart.max - chart.min)) *
            (chart.height - chart.padding.top - chart.padding.bottom);
        return (
          <g key={tick}>
            <line
              x1={chart.padding.left}
              x2={chart.width - chart.padding.right}
              y1={y}
              y2={y}
              stroke={
                tick === baseline
                  ? "rgba(214,168,79,.46)"
                  : "rgba(255,255,255,.10)"
              }
              strokeDasharray={tick === baseline ? "4 4" : "7 7"}
            />
            <text
              x={chart.padding.left - 24}
              y={y + 5}
              textAnchor="end"
              fill="#B8BDC7"
              fontSize="15"
              fontWeight="700"
            >
              {tick === baseline ? "基准" : compactValue(tick)}
            </text>
          </g>
        );
      })}

      {hasDrawablePoints && lastPoint && (
        <>
          <path
            d={chart.baselineAreaPath}
            fill={`url(#${gradientId}-profit)`}
            clipPath={`url(#${gradientId}-profit-clip)`}
          />
          <path
            d={chart.baselineAreaPath}
            fill={`url(#${gradientId}-loss)`}
            clipPath={`url(#${gradientId}-loss-clip)`}
          />
          <path
            d={chart.linePath}
            fill="none"
            stroke={profitColor}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#${gradientId}-glow)`}
            clipPath={`url(#${gradientId}-profit-clip)`}
          />
          <path
            d={chart.linePath}
            fill="none"
            stroke={lossColor}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#${gradientId}-glow)`}
            clipPath={`url(#${gradientId}-loss-clip)`}
          />
          <circle
            cx={lastPoint.x}
            cy={lastPoint.y}
            r="6"
            fill={lastPoint.value >= baseline ? profitColor : lossColor}
            filter={`url(#${gradientId}-glow)`}
          />
        </>
      )}

      <line
        x1={chart.padding.left}
        x2={chart.width - chart.padding.right}
        y1={chart.height - chart.padding.bottom}
        y2={chart.height - chart.padding.bottom}
        stroke="rgba(255,255,255,.10)"
      />

      {chart.xLabels.map((point) => (
        <text
          key={`${point.label}-${point.minutes}`}
          x={point.x}
          y={chart.height - 14}
          textAnchor="middle"
          fill="#B8BDC7"
          fontSize="15"
          fontWeight="700"
        >
          {point.label}
        </text>
      ))}
    </>
  );
});

function TrendHoverLayer({
  chart,
  gradientId,
  hoveredDateTime,
  hoveredDelta,
  hoveredDeltaPct,
  hoveredPoint,
  hoveredTone,
  tooltipHeight,
  tooltipWidth,
  tooltipX,
  tooltipY,
}: {
  chart: ChartGeometry;
  gradientId: string;
  hoveredDateTime: { date: string; time: string };
  hoveredDelta: number;
  hoveredDeltaPct: number;
  hoveredPoint: ChartCoord;
  hoveredTone: string;
  tooltipHeight: number;
  tooltipWidth: number;
  tooltipX: number;
  tooltipY: number;
}) {
  return (
    <g pointerEvents="none">
      <line
        x1={hoveredPoint.x}
        x2={hoveredPoint.x}
        y1={chart.padding.top}
        y2={chart.height - chart.padding.bottom}
        stroke="rgba(255,255,255,.18)"
        strokeDasharray="5 5"
      />
      <circle
        cx={hoveredPoint.x}
        cy={hoveredPoint.y}
        r="8"
        fill={hoveredTone}
        filter={`url(#${gradientId}-glow)`}
      />
      <rect
        x={tooltipX}
        y={tooltipY}
        width={tooltipWidth}
        height={tooltipHeight}
        rx="18"
        fill="rgba(8,9,11,.94)"
        stroke="rgba(255,255,255,.16)"
      />
      <text
        x={tooltipX + 28}
        y={tooltipY + 52}
        fill="#F8FAFC"
        fontSize="34"
        fontWeight="800"
      >
        {formatUsd(hoveredPoint.value)}
      </text>
      <text
        x={tooltipX + 28}
        y={tooltipY + 100}
        fill={hoveredTone}
        fontSize="23"
        fontWeight="800"
      >
        {formatDeltaUsd(hoveredDelta)}
      </text>
      <text
        x={tooltipX + tooltipWidth - 28}
        y={tooltipY + 100}
        fill={hoveredTone}
        fontSize="23"
        fontWeight="800"
        textAnchor="end"
      >
        {formatDeltaPct(hoveredDeltaPct)}
      </text>
      <text
        x={tooltipX + 28}
        y={tooltipY + 146}
        fill="#D1D5DB"
        fontSize="20"
        fontWeight="700"
      >
        {hoveredDateTime.time}
      </text>
      <text
        x={tooltipX + 28}
        y={tooltipY + 174}
        fill="#8B9099"
        fontSize="18"
        fontWeight="700"
      >
        {hoveredDateTime.date}
      </text>
    </g>
  );
}

function defaultBaselineFromTrend() {
  const values = cryptoMockTrend.map((point) => point.value);
  return values.reduce((total, value) => total + value, 0) / values.length;
}
