import React from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  ArrowsClockwise,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  ChartLineUp,
  Check,
  Coins,
  Copy,
  CurrencyCircleDollar,
  DownloadSimple,
  MinusCircle,
  PlusCircle,
  Receipt,
  Repeat,
  Target,
  TrendUp,
} from "@phosphor-icons/react";
import { tradingPairMockPresets } from "./tradingPairMockPresets";
import type {
  TradeActionType,
  TradeMarketType,
  TradeRecordItem,
  TradeRecordsActionHighlight,
  TradeRecordsTableProps,
} from "./tradeRecordsTypes";

type PhosphorIcon = React.ComponentType<{
  className?: string;
  weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
}>;

const NUMBER_TEXT = "font-black tabular-nums lining-nums";
const HEAD_CELL = "px-4 py-3 text-left";
const BODY_CELL = "px-4 py-3 text-left align-middle";
const PAGE_SIZE_OPTIONS = [5, 10];

const actionMeta: Record<
  TradeActionType,
  {
    label: string;
    color: string;
    Icon: PhosphorIcon;
  }
> = {
  spot_buy: { label: "买入", color: "#3B82F6", Icon: PlusCircle },
  spot_sell: { label: "卖出", color: "#60A5FA", Icon: MinusCircle },
  futures_open_long: { label: "开多", color: "#22C55E", Icon: ArrowUpRight },
  futures_close_long: { label: "平多", color: "#10B981", Icon: ArrowDownRight },
  futures_open_short: { label: "开空", color: "#EF4444", Icon: ArrowDownRight },
  futures_close_short: { label: "平空", color: "#F97316", Icon: ArrowUpRight },
};

const typeOptions: Array<{ value: TradeActionType | "all"; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "spot_buy", label: "买入" },
  { value: "spot_sell", label: "卖出" },
  { value: "futures_open_long", label: "开多" },
  { value: "futures_close_long", label: "平多" },
  { value: "futures_open_short", label: "开空" },
  { value: "futures_close_short", label: "平空" },
];

