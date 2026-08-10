import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import type {
  AssetAllocationDonutCardProps,
  AssetAllocationItem,
} from "./assetAllocationDonutTypes";
import { tradingPairMockPresets } from "./tradingPairMockPresets";
import AutoFitNumericText from "./AutoFitNumericText";

const DEFAULT_OTHER_COLOR = "#9CA3AF";
const STABLE_USDT_ASSETS = new Set(["USDT", "GUSD", "USDC"]);
const TRADING_PAIR_ASSET_COLORS = tradingPairMockPresets.reduce(
  (colors, preset) => ({
    ...colors,
    [preset.baseAsset.trim().toUpperCase()]: preset.accentColor,
  }),
  {} as Record<string, string>
);
const DYNAMIC_ASSET_COLORS = tradingPairMockPresets
  .map((preset) => preset.accentColor)
  .filter(
    (color, index, colors) =>
      color !== DEFAULT_OTHER_COLOR && colors.indexOf(color) === index
  );

function parseNumber(value?: string | null) {
  if (!value) return 0;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function formatMoney(value?: string | number | null) {
  const number = typeof value === "number" ? value : parseNumber(value);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function formatCompact(value?: string | number | null) {
  const number = typeof value === "number" ? value : parseNumber(value);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 6,
  }).format(number);
}

function formatPercent(value?: string | number | null) {
  const number = typeof value === "number" ? value : parseNumber(value);
  return `${number.toFixed(2)}%`;
}

function rgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const bigint = Number.parseInt(
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized,
    16
  );
  const red = (bigint >> 16) & 255;
  const green = (bigint >> 8) & 255;
  const blue = bigint & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function normalizedHex(value?: string) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function isGenericAssetColor(value?: string) {
  const color = normalizedHex(value);
  return (
    !color ||
    color === normalizedHex(DEFAULT_OTHER_COLOR) ||
    color === "#94A3B8" ||
    color === "#A1A1AA" ||
    color === "#71717A"
  );
}

function symbolHash(symbol: string) {
  return symbol.split("").reduce((hash, char) => {
    return (hash * 31 + char.charCodeAt(0)) % 997;
  }, 7);
}

function preferredAssetColor(item: AssetAllocationItem) {
  const symbol = item.symbol.trim().toUpperCase();
  if (symbol === "OTHER") return DEFAULT_OTHER_COLOR;
  if (TRADING_PAIR_ASSET_COLORS[symbol])
    return TRADING_PAIR_ASSET_COLORS[symbol];
  if (!isGenericAssetColor(item.color)) return item.color;
  return DYNAMIC_ASSET_COLORS[symbolHash(symbol) % DYNAMIC_ASSET_COLORS.length];
}

function mergeItemValues(items: AssetAllocationItem[]): AssetAllocationItem {
  const valueUsd = items.reduce(
    (sum, item) => sum + parseNumber(item.valueUsd),
    0
  );
  const percentage = items.reduce(
    (sum, item) => sum + parseNumber(item.percentage),
    0
  );
  const amount = items.every((item) => item.amount)
    ? items.reduce((sum, item) => sum + parseNumber(item.amount), 0).toFixed(8)
    : undefined;

  return {
    symbol: "OTHER",
    name: "Other",
    nameCn: "其他",
    color: DEFAULT_OTHER_COLOR,
    valueUsd: valueUsd.toFixed(2),
    percentage: percentage.toFixed(2),
    amount,
  };
}

