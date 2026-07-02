import { useCallback, useEffect, useMemo, useState } from "react";
import {
  defaultTradeRecordsRange,
  useTradeRecordsData,
} from "./useTradeRecordsData";
import { summarizeTradeRecords } from "./tradeRecordsMockData";
import type { TradeRecordsDataMode } from "./useTradeRecordsData";
import type {
  TradeRecordsActionHighlight,
  TradeActionType,
  TradeMarketType,
  TradeRecordItem,
  TradeRecordsTableProps,
} from "./tradeRecordsTypes";

export type PreviewState = "normal" | "loading" | "error" | "empty";
export type DirectionFilter = "all" | "long" | "short" | "spot";
export type RangePreset = "today" | "30d" | "90d";

export const rangeLabels: Record<RangePreset, string> = {
  today: "今日至今",
  "30d": "近30天",
  "90d": "近90天",
};

const actionLabels: Record<TradeActionType, string> = {
  spot_buy: "买入",
  spot_sell: "卖出",
  futures_open_long: "开多",
  futures_close_long: "平多",
  futures_open_short: "开空",
  futures_close_short: "平空",
};

const feeSourceLabels: Record<TradeRecordItem["feeSource"], string> = {
  asset: "币种扣费",
  point: "点卡抵扣",
  gt: "GT抵扣",
  zero: "零手续费",
  unknown: "多来源",
};

export function rangeForPreset(preset: RangePreset) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (preset === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return {
      fromSec: Math.floor(start.getTime() / 1000),
      toSec: nowSec,
    };
  }
  if (preset === "90d") {
    return {
      fromSec: nowSec - 90 * 24 * 60 * 60,
      toSec: nowSec,
    };
  }
  return defaultTradeRecordsRange();
}

function safePageSizeValue(value: number) {
  return value === 5 ? 5 : 10;
}

function actionMatchesDirection(
  action: TradeActionType,
  direction: DirectionFilter
) {
  if (direction === "all") return true;
  if (direction === "spot")
    return action === "spot_buy" || action === "spot_sell";
  if (direction === "long") {
    return action === "futures_open_long" || action === "futures_close_long";
  }
  return action === "futures_open_short" || action === "futures_close_short";
}

function recordKey(record: TradeRecordItem) {
  return `${record.marketType}:${record.id}:${record.orderId}`;
}

function contractKeyForRecord(record: TradeRecordItem) {
  if (record.marketType !== "futures") return null;
  return `futures:${record.symbol}:${record.contractType || "perpetual"}`;
}

function relatedTradeAction(action: TradeActionType) {
  if (action === "futures_open_long") return "futures_close_long";
  if (action === "futures_close_long") return "futures_open_long";
  if (action === "futures_open_short") return "futures_close_short";
  if (action === "futures_close_short") return "futures_open_short";
  return undefined;
}

function nearestDirectionalRecord(
  candidates: TradeRecordItem[],
  source: TradeRecordItem
) {
  const otherCandidates = candidates.filter(
    (candidate) => recordKey(candidate) !== recordKey(source)
  );
  const after = otherCandidates
    .filter((candidate) => candidate.ts > source.ts)
    .sort((left, right) => left.ts - right.ts);
  if (after.length > 0) return after[0];

  const before = otherCandidates
    .filter((candidate) => candidate.ts < source.ts)
    .sort((left, right) => right.ts - left.ts);
  if (before.length > 0) return before[0];

  return null;
}

function isFuturesOpenAction(action: TradeActionType) {
  return action === "futures_open_long" || action === "futures_open_short";
}

function isFuturesCloseAction(action: TradeActionType) {
  return action === "futures_close_long" || action === "futures_close_short";
}