function parseNumber(value?: string | null) {
  const number = Number(String(value || "0").replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function formatMoney(value?: string | number | null, digits = 2) {
  const number = typeof value === "number" ? value : parseNumber(value);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(number);
}

function hasPositiveAmount(value?: string | null) {
  return parseNumber(value) > 0;
}

function formatFeeUsd(record: TradeRecordItem) {
  const feeUsd = parseNumber(record.feeUsd);
  const hasUnpricedFee =
    (record.feeSource === "point" &&
      hasPositiveAmount(record.pointFeeAmount)) ||
    (record.feeSource === "gt" &&
      hasPositiveAmount(record.gtFeeAmount) &&
      feeUsd <= 0) ||
    (record.feeSource === "asset" &&
      hasPositiveAmount(record.feeAmount) &&
      feeUsd <= 0);

  if (hasUnpricedFee) return "-- USD";
  return `${formatMoney(record.feeUsd, 4)} USD`;
}

function formatFeeSource(record: TradeRecordItem) {
  if (
    record.feeSource === "unknown" ||
    record.feeDisplayCurrency === "多来源"
  ) {
    return "多来源";
  }
  if (record.feeSource === "point") {
    return `点卡抵扣 ${record.feeDisplayAmount || record.pointFeeAmount || "0"}`;
  }
  if (record.feeSource === "gt") {
    return "GT抵扣";
  }
  return `${record.feeDisplayAmount || record.feeAmount || record.feeUsd} ${
    record.feeDisplayCurrency || record.feeCurrency || "USD"
  }`;
}

function formatSignedMoney(value?: string | number | null) {
  if (value === null || value === undefined) return "--";
  const number = typeof value === "number" ? value : parseNumber(value);
  const prefix = number > 0 ? "+" : number < 0 ? "-" : "";
  return `${prefix}${formatMoney(Math.abs(number))}`;
}

function formatPercent(value?: string | number | null) {
  if (value === null || value === undefined) return null;
  const number = typeof value === "number" ? value : parseNumber(value);
  return `${formatMoney(number)}%`;
}

function pnlTone(value?: string | number | null) {
  if (value === null || value === undefined) return "!text-[#A1A1AA]";
  const number = typeof value === "number" ? value : parseNumber(value);
  if (number > 0) return "text-[#22C55E]";
  if (number < 0) return "text-[#EF4444]";
  return "!text-white";
}

function contractTypeLabel(type?: TradeRecordItem["contractType"]) {
  if (type === "perpetual") return "永续";
  if (type === "delivery") return "交割";
  return "现货";
}

function formatTime(ts: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

function recordKey(record: TradeRecordItem) {
  return `${record.marketType}:${record.id}:${record.orderId}`;
}

function contractKeyForRecord(record: TradeRecordItem) {
  if (record.marketType !== "futures") return null;
  return `futures:${record.symbol}:${record.contractType || "perpetual"}`;
}

function highlightRoleForRecord(
  record: TradeRecordItem,
  actionHighlight?: TradeRecordsActionHighlight
) {
  if (!actionHighlight) return "none";
  const currentRecordKey = recordKey(record);
  if (currentRecordKey === actionHighlight.sourceRecordKey) return "source";
  if (actionHighlight.relatedRecordKeys?.includes(currentRecordKey)) {
    return "related";
  }
  if (actionHighlight.cycleId) {
    if (record.cycleId !== actionHighlight.cycleId) return "none";
    return "related";
  }
  if (contractKeyForRecord(record) !== actionHighlight.contractKey)
    return "none";
  if (record.action === actionHighlight.relatedAction) return "related";
  return "none";
}

function assetPreset(baseAsset: string) {
  const normalized = baseAsset.trim().toUpperCase();
  return tradingPairMockPresets.find(
    (preset) => preset.baseAsset.trim().toUpperCase() === normalized
  );
}

function AssetIcon({ record }: { record: TradeRecordItem }) {
  const preset = assetPreset(record.baseAsset);
  const iconUrl = record.iconUrl || preset?.iconImage;
  const fallback = record.baseAsset.trim().slice(0, 1).toUpperCase() || "?";

  return (
    <div className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[.08] text-[11px] font-black !text-white shadow-[0_0_18px_rgb(255_255_255_/_0.08)]">
      <span>{fallback}</span>
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : null}
    </div>
  );
}

function MarketBadge({ marketType }: { marketType: TradeMarketType }) {
  const isSpot = marketType === "spot";
  const Icon = isSpot ? Coins : ChartLineUp;
  return (
    <div
      className="inline-flex min-w-[64px] items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-black"
      style={{
        color: isSpot ? "#3B82F6" : "#D6A84F",
        borderColor: isSpot ? "rgba(59,130,246,0.28)" : "rgba(214,168,79,0.28)",
        backgroundColor: isSpot
          ? "rgba(59,130,246,0.10)"
          : "rgba(214,168,79,0.10)",
      }}
    >
      <Icon className="h-3.5 w-3.5" weight="bold" />
      {isSpot ? "现货" : "合约"}
    </div>
  );
}

function ActionLabel({
  action,
  highlightRole = "none",
  onClick,
  onDoubleClick,
}: {
  action: TradeActionType;
  highlightRole?: "source" | "related" | "none";
  onClick?: () => void;
  onDoubleClick?: () => void;
}) {
  const meta = actionMeta[action];
  const Icon = meta.Icon;
  const isClickable = Boolean(onClick);
  const isSource = highlightRole === "source";
  const isRelated = highlightRole === "related";
  const isHighlighted = isSource || isRelated;
  const opacityClass = isSource
    ? "opacity-100"
    : isRelated
      ? "opacity-95"
      : "opacity-90 group-hover:opacity-100";
  const content = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" weight="regular" />
      <span className="whitespace-nowrap">{meta.label}</span>
    </>
  );
  const baseClassName = [
    "inline-flex min-w-[58px] items-center gap-1.5 text-[15px] font-black leading-5 transition",
    opacityClass,
  ].join(" ");

  if (!isClickable) {
    return (
      <div className={baseClassName} style={{ color: meta.color }}>
        {content}
      </div>
    );
  }

  const capsuleClassName = [
    baseClassName,
    "rounded-xl border px-2 py-1 outline-none",
    "hover:opacity-100 focus:opacity-100",
  ].join(" ");
  const capsuleStyle = {
    color: isHighlighted ? "#F8D77A" : meta.color,
    borderColor: isSource
      ? "rgba(248,215,122,0.92)"
      : isRelated
        ? "rgba(248,215,122,0.58)"
        : "rgba(255,255,255,0.08)",
    backgroundColor: isSource
      ? "rgba(214,168,79,0.28)"
      : isRelated
        ? "rgba(214,168,79,0.16)"
        : "rgba(255,255,255,0.025)",
    boxShadow: isSource
      ? "0 0 26px rgba(214,168,79,0.42), inset 0 0 18px rgba(248,215,122,0.12)"
      : isRelated
        ? "0 0 18px rgba(214,168,79,0.24), inset 0 0 14px rgba(248,215,122,0.08)"
        : "none",
  };

  return (
    <button
      type="button"
      aria-pressed={isSource}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={capsuleClassName}
      style={capsuleStyle}
    >
      {content}
    </button>
  );
}

function SelectControl<T extends string>({
  value,
  onChange,
  children,
  ariaLabel,
}: {
  value: T;
  onChange?: (value: T) => void;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange?.(event.target.value as T)}
      className="h-9 rounded-xl border border-white/10 bg-[#08090B] px-3 text-xs font-bold !text-white/75 outline-none transition hover:bg-white/[.07] focus:border-[#D6A84F]/45"
    >
      {children}
    </select>
  );
}