function groupedAllocationItems(items: AssetAllocationItem[]) {
  const stableItems: AssetAllocationItem[] = [];
  const otherItems: AssetAllocationItem[] = [];
  const grouped = new Map<string, AssetAllocationItem[]>();

  for (const item of items) {
    const symbol = item.symbol.trim().toUpperCase();
    if (!symbol) continue;
    if (STABLE_USDT_ASSETS.has(symbol)) {
      stableItems.push({ ...item, symbol });
      continue;
    }
    if (symbol === "OTHER") {
      otherItems.push({ ...item, symbol });
      continue;
    }
    const bucket = grouped.get(symbol) || [];
    bucket.push({ ...item, symbol });
    grouped.set(symbol, bucket);
  }

  const regularItems = [...grouped.entries()].map(([symbol, bucket]) => {
    if (bucket.length === 1) return bucket[0];
    const merged = mergeItemValues(bucket);
    return {
      ...bucket[0],
      symbol,
      valueUsd: merged.valueUsd,
      percentage: merged.percentage,
      amount: merged.amount,
    };
  });

  if (stableItems.length) {
    const mergedStable = mergeItemValues(stableItems);
    regularItems.push({
      symbol: "USDT",
      name: "USD Stablecoins",
      nameCn: "USDT / GUSD / USDC",
      color:
        TRADING_PAIR_ASSET_COLORS.USDT ||
        stableItems.find((item) => item.symbol === "USDT")?.color ||
        "#26A17B",
      valueUsd: mergedStable.valueUsd,
      percentage: mergedStable.percentage,
      amount: mergedStable.amount,
      priceUsd: "1.00",
      change24hPct: null,
    });
  }

  return {
    regularItems,
    explicitOther: otherItems.length ? mergeItemValues(otherItems) : null,
  };
}

function normalizeItems(items: AssetAllocationItem[], maxVisibleItems: number) {
  const visibleLimit = Math.max(2, Math.min(12, Math.round(maxVisibleItems)));
  const { regularItems, explicitOther } = groupedAllocationItems(items);
  const sorted = regularItems.sort(
    (left, right) => parseNumber(right.valueUsd) - parseNumber(left.valueUsd)
  );

  const assignDistinctColors = (nextItems: AssetAllocationItem[]) => {
    const usedColors = new Set<string>();
    return nextItems.map((item, index) => {
      if (item.symbol === "OTHER") {
        usedColors.add(normalizedHex(DEFAULT_OTHER_COLOR));
        return { ...item, color: DEFAULT_OTHER_COLOR };
      }

      let color = preferredAssetColor(item);
      let paletteIndex = symbolHash(item.symbol) + index;
      while (
        usedColors.has(normalizedHex(color)) &&
        paletteIndex <
          symbolHash(item.symbol) + index + DYNAMIC_ASSET_COLORS.length
      ) {
        color =
          DYNAMIC_ASSET_COLORS[paletteIndex % DYNAMIC_ASSET_COLORS.length];
        paletteIndex += 1;
      }
      usedColors.add(normalizedHex(color));
      return { ...item, color };
    });
  };

  if (sorted.length + (explicitOther ? 1 : 0) <= visibleLimit) {
    return assignDistinctColors(
      explicitOther ? [...sorted, explicitOther] : sorted
    );
  }

  const leading = sorted.slice(0, visibleLimit - 1);
  const rest = explicitOther
    ? [...sorted.slice(visibleLimit - 1), explicitOther]
    : sorted.slice(visibleLimit - 1);

  return assignDistinctColors([...leading, mergeItemValues(rest)]);
}

function assetDisplayName(item: AssetAllocationItem) {
  if (item.symbol === "OTHER") return "其他";
  return item.nameCn || item.name || item.symbol;
}

