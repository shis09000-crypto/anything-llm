import React, { useMemo, useState } from "react";
import { ArrowsClockwise, CaretDown, Info } from "@phosphor-icons/react";
import type {
  FuturesPositionSide,
  FuturesRiskLevel,
  LiquidationRiskLevel,
  OpenFuturesPositionItem,
  OpenFuturesPositionsCardProps,
} from "./openFuturesPositionsTypes";
import { useCryptoStatusLabel } from "./cryptoStatusI18n";

type PositionFilter = "all" | "long" | "short" | "risk";

const RISK_ORDER: Record<FuturesRiskLevel, number> = {
  danger: 3,
  watch: 2,
  safe: 1,
};

const FILTER_OPTIONS: Array<{ id: PositionFilter; label: string }> = [
  { id: "all", label: "全部合约" },
  { id: "long", label: "做多" },
  { id: "short", label: "做空" },
  { id: "risk", label: "高风险" },
];

const NUMBER_TEXT = "font-black tabular-nums lining-nums";
const PRIMARY_VALUE_TEXT = `text-[15px] leading-5 ${NUMBER_TEXT}`;
const SECONDARY_VALUE_TEXT = "text-xs font-bold leading-4";
const LEFT_HEAD_CELL = "px-4 py-3 text-left";
const CENTER_HEAD_CELL = "px-4 py-3 text-center";
const LEFT_BODY_CELL = "px-4 py-3 text-left";
const CENTER_BODY_CELL = "px-4 py-3 text-center";
const LIQUIDATION_LIGHT_COLORS = [
  "#22C55E",
  "#A3E635",
  "#FACC15",
  "#FB923C",
  "#EF4444",
];
const LIQUIDATION_RISK_META: Record<
  LiquidationRiskLevel,
  { label: string; lights: number }
> = {
  safe: { label: "安全", lights: 1 },
  watch: { label: "注意", lights: 2 },
  danger: { label: "高危", lights: 3 },
  critical: { label: "危险", lights: 4 },
  extreme: { label: "极危", lights: 5 },
};

const statusMeta: Record<
  NonNullable<OpenFuturesPositionsCardProps["status"]>,
  { color: string; bg: string }
> = {
  connected: { color: "#22C55E", bg: "rgba(34,197,94,.10)" },
  degraded: { color: "#F4B23E", bg: "rgba(244,178,62,.10)" },
  disconnected: {
    color: "#EF4444",
    bg: "rgba(239,68,68,.10)",
  },
};