function KpiBlock({
  label,
  value,
  tone = "!text-white",
  Icon,
  className = "",
  valueClassName = "",
}: {
  label: string;
  value: string;
  tone?: string;
  Icon: PhosphorIcon;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div
      className={`min-w-0 rounded-2xl border border-white/10 bg-white/[.035] px-3 py-3 ${className}`}
    >
      <div className="flex items-center gap-2 text-xs font-bold !text-[#A1A1AA]">
        <Icon className="h-4 w-4 shrink-0" weight="regular" />
        <span className="truncate">{label}</span>
      </div>
      <div
        className={`mt-2 min-h-[22px] whitespace-nowrap text-[15px] ${NUMBER_TEXT} ${tone} ${valueClassName}`}
      >
        {value}
      </div>
    </div>
  );
}

function LoadingAnimationPanel() {
  return (
    <div className="rounded-2xl border border-white/[.08] bg-black/25 px-4 py-3">
      <div className="flex items-center gap-4">
        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/10 bg-[#050505]">
          <div className="absolute inset-1 rounded-full border border-[#3B82F6]/20" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#22C55E] border-r-[#3B82F6] animate-spin" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#22C55E] shadow-[0_0_18px_rgb(34_197_94_/_0.85)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-black !text-white">
                正在加载交易明细
              </div>
              <div className="mt-1 text-xs font-bold !text-[#A1A1AA]">
                同步现货 + 合约订单级记录
              </div>
            </div>
            <div className="hidden items-end gap-1 sm:flex">
              {[0, 1, 2, 3, 4].map((index) => (
                <span
                  key={index}
                  className="block w-1.5 rounded-full bg-[#22C55E]/70 shadow-[0_0_12px_rgb(34_197_94_/_0.45)]"
                  style={{
                    height: `${10 + index * 4}px`,
                    animation: "pulse 1.15s ease-in-out infinite",
                    animationDelay: `${index * 120}ms`,
                  }}
                />
              ))}
            </div>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[.06]">
            <div className="h-full w-1/2 animate-[pulse_1.15s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-[#3B82F6] via-[#22C55E] to-[#D6A84F]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <tr key={index} className="border-b border-white/[.07]">
          {Array.from({ length: 10 }).map((__, cellIndex) => (
            <td key={cellIndex} className="px-4 py-4">
              <div className="h-3 w-full animate-pulse rounded-full bg-white/10" />
              <div className="mt-2 h-2 w-2/3 animate-pulse rounded-full bg-white/[.06]" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export default function TradeRecordsTable({
  records,
  summary,
  loading = false,
  error = null,
  page = 1,
  pageSize = 10,
  totalCount,
  cardWidth = 980,
  cardHeight = 680,
  borderRadius = 28,
  compactMode = false,
  hasMoreHistory = false,
  lastUpdatedAt = null,
  connectionStatus = "connected",
  marketFilter = "all",
  typeFilter = "all",
  directionFilter = "all",
  contractFilter = "all",
  availableContracts = [],
  timeRangeLabel = "近30天",
  copiedOrderId = null,
  actionHighlight = null,
  jumpTargetRecordKey = null,
  onMarketFilterChange,
  onTypeFilterChange,
  onDirectionFilterChange,
  onContractFilterChange,
  onPageChange,
  onPageSizeChange,
  onRefresh,
  onExportCsv,
  onOrderIdCopy,
  onTimeRangeClick,
  onActionHighlightToggle,
  onActionJump,
}: TradeRecordsTableProps) {
  const rowRefs = React.useRef<Record<string, HTMLTableRowElement | null>>({});
  const tableViewportRef = React.useRef<HTMLDivElement | null>(null);
  const scrollSnapshotRef = React.useRef({
    page,
    pageSize,
    scrollTop: 0,
    scrollLeft: 0,
  });
  const previousConnectionStatusRef =
    React.useRef<TradeRecordsTableProps["connectionStatus"]>(connectionStatus);
  const shouldRestoreScrollRef = React.useRef(false);
  const safePageSize = PAGE_SIZE_OPTIONS.includes(pageSize) ? pageSize : 10;
  const loadedTotal = totalCount ?? records.length;
  const pageCount = Math.max(
    1,
    Math.ceil(Math.max(loadedTotal, 1) / safePageSize)
  );
  const canPrev = page > 1;
  const canNext = page < pageCount || hasMoreHistory;
  const tableMaxHeight = compactMode ? 360 : Math.max(360, cardHeight - 290);
  const hasCachedError = Boolean(error && records.length > 0);
  const hasBlockingError = Boolean(error && records.length === 0);

  const rememberScrollPosition = React.useCallback(() => {
    const viewport = tableViewportRef.current;
    if (!viewport) return;
    scrollSnapshotRef.current = {
      page,
      pageSize,
      scrollTop: viewport.scrollTop,
      scrollLeft: viewport.scrollLeft,
    };
  }, [page, pageSize]);

  React.useEffect(() => {
    if (!jumpTargetRecordKey) return;
    const target =
      rowRefs.current[jumpTargetRecordKey] ||
      document.querySelector<HTMLTableRowElement>(
        `[data-record-key="${CSS.escape(jumpTargetRecordKey)}"]`
      );
    if (!target) return;
    window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [jumpTargetRecordKey, records]);

  React.useEffect(() => {
    scrollSnapshotRef.current = {
      ...scrollSnapshotRef.current,
      page,
      pageSize,
    };
  }, [page, pageSize]);

  React.useEffect(() => {
    const previous = previousConnectionStatusRef.current;
    if (connectionStatus !== "connected") {
      rememberScrollPosition();
      shouldRestoreScrollRef.current = true;
    }

    if (
      previous !== "connected" &&
      connectionStatus === "connected" &&
      shouldRestoreScrollRef.current
    ) {
      const snapshot = scrollSnapshotRef.current;
      window.requestAnimationFrame(() => {
        const viewport = tableViewportRef.current;
        if (
          !viewport ||
          snapshot.page !== page ||
          snapshot.pageSize !== pageSize
        )
          return;
        viewport.scrollTop = snapshot.scrollTop;
        viewport.scrollLeft = snapshot.scrollLeft;
        shouldRestoreScrollRef.current = false;
      });
    }

    previousConnectionStatusRef.current = connectionStatus;
  }, [connectionStatus, page, pageSize, rememberScrollPosition]);

  React.useEffect(() => {
    if (!shouldRestoreScrollRef.current) return;
    const snapshot = scrollSnapshotRef.current;
    window.requestAnimationFrame(() => {
      const viewport = tableViewportRef.current;
      if (!viewport || snapshot.page !== page || snapshot.pageSize !== pageSize)
        return;
      viewport.scrollTop = snapshot.scrollTop;
      viewport.scrollLeft = snapshot.scrollLeft;
    });
  }, [records, page, pageSize]);

  return (
    <div
      className="relative flex w-full max-w-full flex-col overflow-hidden border !text-white shadow-[0_28px_80px_rgb(0_0_0_/_0.35)]"
      style={{
        width: cardWidth,
        minHeight: cardHeight,
        borderRadius,
        borderColor: "rgba(255,255,255,0.10)",
        background:
          "radial-gradient(circle at 18% 18%, rgba(59,130,246,0.14), transparent 30%), linear-gradient(135deg, #08090B 0%, #050505 62%, #08090B 100%)",
      }}
    >
      <div className="flex shrink-0 flex-col gap-4 px-5 pb-4 pt-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h3 className="text-[22px] font-black leading-7 !text-white">
              交易明细
            </h3>
            <div className="mt-1 text-[13px] font-bold !text-[#A1A1AA]">
              全部成交记录（现货 + 合约）
              {lastUpdatedAt ? (
                <span className="ml-2 !text-white/35">
                  {new Date(lastUpdatedAt).toLocaleTimeString()}
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onTimeRangeClick}
              className="flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/[.05] px-3 text-xs font-bold !text-white/75 transition hover:bg-white/[.09]"
            >
              <CalendarBlank className="h-4 w-4" weight="bold" />
              {timeRangeLabel}
            </button>
            <SelectControl
              ariaLabel="市场筛选"
              value={marketFilter}
              onChange={onMarketFilterChange}
            >
              <option value="all">全部市场</option>
              <option value="spot">现货</option>
              <option value="futures">合约</option>
            </SelectControl>
            <SelectControl
              ariaLabel="合约筛选"
              value={contractFilter}
              onChange={onContractFilterChange}
            >
              <option value="all">全部合约</option>
              {availableContracts.map((contract) => (
                <option key={contract} value={contract}>
                  {contract}
                </option>
              ))}
            </SelectControl>
            <SelectControl
              ariaLabel="类型筛选"
              value={typeFilter}
              onChange={onTypeFilterChange}
            >
              {typeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectControl>
            <SelectControl
              ariaLabel="方向筛选"
              value={directionFilter}
              onChange={onDirectionFilterChange}
            >
              <option value="all">全部方向</option>
              <option value="long">多</option>
              <option value="short">空</option>
              <option value="spot">现货</option>
            </SelectControl>
            <button
              type="button"
              aria-label="刷新交易明细"
              onClick={onRefresh}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[.05] !text-white/70 transition hover:bg-white/[.09] hover:!text-white"
            >
              <ArrowsClockwise className="h-4 w-4" weight="bold" />
            </button>
            <button
              type="button"
              aria-label="导出 CSV"
              onClick={onExportCsv}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[.05] !text-white/70 transition hover:bg-white/[.09] hover:!text-white"
            >
              <DownloadSimple className="h-4 w-4" weight="bold" />
            </button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(130px,1fr)_minmax(170px,1.25fr)_minmax(130px,1fr)_minmax(120px,.9fr)_minmax(96px,.72fr)_minmax(130px,1fr)_minmax(130px,1fr)]">
          <KpiBlock
            label="成交总额"
            value={`${formatMoney(summary.totalNotionalUsd)} USD`}
            Icon={Coins}
          />
          <KpiBlock
            label="手续费总额"
            value={
              summary.yearTotalFeeUsd
                ? `${formatMoney(summary.totalFeeUsd)} / ${formatMoney(
                    summary.yearTotalFeeUsd
                  )} USD`
                : `${formatMoney(summary.totalFeeUsd)} USD`
            }
            Icon={Receipt}
            valueClassName="text-[14px]"
          />
          <KpiBlock
            label="已实现盈亏"
            value={`${formatSignedMoney(summary.totalRealizedPnlUsd)} USD`}
            tone={pnlTone(summary.totalRealizedPnlUsd)}
            Icon={TrendUp}
          />
          <KpiBlock
            label="胜率"
            value={`${summary.winRatePct}%`}
            Icon={Target}
          />
          <KpiBlock
            label="交易笔数"
            value={String(summary.tradeCount)}
            Icon={Repeat}
            className="xl:px-2.5"
          />
          <KpiBlock
            label="现货成交额"
            value={`${formatMoney(summary.spotNotionalUsd)} USD`}
            Icon={CurrencyCircleDollar}
          />
          <KpiBlock
            label="合约成交额"
            value={`${formatMoney(summary.futuresNotionalUsd)} USD`}
            Icon={ChartLineUp}
          />
        </div>

        {loading ? <LoadingAnimationPanel /> : null}
      </div>

      <div className="min-h-0 flex-1 px-4">
        {hasCachedError ? (
          <div className="mb-2 rounded-xl border border-[#D6A84F]/25 bg-[#D6A84F]/10 px-3 py-2 text-xs font-bold !text-[#F8D77A]">
            连接中断，5 秒内自动重连。已保留当前页和滚动位置：
            <span className="ml-1 !text-white/70">{error}</span>
          </div>
        ) : null}
        <div
          ref={tableViewportRef}
          onScroll={rememberScrollPosition}
          className="overflow-auto rounded-2xl border border-white/[.08] bg-black/20"
          style={{ maxHeight: tableMaxHeight }}
        >
          <table className="min-w-[1180px] w-full table-fixed border-collapse text-left">
            <colgroup>
              <col style={{ width: "10%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "10%" }} />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-[#08090B]/95 backdrop-blur">
              <tr className="border-b border-white/[.08] text-xs font-black !text-[#A1A1AA]">
                <th className={HEAD_CELL}>时间</th>
                <th className={HEAD_CELL}>市场</th>
                <th className={HEAD_CELL}>交易对</th>
                <th className={HEAD_CELL}>交易动作</th>
                <th className={HEAD_CELL}>数量</th>
                <th className={HEAD_CELL}>价格</th>
                <th className={HEAD_CELL}>成交额</th>
                <th className={HEAD_CELL}>手续费</th>
                <th className={HEAD_CELL}>已实现盈亏</th>
                <th className={HEAD_CELL}>订单ID</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <LoadingRows count={safePageSize} />
              ) : hasBlockingError ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center">
                    <div className="text-[15px] font-black text-[#EF4444]">
                      数据暂不可用
                    </div>
                    <div className="mt-2 text-xs font-bold !text-[#A1A1AA]">
                      {error}
                    </div>
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center">
                    <div className="text-[15px] font-black !text-white">
                      暂无交易明细
                    </div>
                  </td>
                </tr>
              ) : (
                records.map((record) => {
                  const currentRecordKey = recordKey(record);
                  const highlightRole = highlightRoleForRecord(
                    record,
                    actionHighlight
                  );
                  const isJumpTarget = currentRecordKey === jumpTargetRecordKey;
                  const canHighlightAction = record.marketType === "futures";
                  const realizedPnlPct = formatPercent(record.realizedPnlPct);
                  return (
                    <tr
                      key={currentRecordKey}
                      ref={(node) => {
                        rowRefs.current[currentRecordKey] = node;
                      }}
                      data-record-key={currentRecordKey}
                      className={[
                        "group border-b border-white/[.07] transition last:border-0 hover:bg-white/[.055]",
                        isJumpTarget
                          ? "bg-[#D6A84F]/[.20] shadow-[inset_4px_0_0_rgba(248,215,122,1),0_0_30px_rgba(214,168,79,0.22)]"
                          : highlightRole === "source"
                            ? "bg-[#D6A84F]/[.10] shadow-[inset_3px_0_0_rgba(214,168,79,0.65)]"
                            : highlightRole === "related"
                              ? "bg-[#D6A84F]/[.06] shadow-[inset_3px_0_0_rgba(214,168,79,0.38)]"
                              : "",
                      ].join(" ")}
                    >
                      <td className={BODY_CELL}>
                        <div className="text-xs font-bold !text-white/80">
                          {formatTime(record.ts)}
                        </div>
                      </td>
                      <td className={BODY_CELL}>
                        <MarketBadge marketType={record.marketType} />
                      </td>
                      <td className={BODY_CELL}>
                        <div className="flex items-center gap-3">
                          <AssetIcon record={record} />
                          <div className="min-w-0">
                            <div className="truncate text-[15px] font-black leading-5 !text-white">
                              {record.symbol}
                            </div>
                            <div className="mt-0.5 text-xs font-bold !text-[#A1A1AA]">
                              {contractTypeLabel(record.contractType)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className={BODY_CELL}>
                        <ActionLabel
                          action={record.action}
                          highlightRole={highlightRole}
                          onClick={
                            canHighlightAction
                              ? () => onActionHighlightToggle?.(record)
                              : undefined
                          }
                          onDoubleClick={
                            canHighlightAction
                              ? () => onActionJump?.(record)
                              : undefined
                          }
                        />
                      </td>
                      <td className={BODY_CELL}>
                        <div
                          className={`text-[15px] ${NUMBER_TEXT} !text-white`}
                        >
                          {record.quantity}
                        </div>
                        <div className="mt-1 text-xs font-bold !text-[#A1A1AA]">
                          {record.baseAsset}
                        </div>
                      </td>
                      <td className={BODY_CELL}>
                        <div
                          className={`text-[15px] ${NUMBER_TEXT} !text-white`}
                        >
                          {formatMoney(record.price, 4)}
                        </div>
                        <div className="mt-1 text-xs font-bold !text-[#A1A1AA]">
                          {record.quoteAsset}
                        </div>
                      </td>
                      <td className={BODY_CELL}>
                        <div
                          className={`text-[15px] ${NUMBER_TEXT} !text-white`}
                        >
                          {formatMoney(record.notionalUsd)}
                        </div>
                        <div className="mt-1 text-xs font-bold !text-[#A1A1AA]">
                          USD
                        </div>
                      </td>
                      <td className={BODY_CELL}>
                        <div
                          className={`text-[15px] ${NUMBER_TEXT} !text-white`}
                        >
                          {formatFeeUsd(record)}
                        </div>
                        <div className="mt-1 text-xs font-bold !text-[#A1A1AA]">
                          {formatFeeSource(record)}
                        </div>
                      </td>
                      <td className={BODY_CELL}>
                        <div
                          className={`text-[15px] ${NUMBER_TEXT} ${pnlTone(
                            record.realizedPnlUsd
                          )}`}
                        >
                          {formatSignedMoney(record.realizedPnlUsd)}
                        </div>
                        {realizedPnlPct ? (
                          <div
                            className={`mt-1 text-xs ${NUMBER_TEXT} ${pnlTone(
                              record.realizedPnlUsd
                            )}`}
                          >
                            {realizedPnlPct}
                          </div>
                        ) : null}
                      </td>
                      <td className={BODY_CELL}>
                        <button
                          type="button"
                          onClick={() => onOrderIdCopy?.(record.orderId)}
                          className="inline-flex max-w-full items-center gap-2 rounded-lg border border-white/10 bg-white/[.04] px-2 py-1 text-left text-xs font-bold !text-white/75 transition hover:bg-white/[.08] hover:!text-white"
                        >
                          <span className="truncate">{record.orderId}</span>
                          {copiedOrderId === record.orderId ? (
                            <Check
                              className="h-3.5 w-3.5 shrink-0 text-[#22C55E]"
                              weight="bold"
                            />
                          ) : (
                            <Copy
                              className="h-3.5 w-3.5 shrink-0"
                              weight="bold"
                            />
                          )}
                        </button>
                        {record.fillCount && record.fillCount > 1 ? (
                          <div className="mt-1 text-[11px] font-bold !text-[#A1A1AA]">
                            {record.fillCount} 笔成交
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="shrink-0 px-5 pb-5 pt-4">
        <div className="flex flex-col gap-3 rounded-2xl border border-white/[.08] bg-white/[.035] px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="text-xs font-bold !text-[#A1A1AA]">
            总记录数 {loadedTotal}
            {hasMoreHistory ? <span className="ml-1">+</span> : null}
            <span
              className="ml-3"
              style={{
                color:
                  connectionStatus === "connected"
                    ? "#22C55E"
                    : connectionStatus === "degraded"
                      ? "#D6A84F"
                      : "#EF4444",
              }}
            >
              {connectionStatus === "connected"
                ? "实时"
                : connectionStatus === "degraded"
                  ? error
                    ? "重连中"
                    : "降级"
                  : "离线"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!canPrev}
              onClick={() => onPageChange?.(Math.max(1, page - 1))}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[.05] !text-white/70 transition hover:bg-white/[.09] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <CaretLeft className="h-4 w-4" weight="bold" />
            </button>
            <div className="h-9 rounded-xl border border-white/10 bg-white/[.05] px-3 text-xs font-black leading-9 !text-white">
              {page} / {pageCount}
              {hasMoreHistory && page >= pageCount ? "+" : ""}
            </div>
            <button
              type="button"
              disabled={!canNext}
              onClick={() => onPageChange?.(page + 1)}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[.05] !text-white/70 transition hover:bg-white/[.09] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <CaretRight className="h-4 w-4" weight="bold" />
            </button>
            <SelectControl
              ariaLabel="每页数量"
              value={String(safePageSize)}
              onChange={(value) => onPageSizeChange?.(Number(value))}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size} / 页
                </option>
              ))}
            </SelectControl>
          </div>
        </div>
      </div>
    </div>
  );
}