function changeTone(value?: string | null) {
  const number = parseNumber(value);
  if (number > 0) return "text-emerald-300";
  if (number < 0) return "text-rose-300";
  return "text-zinc-300";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function fittedCenterFontSize(
  text: string,
  availableWidth: number,
  preferredSize: number,
  minSize: number
) {
  const measuredTextWidth = Array.from(text).reduce((width, char) => {
    if (/[0-9]/.test(char)) return width + 0.64;
    if (/[.,%]/.test(char)) return width + 0.34;
    if (/\s/.test(char)) return width + 0.3;
    if (/[A-Z]/.test(char)) return width + 0.72;
    if (/[a-z]/.test(char)) return width + 0.58;
    return width + 0.88;
  }, 0);
  const estimatedMaxSize = availableWidth / Math.max(1, measuredTextWidth);
  return Math.floor(clamp(estimatedMaxSize, minSize, preferredSize));
}

export default function AssetAllocationDonutCard({
  title = "资产分布",
  totalValueUsd,
  items,
  maxVisibleItems = 8,
  selectedAsset = null,
  onSelectAsset,
  showFooterNote = true,
  cardWidth = 560,
  cardHeight = 310,
  borderRadius = 30,
  donutSize = 190,
  donutThickness = 44,
  glowIntensity = 0.68,
  dimInactiveOnFocus = true,
  compactMode = false,
}: AssetAllocationDonutCardProps) {
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  const [activePopupPlacement, setActivePopupPlacement] = useState<
    "above" | "below" | null
  >(null);
  const [renderedDonutSize, setRenderedDonutSize] = useState<number | null>(
    null
  );
  const [chartRenderKey, setChartRenderKey] = useState(0);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const chartFrameRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);
  const activePopupRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const resizeRafRef = useRef<number[]>([]);
  const resizeMismatchCountRef = useRef(0);
  const visibleItems = useMemo(
    () => normalizeItems(items, maxVisibleItems),
    [items, maxVisibleItems]
  );
  const activeSymbol = selectedAsset ?? hoveredSymbol;
  const activeItem =
    visibleItems.find((item) => item.symbol === activeSymbol) || null;
  const centerItem = activeItem || null;
  const glowAlpha = Math.max(0, Math.min(1, glowIntensity));
  const innerRadius = Math.max(42, 78 - donutThickness / 3.5);
  const smallLayout = compactMode || cardWidth <= 700 || cardHeight <= 380;
  const cardPadding = smallLayout ? 32 : 56;
  const gridGap = smallLayout ? 12 : 28;
  const headerReserve = smallLayout ? 28 : 44;
  const footerReserve = showFooterNote ? (smallLayout ? 18 : 26) : 0;
  const gridVerticalPadding = smallLayout ? 16 : 64;
  const listMinWidth = smallLayout ? 240 : 360;
  const innerCardWidth = Math.max(0, cardWidth - cardPadding);
  const maxDonutByWidth = smallLayout
    ? innerCardWidth - gridGap - listMinWidth
    : (innerCardWidth - gridGap) * 0.48;
  const maxDonutByHeight =
    cardHeight -
    cardPadding -
    headerReserve -
    footerReserve -
    gridVerticalPadding;
  const layoutMaxDonutSize = Math.round(
    clamp(
      Math.min(maxDonutByWidth, maxDonutByHeight, smallLayout ? 320 : 440),
      150,
      smallLayout ? 320 : 440
    )
  );
  const effectiveDonutSize = Math.round(
    clamp(donutSize, 150, layoutMaxDonutSize)
  );
  const syncedDonutSize = Math.round(
    clamp(renderedDonutSize || effectiveDonutSize, 120, smallLayout ? 320 : 440)
  );
  const centerHoleSize = syncedDonutSize * (innerRadius / 100);
  const centerContentSize = Math.floor(centerHoleSize * 0.88);
  const centerSafeWidth = centerContentSize * 0.92;
  const centerPrimaryText = centerItem
    ? formatPercent(centerItem.percentage)
    : formatMoney(totalValueUsd);
  const centerMetaText = centerItem
    ? `${formatMoney(centerItem.valueUsd)} USD`
    : "USD";
  const centerPrimaryFontSize = fittedCenterFontSize(
    centerPrimaryText,
    centerSafeWidth,
    centerItem ? (smallLayout ? 26 : 44) : smallLayout ? 24 : 58,
    centerItem ? (smallLayout ? 18 : 28) : smallLayout ? 15 : 24
  );
  const centerLabelFontSize = Math.round(
    clamp(centerContentSize * 0.085, 9, smallLayout ? 10 : 16)
  );
  const centerMetaFontSize = fittedCenterFontSize(
    centerMetaText,
    centerSafeWidth,
    centerItem ? (smallLayout ? 10 : 14) : smallLayout ? 12 : 24,
    9
  );
  const centerTextGap = Math.round(clamp(centerContentSize * 0.055, 4, 10));
  const popupWidth = Math.round(
    clamp(cardWidth * (smallLayout ? 0.36 : 0.3), 150, 280)
  );
  const popupScale = clamp(popupWidth / 220, 0.68, 1.14);
  const popupGap = Math.round(clamp(8 * popupScale, 6, 10));
  const showDetailPopup = Boolean(activeItem);

  const reapplyChartHighlight = useCallback(
    (chart?: any) => {
      const targetChart = chart ?? chartRef.current?.getEchartsInstance?.();
      if (!targetChart) return;

      targetChart.dispatchAction({
        type: "downplay",
        seriesIndex: 0,
      });

      if (!activeSymbol) return;
      const activeIndex = visibleItems.findIndex(
        (item) => item.symbol === activeSymbol
      );
      if (activeIndex < 0) return;

      targetChart.dispatchAction({
        type: "highlight",
        seriesIndex: 0,
        dataIndex: activeIndex,
      });
    },
    [activeSymbol, visibleItems]
  );

  const resizeChart = useCallback(() => {
    const chart = chartRef.current?.getEchartsInstance?.();
    if (!chart) return false;

    chart.resize({
      width: effectiveDonutSize,
      height: effectiveDonutSize,
      silent: true,
    });

    const chartWidth = Math.round(chart.getWidth?.() || effectiveDonutSize);
    const chartHeight = Math.round(chart.getHeight?.() || effectiveDonutSize);
    const nextRenderedSize = Math.max(1, Math.min(chartWidth, chartHeight));
    setRenderedDonutSize((current) =>
      current === nextRenderedSize ? current : nextRenderedSize
    );

    reapplyChartHighlight(chart);

    const isMismatched = Math.abs(nextRenderedSize - effectiveDonutSize) > 2;
    if (!isMismatched) resizeMismatchCountRef.current = 0;
    return isMismatched;
  }, [effectiveDonutSize, reapplyChartHighlight]);

  const cancelScheduledChartResize = useCallback(() => {
    if (typeof window === "undefined") return;
    for (const frame of resizeRafRef.current) {
      window.cancelAnimationFrame(frame);
    }
    resizeRafRef.current = [];
  }, []);

  const scheduleChartResize = useCallback(
    (attempts = 3) => {
      if (typeof window === "undefined") return;
      cancelScheduledChartResize();

      const runResize = (remainingAttempts: number) => {
        const frame = window.requestAnimationFrame(() => {
          const isMismatched = resizeChart();
          if (remainingAttempts > 1) {
            runResize(remainingAttempts - 1);
            return;
          }

          if (isMismatched) {
            resizeMismatchCountRef.current += 1;
            if (resizeMismatchCountRef.current >= 2) {
              resizeMismatchCountRef.current = 0;
              setChartRenderKey((current) => current + 1);
            }
          }
          resizeRafRef.current = [];
        });
        resizeRafRef.current = [...resizeRafRef.current, frame];
      };

      runResize(Math.max(1, attempts));
    },
    [cancelScheduledChartResize, resizeChart]
  );

  useLayoutEffect(() => {
    if (!activeSymbol) {
      setActivePopupPlacement(null);
      return;
    }

    const card = cardRef.current;
    const row = rowRefs.current.get(activeSymbol);
    const popup = activePopupRef.current;
    if (!card || !row || !popup) return;

    const cardRect = card.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const activeIndex = visibleItems.findIndex(
      (item) => item.symbol === activeSymbol
    );
    const defaultPlacement: "above" | "below" =
      activeIndex === 0 ? "below" : "above";
    const safeInset = 8;
    const wouldOverflowTop =
      rowRect.top - popupRect.height - popupGap < cardRect.top + safeInset;
    const wouldOverflowBottom =
      rowRect.bottom + popupRect.height + popupGap >
      cardRect.bottom - safeInset;

    let nextPlacement: "above" | "below" = defaultPlacement;
    if (defaultPlacement === "above" && wouldOverflowTop) {
      nextPlacement = "below";
    } else if (
      defaultPlacement === "below" &&
      wouldOverflowBottom &&
      !wouldOverflowTop
    ) {
      nextPlacement = "above";
    }

    setActivePopupPlacement((current) =>
      current === nextPlacement ? current : nextPlacement
    );
  }, [activeSymbol, cardHeight, cardWidth, popupGap, popupWidth, visibleItems]);

  useEffect(() => {
    reapplyChartHighlight();
  }, [reapplyChartHighlight]);

  useLayoutEffect(() => {
    resizeChart();
  }, [
    chartRenderKey,
    effectiveDonutSize,
    innerRadius,
    resizeChart,
    visibleItems.length,
  ]);

  useEffect(() => {
    scheduleChartResize(4);
  }, [
    chartRenderKey,
    effectiveDonutSize,
    innerRadius,
    scheduleChartResize,
    visibleItems.length,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(query.matches);
    updatePreference();

    if (query.addEventListener) {
      query.addEventListener("change", updatePreference);
      return () => query.removeEventListener("change", updatePreference);
    }

    query.addListener(updatePreference);
    return () => query.removeListener(updatePreference);
  }, []);

  useEffect(() => {
    const frame = chartFrameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(() => {
      scheduleChartResize();
    });
    observer.observe(frame);

    return () => {
      observer.disconnect();
    };
  }, [scheduleChartResize]);

  useEffect(() => {
    return () => {
      cancelScheduledChartResize();
    };
  }, [cancelScheduledChartResize]);

  const option = useMemo<EChartsOption>(
    () => ({
      backgroundColor: "transparent",
      animationDuration: 450,
      animationDurationUpdate: 320,
      animationEasingUpdate: "cubicOut",
      stateAnimation: {
        duration: 320,
        easing: "cubicOut",
      },
      tooltip: {
        show: false,
      },
      series: [
        {
          type: "pie",
          radius: [`${innerRadius}%`, "78%"],
          center: ["50%", "50%"],
          avoidLabelOverlap: true,
          minAngle: 3,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: {
            borderColor: "#050505",
            borderWidth: compactMode ? 4 : 6,
            borderRadius: compactMode ? 4 : 8,
          },
          emphasis: {
            scale: true,
            scaleSize: 8,
            itemStyle: {
              shadowBlur: 22,
              shadowColor: "rgba(255,255,255,0.16)",
            },
          },
          blur: {
            itemStyle: {
              opacity: dimInactiveOnFocus ? 0.36 : 1,
            },
          },
          data: visibleItems.map((item) => {
            const active = activeSymbol === item.symbol;
            const muted = Boolean(
              dimInactiveOnFocus && activeSymbol && !active
            );
            return {
              name: item.symbol,
              value: parseNumber(item.valueUsd),
              raw: item,
              itemStyle: {
                color: item.color,
                opacity: muted ? 0.38 : 1,
                shadowBlur: active ? 24 : 0,
                shadowColor: active ? rgba(item.color, 0.55) : "transparent",
              },
            };
          }),
        },
      ],
    }),
    [activeSymbol, compactMode, dimInactiveOnFocus, innerRadius, visibleItems]
  );

  const chartEvents = useMemo(
    () => ({
      mouseover: (params: any) => {
        const item = params.data?.raw as AssetAllocationItem | undefined;
        if (item) {
          setHoveredSymbol(item.symbol);
        }
      },
      mouseout: () => {
        setHoveredSymbol(null);
      },
      click: (params: any) => {
        const item = params.data?.raw as AssetAllocationItem | undefined;
        if (!item) return;
        onSelectAsset?.(selectedAsset === item.symbol ? null : item.symbol);
      },
    }),
    [onSelectAsset, selectedAsset]
  );

  function clearSelection() {
    onSelectAsset?.(null);
    setHoveredSymbol(null);
    setActivePopupPlacement(null);
  }

  useEffect(() => {
    if (!activeSymbol) return;

    function clearWhenPointerLeavesCard(event: MouseEvent | PointerEvent) {
      const card = cardRef.current;
      if (!card) return;

      const target = event.target as Node | null;
      if (target && card.contains(target)) return;

      const rect = card.getBoundingClientRect();
      const isInsideCard =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;

      if (isInsideCard) return;
      onSelectAsset?.(null);
      setHoveredSymbol(null);
      setActivePopupPlacement(null);
    }

    window.addEventListener("mousemove", clearWhenPointerLeavesCard, true);
    window.addEventListener("pointermove", clearWhenPointerLeavesCard, true);

    return () => {
      window.removeEventListener("mousemove", clearWhenPointerLeavesCard, true);
      window.removeEventListener(
        "pointermove",
        clearWhenPointerLeavesCard,
        true
      );
    };
  }, [activeSymbol, onSelectAsset]);

  function toggleAsset(symbol: string) {
    onSelectAsset?.(selectedAsset === symbol ? null : symbol);
  }

  return (
    <div
      ref={cardRef}
      className="relative overflow-hidden border bg-[#050505] text-[#F8FAFC] shadow-[0_26px_90px_rgb(0_0_0_/_0.42)]"
      style={{
        width: `min(100%, ${cardWidth}px)`,
        height: cardHeight,
        borderRadius,
        borderColor: "rgba(255,255,255,0.10)",
        boxShadow: `0 26px 90px rgba(0,0,0,.42), 0 0 ${56 * glowAlpha}px rgba(22,131,255,${0.16 * glowAlpha})`,
      }}
      onClick={clearSelection}
      onMouseLeave={clearSelection}
      onPointerLeave={clearSelection}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_24%_22%,rgba(22,131,255,0.12),transparent_30%),radial-gradient(circle_at_80%_34%,rgba(168,85,247,0.10),transparent_28%)]" />
      <div
        className={[
          "relative z-[1] flex h-full flex-col",
          smallLayout ? "p-4" : "p-5 md:p-7",
        ].join(" ")}
      >
        <div className="flex items-start">
          <h3
            className={[
              "ml-1 font-black leading-none tracking-normal",
              smallLayout
                ? "text-[20px] md:text-[24px]"
                : "text-[28px] md:text-[34px]",
            ].join(" ")}
          >
            {title}
          </h3>
        </div>

        <div
          className={[
            "grid flex-1 items-center",
            smallLayout
              ? "gap-3 py-2"
              : "gap-7 py-8 lg:grid-cols-[minmax(280px,0.92fr)_minmax(360px,1fr)]",
          ].join(" ")}
          style={
            smallLayout
              ? {
                  gridTemplateColumns: `${effectiveDonutSize + 8}px minmax(0, 1fr)`,
                }
              : undefined
          }
        >
          <div
            className="relative mx-auto flex w-full items-center justify-center"
            style={{ maxWidth: effectiveDonutSize + 8 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              ref={chartFrameRef}
              className="relative"
              style={{
                width: effectiveDonutSize,
                height: effectiveDonutSize,
              }}
            >
              <div
                className="absolute left-0 top-0"
                style={{
                  width: effectiveDonutSize,
                  height: effectiveDonutSize,
                  transform: activeSymbol ? "scale(1.012)" : "scale(1)",
                  transformOrigin: "50% 50%",
                  transition: prefersReducedMotion
                    ? "none"
                    : "transform 360ms cubic-bezier(0.2, 0.9, 0.2, 1.15)",
                  willChange: "transform",
                }}
              >
                <ReactECharts
                  key={chartRenderKey}
                  ref={chartRef}
                  option={option}
                  notMerge={false}
                  lazyUpdate={false}
                  onEvents={chartEvents}
                  style={{
                    width: effectiveDonutSize,
                    height: effectiveDonutSize,
                  }}
                />
              </div>
              <div
                className="pointer-events-none absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center overflow-hidden rounded-full text-center"
                style={{
                  width: centerContentSize,
                  height: centerContentSize,
                }}
              >
                {centerItem ? (
                  <div
                    className="flex h-full w-full min-w-0 flex-col items-center justify-center"
                    style={{ gap: centerTextGap }}
                  >
                    <div
                      className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-black text-[#A1A1AA]"
                      style={{
                        color: centerItem.color,
                        fontSize: centerLabelFontSize,
                        lineHeight: 1,
                      }}
                    >
                      {centerItem.symbol}
                    </div>
                    <AutoFitNumericText
                      containerClassName="w-full text-center"
                      className="font-black"
                      style={{
                        fontSize: centerPrimaryFontSize,
                        fontVariantNumeric: "tabular-nums",
                        lineHeight: 1,
                      }}
                    >
                      {centerPrimaryText}
                    </AutoFitNumericText>
                    <AutoFitNumericText
                      containerClassName="w-full text-center"
                      className="font-bold text-[#A1A1AA]"
                      style={{
                        fontSize: centerMetaFontSize,
                        fontVariantNumeric: "tabular-nums",
                        lineHeight: 1.1,
                      }}
                    >
                      {centerMetaText}
                    </AutoFitNumericText>
                  </div>
                ) : (
                  <div
                    className="flex h-full w-full min-w-0 flex-col items-center justify-center"
                    style={{ gap: centerTextGap }}
                  >
                    <div
                      className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-black text-[#A1A1AA]"
                      style={{
                        fontSize: centerLabelFontSize,
                        lineHeight: 1,
                      }}
                    >
                      总资产价值
                    </div>
                    <AutoFitNumericText
                      containerClassName="w-full text-center"
                      className="font-black"
                      style={{
                        fontSize: centerPrimaryFontSize,
                        fontVariantNumeric: "tabular-nums",
                        lineHeight: 1,
                      }}
                    >
                      {centerPrimaryText}
                    </AutoFitNumericText>
                    <div
                      className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-black text-[#A1A1AA]"
                      style={{
                        fontSize: centerMetaFontSize,
                        lineHeight: 1,
                      }}
                    >
                      {centerMetaText}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div
            className="relative min-w-0"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="grid gap-0">
              {visibleItems.map((item, index) => {
                const active = activeSymbol === item.symbol;
                const muted = Boolean(
                  dimInactiveOnFocus && activeSymbol && !active
                );
                const popupPlacement =
                  active && activePopupPlacement
                    ? activePopupPlacement
                    : index === 0
                      ? "below"
                      : "above";
                return (
                  <div
                    key={item.symbol}
                    ref={(element) => {
                      if (element) rowRefs.current.set(item.symbol, element);
                      else rowRefs.current.delete(item.symbol);
                    }}
                    className="relative"
                  >
                    {showDetailPopup && active ? (
                      <div
                        ref={activePopupRef}
                        className={[
                          "pointer-events-none absolute right-0 z-20 hidden border border-white/10 bg-[#08090B]/95 font-bold text-white shadow-[0_18px_42px_rgb(0_0_0_/_0.48)] backdrop-blur-xl xl:block",
                          popupPlacement === "below"
                            ? "top-full"
                            : "bottom-full",
                        ].join(" ")}
                        style={{
                          width: popupWidth,
                          padding: Math.round(12 * popupScale),
                          fontSize: Math.max(10, Math.round(12 * popupScale)),
                          borderRadius: Math.round(18 * popupScale),
                          color: "#FFFFFF",
                          [popupPlacement === "below"
                            ? "marginTop"
                            : "marginBottom"]: popupGap,
                        }}
                      >
                        <div
                          className="mb-2 flex items-center gap-2"
                          style={{
                            fontSize: Math.max(11, Math.round(14 * popupScale)),
                          }}
                        >
                          <span
                            className="rounded-full"
                            style={{
                              width: Math.round(10 * popupScale),
                              height: Math.round(10 * popupScale),
                              backgroundColor: item.color,
                            }}
                          />
                          <span>{item.symbol}</span>
                          <span style={{ color: "#FFFFFF" }}>
                            {assetDisplayName(item)}
                          </span>
                        </div>
                        <div
                          className="grid gap-1"
                          style={{ color: "#FFFFFF" }}
                        >
                          <span>占比：{formatPercent(item.percentage)}</span>
                          <span>
                            资产价值：{formatMoney(item.valueUsd)} USD
                          </span>
                          {item.amount ? (
                            <span>
                              数量：{formatCompact(item.amount)} {item.symbol}
                            </span>
                          ) : null}
                          {item.change24hPct !== undefined &&
                          item.change24hPct !== null ? (
                            <span className={changeTone(item.change24hPct)}>
                              24H 涨跌：
                              {parseNumber(item.change24hPct) >= 0 ? "+" : ""}
                              {formatPercent(item.change24hPct)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    <button
                      type="button"
                      className={[
                        "grid w-full items-center border-b text-left transition last:border-b-0",
                        smallLayout
                          ? "h-[34px] grid-cols-[minmax(54px,1fr)_50px_minmax(82px,1.15fr)] gap-2 px-2"
                          : "h-[58px] grid-cols-[minmax(96px,1fr)_96px_minmax(132px,1fr)] gap-3 px-3 md:h-[66px] md:px-4",
                        active ? "bg-white/[.075]" : "hover:bg-white/[.045]",
                      ].join(" ")}
                      style={{
                        borderColor: "rgba(255,255,255,0.08)",
                        opacity: muted ? 0.48 : 1,
                      }}
                      onMouseEnter={() => {
                        setHoveredSymbol(item.symbol);
                      }}
                      onMouseLeave={() => {
                        setHoveredSymbol(null);
                      }}
                      onClick={() => toggleAsset(item.symbol)}
                    >
                      <span
                        className={[
                          "flex min-w-0 items-center",
                          smallLayout ? "gap-2" : "gap-4",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "shrink-0 rounded-full shadow-[0_0_18px_currentColor]",
                            smallLayout ? "h-2 w-2" : "h-3 w-3",
                          ].join(" ")}
                          style={{
                            color: item.color,
                            backgroundColor: item.color,
                          }}
                        />
                        <span
                          className={[
                            "truncate font-bold",
                            smallLayout
                              ? "text-[14px]"
                              : "text-xl md:text-[26px]",
                          ].join(" ")}
                        >
                          {item.symbol === "OTHER" ? "其他" : item.symbol}
                        </span>
                      </span>
                      <span
                        className={[
                          "text-right font-bold",
                          smallLayout
                            ? "text-[13px]"
                            : "text-lg md:text-[24px]",
                        ].join(" ")}
                      >
                        {formatPercent(item.percentage)}
                      </span>
                      <AutoFitNumericText
                        containerClassName="w-full text-right"
                        className={[
                          "font-bold",
                          smallLayout
                            ? "text-[13px]"
                            : "text-lg md:text-[24px]",
                        ].join(" ")}
                      >
                        {formatMoney(item.valueUsd)} USD
                      </AutoFitNumericText>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {showFooterNote ? (
          <div
            className={[
              "text-center font-bold text-[#A1A1AA]",
              smallLayout ? "text-[11px]" : "text-base",
            ].join(" ")}
          >
            * 数据统计时间以 UTC+0 为准
          </div>
        ) : null}
      </div>
    </div>
  );
}