function filteredRecords({
  records,
  marketFilter,
  typeFilter,
  directionFilter,
  contractFilter,
}: {
  records: TradeRecordItem[];
  marketFilter: TradeMarketType | "all";
  typeFilter: TradeActionType | "all";
  directionFilter: DirectionFilter;
  contractFilter: string;
}) {
  return records.filter((record) => {
    if (marketFilter !== "all" && record.marketType !== marketFilter) {
      return false;
    }
    if (typeFilter !== "all" && record.action !== typeFilter) return false;
    if (!actionMatchesDirection(record.action, directionFilter)) return false;
    if (contractFilter !== "all" && record.symbol !== contractFilter)
      return false;
    return true;
  });
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCsv(records: TradeRecordItem[]) {
  const header = [
    "时间",
    "市场",
    "交易对",
    "交易动作",
    "数量",
    "价格",
    "成交额",
    "手续费等值USD",
    "手续费数量",
    "手续费币种",
    "手续费来源",
    "手续费展示数量",
    "手续费展示单位",
    "点卡抵扣",
    "GT抵扣",
    "已实现盈亏",
    "订单ID",
    "成交笔数",
    "成交明细ID",
  ];
  const rows = records.map((record) => [
    new Date(record.ts).toISOString(),
    record.marketType === "spot" ? "现货" : "合约",
    record.symbol,
    actionLabels[record.action],
    record.quantity,
    record.price,
    record.notionalUsd,
    record.feeUsd,
    record.feeAmount,
    record.feeCurrency,
    feeSourceLabels[record.feeSource],
    record.feeDisplayAmount,
    record.feeDisplayCurrency,
    record.pointFeeAmount ?? "",
    record.gtFeeAmount ?? "",
    record.realizedPnlUsd ?? "",
    record.orderId,
    record.fillCount ?? 1,
    record.fillIds?.join("|") ?? record.id,
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `trade-records-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function useTradeRecordsTableController({
  mode,
  previewState = "normal",
  initialRangePreset = "30d",
  initialPageSize = 10,
  enabled = true,
}: {
  mode: TradeRecordsDataMode;
  previewState?: PreviewState;
  initialRangePreset?: RangePreset;
  initialPageSize?: number;
  enabled?: boolean;
}) {
  const [rangePreset, setRangePresetState] =
    useState<RangePreset>(initialRangePreset);
  const [range, setRange] = useState(() => rangeForPreset(initialRangePreset));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(
    safePageSizeValue(initialPageSize)
  );
  const [marketFilter, setMarketFilter] = useState<TradeMarketType | "all">(
    "all"
  );
  const [typeFilter, setTypeFilter] = useState<TradeActionType | "all">("all");
  const [directionFilter, setDirectionFilter] =
    useState<DirectionFilter>("all");
  const [contractFilter, setContractFilter] = useState("all");
  const [copiedOrderId, setCopiedOrderId] = useState<string | null>(null);
  const [actionHighlight, setActionHighlight] =
    useState<TradeRecordsActionHighlight>(null);
  const [jumpTargetRecordKey, setJumpTargetRecordKey] = useState<string | null>(
    null
  );
  const [pendingJumpTargetKey, setPendingJumpTargetKey] = useState<
    string | null
  >(null);

  const tradeRecords = useTradeRecordsData({
    mode,
    fromSec: range.fromSec,
    toSec: range.toSec,
    previewState,
    enabled,
  });
  const {
    loading,
    loadingMore,
    hasMoreHistory,
    loadMore,
    records,
    feeSummary,
    error,
    lastUpdatedAt,
    connectionStatus,
    refresh,
  } = tradeRecords;

  const availableContracts = useMemo(
    () => Array.from(new Set(records.map((record) => record.symbol))).sort(),
    [records]
  );

  const filtered = useMemo(
    () =>
      filteredRecords({
        records,
        marketFilter,
        typeFilter,
        directionFilter,
        contractFilter,
      }),
    [contractFilter, directionFilter, marketFilter, records, typeFilter]
  );

  const pageStart = (page - 1) * pageSize;
  const pageEnd = pageStart + pageSize;
  const visibleRecords = filtered.slice(pageStart, pageEnd);
  const visibleSummary = useMemo(
    () => summarizeTradeRecords(filtered),
    [filtered]
  );
  const tableSummary = useMemo(() => {
    if (mode === "gate-api" && feeSummary) {
      return {
        ...visibleSummary,
        totalFeeUsd: feeSummary.totalFeeUsd,
        yearTotalFeeUsd: feeSummary.yearTotalFeeUsd,
      };
    }

    const currentFee = Number(visibleSummary.totalFeeUsd || "0");
    return {
      ...visibleSummary,
      yearTotalFeeUsd: (currentFee * 12.4).toFixed(2),
    };
  }, [feeSummary, mode, visibleSummary]);

  const setPageSize = useCallback((nextPageSize: number) => {
    setPageSizeState(safePageSizeValue(nextPageSize));
    setPage(1);
    setJumpTargetRecordKey(null);
  }, []);

  const setRangePreset = useCallback((preset: RangePreset) => {
    setRangePresetState(preset);
    setRange(rangeForPreset(preset));
    setPage(1);
    setJumpTargetRecordKey(null);
  }, []);

  const refreshCurrentRange = useCallback(() => {
    setRange(rangeForPreset(rangePreset));
  }, [rangePreset]);

  const refreshTable = useCallback(() => {
    setPage(1);
    setJumpTargetRecordKey(null);
    refresh();
  }, [refresh]);

  const copyOrderId = useCallback(async (orderId: string) => {
    try {
      await navigator.clipboard?.writeText(orderId);
      setCopiedOrderId(orderId);
    } catch {
      setCopiedOrderId(null);
    }
  }, []);

  const toggleActionHighlight = useCallback((record: TradeRecordItem) => {
    if (record.marketType !== "futures") return;
    const sourceRecordKey = recordKey(record);
    const contractKey = contractKeyForRecord(record);
    const relatedAction = relatedTradeAction(record.action);

    setActionHighlight((current) => {
      if (
        ((record.cycleId && current?.cycleId === record.cycleId) ||
          (!record.cycleId && current?.contractKey === contractKey)) &&
        current.sourceRecordKey === sourceRecordKey
      ) {
        return null;
      }
      return {
        ...(record.cycleId ? { cycleId: record.cycleId } : { contractKey }),
        sourceRecordKey,
        sourceAction: record.action,
        relatedAction,
      };
    });
  }, []);

  const highlightForRecord = useCallback(
    (record: TradeRecordItem): TradeRecordsActionHighlight => {
      if (record.marketType !== "futures") return null;
      const contractKey = contractKeyForRecord(record);
      return {
        ...(record.cycleId ? { cycleId: record.cycleId } : { contractKey }),
        sourceRecordKey: recordKey(record),
        sourceAction: record.action,
        relatedAction: relatedTradeAction(record.action),
      };
    },
    []
  );

  const actionJumpTarget = useCallback(
    (record: TradeRecordItem) => {
      if (record.marketType !== "futures") return null;
      const sourceRecordKey = recordKey(record);
      const contractKey = contractKeyForRecord(record);
      const relatedAction = relatedTradeAction(record.action);
      const sameContractCandidates = filtered.filter(
        (candidate) =>
          candidate.marketType === record.marketType &&
          contractKeyForRecord(candidate) === contractKey
      );
      const candidates = record.cycleId
        ? filtered.filter(
            (candidate) =>
              candidate.marketType === record.marketType &&
              candidate.cycleId === record.cycleId
          )
        : sameContractCandidates.filter(
            (candidate) => candidate.action === relatedAction
          );

      if (candidates.length === 0) return null;

      if (!record.cycleId) {
        return nearestDirectionalRecord(candidates, record);
      }

      const oppositeActionCandidates = candidates
        .filter((candidate) => candidate.action === relatedAction)
        .filter((candidate) => recordKey(candidate) !== sourceRecordKey);

      if (isFuturesOpenAction(record.action)) {
        const laterCloseCandidate = oppositeActionCandidates
          .filter((candidate) => candidate.ts >= record.ts)
          .sort((left, right) => left.ts - right.ts)[0];
        if (laterCloseCandidate) return laterCloseCandidate;

        return (
          oppositeActionCandidates.sort(
            (left, right) => left.ts - right.ts
          )[0] || null
        );
      }

      if (isFuturesCloseAction(record.action)) {
        return (
          oppositeActionCandidates.sort(
            (left, right) => left.ts - right.ts
          )[0] || null
        );
      }

      const sortedCandidates = candidates
        .filter((candidate) => recordKey(candidate) !== sourceRecordKey)
        .sort((left, right) => left.ts - right.ts);
      return sortedCandidates[0] || null;
    },
    [filtered]
  );

  const jumpToActionMatch = useCallback(
    (record: TradeRecordItem) => {
      const target = actionJumpTarget(record);
      const highlight = highlightForRecord(record);
      if (!highlight) return;

      setJumpTargetRecordKey(null);
      setPendingJumpTargetKey(null);

      if (!target) {
        setActionHighlight(highlight);
        return;
      }

      const targetKey = recordKey(target);
      if (targetKey === recordKey(record)) {
        setActionHighlight(highlight);
        return;
      }
      const targetIndex = filtered.findIndex(
        (candidate) => recordKey(candidate) === targetKey
      );
      if (targetIndex < 0) {
        setActionHighlight(highlight);
        return;
      }

      setActionHighlight({
        ...highlight,
        relatedRecordKeys: [targetKey],
      });
      setPage(Math.floor(targetIndex / pageSize) + 1);
      setPendingJumpTargetKey(targetKey);
    },
    [actionJumpTarget, filtered, highlightForRecord, pageSize]
  );

  const reset = useCallback(
    ({
      nextRangePreset = initialRangePreset,
      nextPageSize = initialPageSize,
    }: {
      nextRangePreset?: RangePreset;
      nextPageSize?: number;
    } = {}) => {
      setRangePresetState(nextRangePreset);
      setRange(rangeForPreset(nextRangePreset));
      setPageSizeState(safePageSizeValue(nextPageSize));
      setPage(1);
      setMarketFilter("all");
      setTypeFilter("all");
      setDirectionFilter("all");
      setContractFilter("all");
      setActionHighlight(null);
      setJumpTargetRecordKey(null);
      setPendingJumpTargetKey(null);
    },
    [initialPageSize, initialRangePreset]
  );

  useEffect(() => {
    setPage(1);
    setJumpTargetRecordKey(null);
    setPendingJumpTargetKey(null);
  }, [contractFilter, directionFilter, marketFilter, mode, range, typeFilter]);

  useEffect(() => {
    if (!actionHighlight) return;
    const stillHasSourceRecord = records.some((record) => {
      if (recordKey(record) !== actionHighlight.sourceRecordKey) return false;
      if (actionHighlight.cycleId)
        return record.cycleId === actionHighlight.cycleId;
      return contractKeyForRecord(record) === actionHighlight.contractKey;
    });
    if (!stillHasSourceRecord) setActionHighlight(null);
  }, [actionHighlight, records]);

  useEffect(() => {
    if (
      enabled &&
      mode === "gate-api" &&
      !loading &&
      !loadingMore &&
      hasMoreHistory &&
      pageEnd > filtered.length
    ) {
      loadMore();
    }
  }, [
    filtered.length,
    hasMoreHistory,
    loadMore,
    loading,
    loadingMore,
    enabled,
    mode,
    pageEnd,
  ]);

  useEffect(() => {
    if (!copiedOrderId) return;
    const timer = window.setTimeout(() => setCopiedOrderId(null), 1_200);
    return () => window.clearTimeout(timer);
  }, [copiedOrderId]);

  useEffect(() => {
    if (!jumpTargetRecordKey) return;
    const timer = window.setTimeout(() => setJumpTargetRecordKey(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [jumpTargetRecordKey]);

  useEffect(() => {
    if (!pendingJumpTargetKey) return;
    if (
      !visibleRecords.some(
        (record) => recordKey(record) === pendingJumpTargetKey
      )
    ) {
      return;
    }
    setJumpTargetRecordKey(pendingJumpTargetKey);
    setPendingJumpTargetKey(null);
  }, [pendingJumpTargetKey, visibleRecords]);

  const loadingCurrentPage =
    loading || (loadingMore && visibleRecords.length === 0);

  const tableProps = useMemo<TradeRecordsTableProps>(
    () => ({
      records: visibleRecords,
      summary: tableSummary,
      loading: loadingCurrentPage,
      error,
      page,
      pageSize,
      totalCount: filtered.length,
      hasMoreHistory,
      lastUpdatedAt,
      connectionStatus,
      marketFilter,
      typeFilter,
      directionFilter,
      contractFilter,
      availableContracts,
      timeRangeLabel: rangeLabels[rangePreset],
      copiedOrderId,
      actionHighlight,
      jumpTargetRecordKey,
      onMarketFilterChange: setMarketFilter,
      onTypeFilterChange: setTypeFilter,
      onDirectionFilterChange: setDirectionFilter,
      onContractFilterChange: setContractFilter,
      onPageChange: (nextPage) => setPage(Math.max(1, nextPage)),
      onPageSizeChange: setPageSize,
      onRefresh: refreshTable,
      onExportCsv: () => exportCsv(visibleRecords),
      onOrderIdCopy: copyOrderId,
      onTimeRangeClick: refreshCurrentRange,
      onActionHighlightToggle: toggleActionHighlight,
      onActionJump: jumpToActionMatch,
    }),
    [
      actionHighlight,
      availableContracts,
      connectionStatus,
      contractFilter,
      copiedOrderId,
      copyOrderId,
      directionFilter,
      error,
      filtered.length,
      hasMoreHistory,
      jumpTargetRecordKey,
      lastUpdatedAt,
      loadingCurrentPage,
      marketFilter,
      page,
      pageSize,
      rangePreset,
      refreshCurrentRange,
      refreshTable,
      setPageSize,
      tableSummary,
      toggleActionHighlight,
      typeFilter,
      visibleRecords,
      jumpToActionMatch,
    ]
  );

  return {
    ...tradeRecords,
    range,
    rangePreset,
    page,
    pageSize,
    filteredRecords: filtered,
    visibleRecords,
    tableSummary,
    availableContracts,
    loadingCurrentPage,
    tableProps,
    setPage,
    setPageSize,
    setRangePreset,
    refreshCurrentRange,
    reset,
  };
}