function parseNumber(value?: string | null) {
  if (!value) return 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalNumber(value?: string | null) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  const parsed = Number(normalized.replace(/,/g, "").replace("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value?: string | number | null) {
  const number = typeof value === "number" ? value : parseNumber(value);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function formatSignedMoney(value?: string | number | null) {
  const number = typeof value === "number" ? value : parseNumber(value);
  const prefix = number > 0 ? "+" : number < 0 ? "-" : "";
  return `${prefix}${formatMoney(Math.abs(number))}`;
}

function formatPercent(value?: string | number | null) {
  const number = typeof value === "number" ? value : parseNumber(value);
  const prefix = number > 0 ? "+" : number < 0 ? "-" : "";
  return `${prefix}${Math.abs(number).toFixed(2)}%`;
}

function quantityAmount(value?: string | null) {
  return String(value || "")
    .trim()
    .split(/\s+/)[0];
}

function pnlTone(value?: string | number | null) {
  const number = typeof value === "number" ? value : parseNumber(value);
  if (number > 0) return "text-[#22C55E]";
  if (number < 0) return "text-[#EF4444]";
  return "!text-white";
}

function sideLabel(side: FuturesPositionSide) {
  return side === "long" ? "做多" : "做空";
}

function sideTone(side: FuturesPositionSide) {
  return side === "long" ? "text-[#22C55E]" : "text-[#EF4444]";
}

function marginModeLabel(mode: OpenFuturesPositionItem["marginMode"]) {
  return mode === "cross" ? "全仓" : "逐仓";
}

function contractTypeLabel(type: OpenFuturesPositionItem["contractType"]) {
  return type === "perpetual" ? "永续" : "交割";
}

function riskTone(riskLevel: FuturesRiskLevel) {
  if (riskLevel === "danger") return "text-[#EF4444]";
  if (riskLevel === "watch") return "text-[#F59E0B]";
  return "!text-white";
}

function markPriceTone(position: OpenFuturesPositionItem) {
  const entry = parseNumber(position.entryPrice);
  const mark = parseNumber(position.markPrice);
  if (!entry || !mark || entry === mark) return "!text-white";
  const favorable = position.side === "long" ? mark > entry : mark < entry;
  return favorable ? "text-[#22C55E]" : "text-[#EF4444]";
}

function sortedPositions(positions: OpenFuturesPositionItem[]) {
  return [...positions].sort((left, right) => {
    const riskDelta = RISK_ORDER[right.riskLevel] - RISK_ORDER[left.riskLevel];
    if (riskDelta !== 0) return riskDelta;
    return (
      Math.abs(parseNumber(right.unrealizedPnlUsd)) -
      Math.abs(parseNumber(left.unrealizedPnlUsd))
    );
  });
}

function positionMatchesFilter(
  position: OpenFuturesPositionItem,
  filter: PositionFilter
) {
  if (filter === "long") return position.side === "long";
  if (filter === "short") return position.side === "short";
  if (filter === "risk")
    return position.riskLevel === "watch" || position.riskLevel === "danger";
  return true;
}

function legacyLiquidationRiskLevel(
  riskLevel: FuturesRiskLevel
): LiquidationRiskLevel {
  if (riskLevel === "danger") return "critical";
  if (riskLevel === "watch") return "danger";
  return "safe";
}

function liquidationRiskLevelFromDistance(
  distancePct: number
): LiquidationRiskLevel {
  if (distancePct >= 15) return "safe";
  if (distancePct >= 10) return "watch";
  if (distancePct >= 5) return "danger";
  if (distancePct >= 1) return "critical";
  return "extreme";
}

function liquidationRiskLevel(position: OpenFuturesPositionItem) {
  const distancePct = parseOptionalNumber(position.liquidationDistancePct);
  if (distancePct !== null)
    return liquidationRiskLevelFromDistance(distancePct);
  return (
    position.liquidationRiskLevel ||
    legacyLiquidationRiskLevel(position.riskLevel)
  );
}

function LiquidationRiskLights({
  position,
}: {
  position: OpenFuturesPositionItem;
}) {
  const distancePct = parseOptionalNumber(position.liquidationDistancePct);
  const level = liquidationRiskLevel(position);
  const meta = LIQUIDATION_RISK_META[level];
  const distanceLabel =
    distancePct === null ? "待计算" : `${distancePct.toFixed(2)}%`;

  return (
    <div
      className="mt-2 flex items-center gap-[3px]"
      title={`强平风险：${meta.label}\n强平距离：${distanceLabel}`}
    >
      {LIQUIDATION_LIGHT_COLORS.map((color, index) => {
        const active = index < meta.lights;
        return (
          <span
            key={color}
            className="block h-[5px] w-[10px] rounded-full"
            style={{
              backgroundColor: active ? color : "rgba(255,255,255,0.10)",
              boxShadow: active ? `0 0 8px ${color}66` : "none",
            }}
          />
        );
      })}
    </div>
  );
}

function PositionIcon({ position }: { position: OpenFuturesPositionItem }) {
  return (
    <div className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[.08] text-[10px] font-black !text-white shadow-[0_0_18px_rgb(255_255_255_/_0.08)]">
      <span>{position.baseAsset.slice(0, 3)}</span>
      {position.iconUrl ? (
        <img
          src={position.iconUrl}
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

function MetricBlock({
  label,
  value,
  tone = "!text-white",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[.035] px-3 py-3">
      <div className="text-xs font-bold !text-[#A1A1AA]">{label}</div>
      <div className={`mt-1 min-h-[22px] text-[15px] ${NUMBER_TEXT} ${tone}`}>
        {value}
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

export default function OpenFuturesPositionsCard({
  positions,
  summary,
  filterLabel = "全部合约",
  lastUpdatedAt = null,
  loading = false,
  error = null,
  status = "connected",
  cardWidth = 980,
  cardHeight = 560,
  borderRadius = 28,
  compactMode = false,
  showSummaryFooter = true,
  showLeverageBars = true,
  visiblePositionCount = 5,
  onRefresh,
}: OpenFuturesPositionsCardProps) {
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(
    null
  );
  const [filter, setFilter] = useState<PositionFilter>("all");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [internalUpdatedAt, setInternalUpdatedAt] = useState<number | null>(
    lastUpdatedAt
  );
  const statusLabel = useCryptoStatusLabel(status);

  const activeFilterLabel =
    FILTER_OPTIONS.find((option) => option.id === filter)?.label || filterLabel;
  const visibleRows = Math.max(
    2,
    Math.min(12, Math.round(visiblePositionCount))
  );
  const rowHeight = compactMode ? 56 : 72;
  const tableMaxHeight = visibleRows * rowHeight + 42;

  const displayedPositions = useMemo(
    () =>
      sortedPositions(positions).filter((position) =>
        positionMatchesFilter(position, filter)
      ),
    [filter, positions]
  );

  const displayUpdatedAt = lastUpdatedAt || internalUpdatedAt;
  const marginRatio = Math.max(
    0,
    Math.min(100, parseNumber(summary.marginRatioPct))
  );
  const marginRatioTone =
    marginRatio >= 35
      ? "bg-[#EF4444]"
      : marginRatio >= 20
        ? "bg-[#F59E0B]"
        : "bg-[#22C55E]";

  return (
    <div
      className="relative flex w-full max-w-full flex-col overflow-hidden border !text-white shadow-[0_28px_80px_rgb(0_0_0_/_0.35)]"
      style={{
        width: cardWidth,
        height: cardHeight,
        borderRadius,
        borderColor: "rgba(255,255,255,0.10)",
        background:
          "radial-gradient(circle at 22% 18%, rgba(29,78,216,0.14), transparent 32%), linear-gradient(135deg, #08090B 0%, #050505 62%, #08090B 100%)",
      }}
      onClick={(event) => {
        if (event.currentTarget === event.target) {
          setSelectedPositionId(null);
          setDropdownOpen(false);
        }
      }}
    >
      <div className="flex shrink-0 flex-col gap-3 px-5 pb-3 pt-5 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[22px] font-black leading-7 tracking-normal !text-white">
              未平仓合约
            </h3>
            <div className="flex h-5 w-5 items-center justify-center rounded-full border border-white/20 !text-white/55">
              <Info className="h-3.5 w-3.5" weight="bold" />
            </div>
          </div>
          <div className="mt-1 text-[13px] font-bold !text-[#A1A1AA]">
            共 {displayedPositions.length} 个仓位
            {displayUpdatedAt ? (
              <span className="ml-2 !text-white/35">
                {new Date(displayUpdatedAt).toLocaleTimeString()}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="flex h-9 items-center rounded-xl px-3 text-xs font-black"
            style={{
              color: statusMeta[status].color,
              backgroundColor: statusMeta[status].bg,
            }}
          >
            {statusLabel}
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setDropdownOpen((current) => !current);
              }}
              className="flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/[.05] px-3 text-xs font-bold !text-white/75 transition hover:bg-white/[.09]"
            >
              {activeFilterLabel}
              <CaretDown className="h-3.5 w-3.5" weight="bold" />
            </button>
            {dropdownOpen ? (
              <div className="absolute right-0 z-20 mt-2 w-32 overflow-hidden rounded-xl border border-white/10 bg-[#08090B] p-1 shadow-[0_18px_36px_rgb(0_0_0_/_0.42)]">
                {FILTER_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setFilter(option.id);
                      setSelectedPositionId(null);
                      setDropdownOpen(false);
                    }}
                    className={[
                      "w-full rounded-lg px-3 py-2 text-left text-xs font-bold transition",
                      filter === option.id
                        ? "bg-[#D6A84F]/18 text-[#D6A84F]"
                        : "!text-white/65 hover:bg-white/[.06]",
                    ].join(" ")}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="刷新未平仓合约"
            onClick={(event) => {
              event.stopPropagation();
              if (onRefresh) onRefresh();
              else setInternalUpdatedAt(Date.now());
            }}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[.05] !text-white/70 transition hover:bg-white/[.09] hover:!text-white"
          >
            <ArrowsClockwise className="h-4 w-4" weight="bold" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 px-4">
        <div
          className="h-full overflow-auto rounded-2xl border border-white/[.08] bg-black/20"
          style={{ maxHeight: tableMaxHeight }}
        >
          <table className="min-w-[1120px] w-full table-fixed border-collapse text-left">
            <colgroup>
              <col style={{ width: "12%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "9%" }} />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-[#08090B]/95 backdrop-blur">
              <tr className="border-b border-white/[.08] text-xs font-black !text-[#A1A1AA]">
                <th className={LEFT_HEAD_CELL}>合约</th>
                <th className={LEFT_HEAD_CELL}>方向 / 杠杆</th>
                <th className={CENTER_HEAD_CELL}>持仓价值</th>
                <th className={CENTER_HEAD_CELL}>持币数量</th>
                <th className={CENTER_HEAD_CELL}>开仓均价</th>
                <th className={CENTER_HEAD_CELL}>当前价格</th>
                <th className={CENTER_HEAD_CELL}>未实现盈亏</th>
                <th className={CENTER_HEAD_CELL}>盈亏率</th>
                <th className={CENTER_HEAD_CELL}>保证金</th>
                <th className={CENTER_HEAD_CELL}>强平价格</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <LoadingRows count={visibleRows} />
              ) : error ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center">
                    <div className="text-[15px] font-black text-[#EF4444]">
                      数据暂不可用
                    </div>
                    <div className="mt-2 text-xs font-bold !text-[#A1A1AA]">
                      {error}
                    </div>
                  </td>
                </tr>
              ) : displayedPositions.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center">
                    <div className="text-[15px] font-black !text-white">
                      暂无未平仓合约
                    </div>
                    <div className="mt-2 text-xs font-bold !text-[#A1A1AA]">
                      当前筛选下没有可展示的合约仓位。
                    </div>
                  </td>
                </tr>
              ) : (
                displayedPositions.map((position) => {
                  const selected = selectedPositionId === position.id;

                  return (
                    <tr
                      key={position.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedPositionId((current) =>
                          current === position.id ? null : position.id
                        );
                      }}
                      className={[
                        "cursor-pointer border-b border-white/[.07] transition last:border-0",
                        selected ? "bg-white/[.10]" : "hover:bg-white/[.055]",
                      ].join(" ")}
                    >
                      <td className={LEFT_BODY_CELL}>
                        <div className="flex items-center gap-3">
                          <PositionIcon position={position} />
                          <div>
                            <div className="text-[15px] font-black leading-5 !text-white">
                              {position.symbol}
                            </div>
                            <div className="mt-0.5 text-xs font-bold !text-[#A1A1AA]">
                              {contractTypeLabel(position.contractType)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className={LEFT_BODY_CELL}>
                        <div
                          className={`text-[15px] font-black leading-5 ${sideTone(
                            position.side
                          )}`}
                        >
                          {sideLabel(position.side)} {position.leverage}x
                        </div>
                        <div className="mt-1 text-xs font-extrabold !text-[#A1A1AA]">
                          {marginModeLabel(position.marginMode)}
                        </div>
                        {showLeverageBars ? (
                          <LiquidationRiskLights position={position} />
                        ) : null}
                      </td>
                      <td className={CENTER_BODY_CELL}>
                        <div
                          className={`whitespace-nowrap ${PRIMARY_VALUE_TEXT} !text-white`}
                        >
                          {formatMoney(position.positionValueUsd)} USD
                        </div>
                      </td>
                      <td className={CENTER_BODY_CELL}>
                        <div
                          className={`whitespace-nowrap ${PRIMARY_VALUE_TEXT} !text-white`}
                        >
                          {position.quantityAmount ||
                            quantityAmount(position.quantity)}
                        </div>
                      </td>
                      <td className={CENTER_BODY_CELL}>
                        <div
                          className={`whitespace-nowrap ${PRIMARY_VALUE_TEXT} !text-white`}
                        >
                          {formatMoney(position.entryPrice)}
                        </div>
                        <div
                          className={`mt-1 whitespace-nowrap ${SECONDARY_VALUE_TEXT} !text-[#A1A1AA]`}
                        >
                          {position.quoteAsset}
                        </div>
                      </td>
                      <td className={CENTER_BODY_CELL}>
                        <div
                          className={`whitespace-nowrap ${PRIMARY_VALUE_TEXT} ${markPriceTone(
                            position
                          )}`}
                        >
                          {formatMoney(position.markPrice)}
                        </div>
                        <div
                          className={`mt-1 whitespace-nowrap ${SECONDARY_VALUE_TEXT} !text-[#A1A1AA]`}
                        >
                          {position.quoteAsset}
                        </div>
                      </td>
                      <td className={CENTER_BODY_CELL}>
                        <div
                          className={`whitespace-nowrap ${PRIMARY_VALUE_TEXT} ${pnlTone(
                            position.unrealizedPnlUsd
                          )}`}
                        >
                          {formatSignedMoney(position.unrealizedPnlUsd)}
                        </div>
                      </td>
                      <td className={CENTER_BODY_CELL}>
                        <div
                          className={`whitespace-nowrap ${PRIMARY_VALUE_TEXT} ${pnlTone(
                            position.pnlPct
                          )}`}
                        >
                          {formatPercent(position.pnlPct)}
                        </div>
                      </td>
                      <td className={CENTER_BODY_CELL}>
                        <div
                          className={`whitespace-nowrap ${PRIMARY_VALUE_TEXT} !text-white`}
                        >
                          {formatMoney(position.marginUsd)}
                        </div>
                        <div
                          className={`mt-1 whitespace-nowrap ${SECONDARY_VALUE_TEXT} !text-[#A1A1AA]`}
                        >
                          USD
                        </div>
                      </td>
                      <td className={CENTER_BODY_CELL}>
                        <div
                          className={`whitespace-nowrap ${PRIMARY_VALUE_TEXT} ${riskTone(
                            position.riskLevel
                          )}`}
                        >
                          {position.liquidationPrice
                            ? formatMoney(position.liquidationPrice)
                            : "--"}
                        </div>
                        <div
                          className={`mt-1 whitespace-nowrap ${SECONDARY_VALUE_TEXT} !text-[#A1A1AA]`}
                        >
                          USD
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showSummaryFooter ? (
        <div className="shrink-0 px-5 pb-5 pt-4">
          <div className="grid gap-3 md:grid-cols-5">
            <MetricBlock
              label="未实现盈亏合计"
              value={`${formatSignedMoney(summary.totalUnrealizedPnlUsd)} USD`}
              tone={pnlTone(summary.totalUnrealizedPnlUsd)}
            />
            <MetricBlock
              label="盈亏率"
              value={formatPercent(summary.weightedPnlPct)}
              tone={pnlTone(summary.weightedPnlPct)}
            />
            <MetricBlock
              label="保证金总额"
              value={`${formatMoney(summary.totalMarginUsd)} USD`}
            />
            <MetricBlock
              label="账户权益"
              value={`${formatMoney(summary.accountEquityUsd)} USD`}
            />
            <div className="rounded-2xl border border-white/10 bg-white/[.035] px-3 py-3">
              <div className="text-xs font-bold !text-[#A1A1AA]">保证金率</div>
              <div
                className={`mt-1 min-h-[22px] text-[15px] ${NUMBER_TEXT} !text-white`}
              >
                {formatPercent(summary.marginRatioPct)}
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full ${marginRatioTone}`}
                  style={{ width: `${marginRatio}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
