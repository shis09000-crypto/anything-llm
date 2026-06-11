import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import {
  parseCryptoHubSse,
  cryptoHubSseData,
} from "@/hooks/cryptoHub/useCryptoHubStream";
import { useCryptoHubWatchedConnection } from "@/hooks/cryptoHub/useCryptoHubWatchdog";
import {
  mockTradeRecords,
  mockTradeRecordsSummary,
  summarizeTradeRecords,
} from "./tradeRecordsMockData";
import type {
  TradeRecordItem,
  TradeRecordsFeeSummaryResponse,
  TradeRecordsConnectionStatus,
  TradeRecordsResponse,
  TradeRecordsSummary,
} from "./tradeRecordsTypes";

export type TradeRecordsDataMode = "mock" | "gate-api";

const TRADE_RECORDS_ENDPOINT = `${API_BASE}/crypto-hub/trade-records`;
const TRADE_RECORDS_STREAM_ENDPOINT = `${TRADE_RECORDS_ENDPOINT}/stream`;
const TRADE_RECORDS_FEE_SUMMARY_ENDPOINT = `${TRADE_RECORDS_ENDPOINT}/fee-summary`;
const BATCH_LIMIT = 50;
const RECONNECT_DELAY_MS = 5_000;

const emptySummary: TradeRecordsSummary = {
  totalNotionalUsd: "0.00",
  totalFeeUsd: "0.00",
  totalRealizedPnlUsd: "0.00",
  winRatePct: "0.00",
  tradeCount: 0,
  spotNotionalUsd: "0.00",
  futuresNotionalUsd: "0.00",
};

function parseSseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function recordKey(record: TradeRecordItem) {
  return `${record.marketType}:${record.id}:${record.orderId}`;
}

function parseNumber(value?: string | null) {
  const number = Number(String(value || "0").replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function trimNumber(value: number, digits = 8) {
  if (!value) return "0";
  return value
    .toFixed(digits)
    .replace(/\.?0+$/, "")
    .replace(/\.$/, "");
}

function fixedNumber(value: number, digits = 2) {
  return value.toFixed(digits);
}

function uniqueFillIds(record: TradeRecordItem) {
  const ids = record.fillIds?.length ? record.fillIds : [record.id];
  return Array.from(new Set(ids.filter(Boolean)));
}

function mergeDuplicateRecord(
  current: TradeRecordItem,
  incoming: TradeRecordItem
): TradeRecordItem {
  const currentFillIds = uniqueFillIds(current);
  const incomingFillIds = uniqueFillIds(incoming);
  const currentFillSet = new Set(currentFillIds);
  const hasNewFill = incomingFillIds.some((id) => !currentFillSet.has(id));
  if (!hasNewFill) return current.ts >= incoming.ts ? current : incoming;

  const fillIds = Array.from(new Set([...currentFillIds, ...incomingFillIds]));
  const latest = current.ts >= incoming.ts ? current : incoming;
  const quantity =
    parseNumber(current.quantity) + parseNumber(incoming.quantity);
  const notional =
    parseNumber(current.notionalUsd) + parseNumber(incoming.notionalUsd);
  const priceWeightedNotional =
    parseNumber(current.quantity) * parseNumber(current.price) +
    parseNumber(incoming.quantity) * parseNumber(incoming.price);
  const feeUsd = parseNumber(current.feeUsd) + parseNumber(incoming.feeUsd);
  const pointFee =
    parseNumber(current.pointFeeAmount) + parseNumber(incoming.pointFeeAmount);
  const gtFee =
    parseNumber(current.gtFeeAmount) + parseNumber(incoming.gtFeeAmount);
  const feeSource =
    current.feeSource === incoming.feeSource ? current.feeSource : "unknown";
  const feeCurrency =
    current.feeCurrency === incoming.feeCurrency
      ? current.feeCurrency
      : "多来源";
  const feeDisplayCurrency =
    current.feeDisplayCurrency === incoming.feeDisplayCurrency
      ? current.feeDisplayCurrency
      : "多来源";
  const feeAmount =
    feeCurrency === "多来源"
      ? "0"
      : trimNumber(
          parseNumber(current.feeAmount) + parseNumber(incoming.feeAmount),
          12
        );
  const feeDisplayAmount =
    feeDisplayCurrency === "多来源"
      ? ""
      : trimNumber(
          parseNumber(current.feeDisplayAmount) +
            parseNumber(incoming.feeDisplayAmount),
          12
        );
  const realizedValues = [
    current.realizedPnlUsd,
    incoming.realizedPnlUsd,
  ].filter((value): value is string => value !== null && value !== undefined);
  const realizedPnlUsd = realizedValues.length
    ? fixedNumber(
        realizedValues.reduce((sum, value) => sum + parseNumber(value), 0),
        2
      )
    : null;

  return {
    ...latest,
    quantity: trimNumber(quantity, 8),
    price:
      quantity > 0 && priceWeightedNotional > 0
        ? trimNumber(priceWeightedNotional / quantity, 8)
        : latest.price,
    notionalUsd: fixedNumber(notional, 2),
    feeUsd: fixedNumber(feeUsd, 4),
    feeAmount,
    feeCurrency,
    feeSource,
    pointFeeAmount: trimNumber(pointFee, 12),
    gtFeeAmount: trimNumber(gtFee, 12),
    feeDisplayAmount,
    feeDisplayCurrency,
    realizedPnlUsd,
    realizedPnlPct:
      latest.realizedPnlPct ??
      current.realizedPnlPct ??
      incoming.realizedPnlPct ??
      null,
    realizedPnlSource:
      latest.realizedPnlSource ??
      current.realizedPnlSource ??
      incoming.realizedPnlSource ??
      null,
    fillCount: fillIds.length,
    fillIds,
    isAggregated: fillIds.length > 1,
    cycleId: latest.cycleId ?? current.cycleId ?? incoming.cycleId,
    cycleStatus:
      latest.cycleStatus ?? current.cycleStatus ?? incoming.cycleStatus,
    cycleConfidence:
      latest.cycleConfidence ??
      current.cycleConfidence ??
      incoming.cycleConfidence,
    matchRole: latest.matchRole ?? current.matchRole ?? incoming.matchRole,
    matchedQty: latest.matchedQty ?? current.matchedQty ?? incoming.matchedQty,
    matchWarning:
      latest.matchWarning ?? current.matchWarning ?? incoming.matchWarning,
  };
}

function mergeRecords(
  current: TradeRecordItem[],
  incoming: TradeRecordItem[],
  mode: "append" | "prepend"
) {
  const merged =
    mode === "prepend" ? [...incoming, ...current] : [...current, ...incoming];
  const byKey = new Map<string, TradeRecordItem>();
  for (const record of merged.sort((left, right) => right.ts - left.ts)) {
    const key = recordKey(record);
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeDuplicateRecord(existing, record) : record);
  }
  return Array.from(byKey.values()).sort((left, right) => right.ts - left.ts);
}

function safeErrorFromPayload(payload: TradeRecordsResponse) {
  return (
    payload.safeErrorMessage ||
    payload.partialFailures?.map((failure) => failure.message).join(" / ") ||
    null
  );
}

function queryString({
  fromSec,
  toSec,
  cursorTs,
}: {
  fromSec: number;
  toSec: number;
  cursorTs?: number | null;
}) {
  const query = new URLSearchParams({
    from: String(fromSec),
    to: String(toSec),
    limit: String(BATCH_LIMIT),
  });
  if (cursorTs) query.set("cursorTs", String(cursorTs));
  return query.toString();
}

function feeSummaryQueryString({
  fromSec,
  toSec,
}: {
  fromSec: number;
  toSec: number;
}) {
  return new URLSearchParams({
    from: String(fromSec),
    to: String(toSec),
    includeYear: "true",
  }).toString();
}

function mockFeeSummary(records: TradeRecordItem[]) {
  const totalFeeUsd = summarizeTradeRecords(records).totalFeeUsd;
  const currentFee = Number(totalFeeUsd);
  return {
    totalFeeUsd,
    yearTotalFeeUsd: (currentFee * 12.4).toFixed(2),
  };
}

export function defaultTradeRecordsRange() {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    fromSec: nowSec - 30 * 24 * 60 * 60,
    toSec: nowSec,
  };
}

export function useTradeRecordsData({
  mode,
  fromSec,
  toSec,
  previewState = "normal",
}: {
  mode: TradeRecordsDataMode;
  fromSec: number;
  toSec: number;
  previewState?: "normal" | "loading" | "error" | "empty";
}) {
  const [records, setRecords] = useState<TradeRecordItem[]>(mockTradeRecords);
  const [summary, setSummary] = useState<TradeRecordsSummary>(
    mockTradeRecordsSummary
  );
  const [feeSummary, setFeeSummary] = useState<{
    totalFeeUsd: string;
    yearTotalFeeUsd?: string;
  } | null>(() => mockFeeSummary(mockTradeRecords));
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(mode === "mock");
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [nextCursorTs, setNextCursorTs] = useState<number | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(() =>
    Date.now()
  );
  const [connectionStatus, setConnectionStatus] =
    useState<TradeRecordsConnectionStatus>("connected");
  const [streamReconnectNonce, setStreamReconnectNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const recordsRef = useRef<TradeRecordItem[]>(records);
  const loadSnapshotRef = useRef<
    | ((options?: {
        cursorTs?: number | null;
        append?: boolean;
      }) => Promise<void>)
    | null
  >(null);
  const loadFeeSummaryRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current === null) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const scheduleReconnect = useCallback(
    (options: { cursorTs?: number | null; append?: boolean } = {}) => {
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        loadSnapshotRef.current?.(options);
        if (!options.append) loadFeeSummaryRef.current?.();
      }, RECONNECT_DELAY_MS);
    },
    [clearReconnectTimer]
  );

  const mockRecords = useMemo(() => {
    if (previewState === "empty") return [];
    return mockTradeRecords;
  }, [previewState]);

  const applyPayload = useCallback(
    (
      payload: TradeRecordsResponse,
      mergeMode: "replace" | "append" | "prepend"
    ) => {
      const incoming = Array.isArray(payload.records) ? payload.records : [];
      setRecords((current) => {
        const next =
          mergeMode === "replace"
            ? incoming
            : mergeRecords(current, incoming, mergeMode);
        setSummary(summarizeTradeRecords(next));
        return next;
      });
      setHasMoreHistory(Boolean(payload.hasMoreHistory));
      setNextCursorTs(payload.nextCursorTs || null);
      setLastUpdatedAt(payload.asOf || Date.now());
      setConnectionStatus(payload.connectionStatus || "connected");
      setError(
        payload.success === false ? safeErrorFromPayload(payload) : null
      );
      if (payload.success !== false) clearReconnectTimer();
    },
    [clearReconnectTimer]
  );

  const loadSnapshot = useCallback(
    async ({ cursorTs = null, append = false } = {}) => {
      if (mode !== "gate-api") return;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const response = await fetch(
          `${TRADE_RECORDS_ENDPOINT}?${queryString({ fromSec, toSec, cursorTs })}`,
          { headers: baseHeaders() }
        );
        const payload = (await response.json()) as TradeRecordsResponse;
        if (!response.ok || !payload?.success) {
          throw new Error(
            payload?.safeErrorMessage || "Gate trade records request failed."
          );
        }
        applyPayload(payload, append ? "append" : "replace");
        if (!append) setHasLoadedOnce(true);
      } catch (requestError) {
        const hasCachedRecords = recordsRef.current.length > 0;
        setConnectionStatus(hasCachedRecords ? "degraded" : "disconnected");
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Gate trade records request failed."
        );
        if (!append && !hasCachedRecords) {
          setRecords([]);
          setSummary(emptySummary);
          setHasMoreHistory(false);
          setNextCursorTs(null);
        }
        if (!append) setHasLoadedOnce(true);
        scheduleReconnect({ cursorTs, append });
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [applyPayload, fromSec, mode, scheduleReconnect, toSec]
  );

  const loadFeeSummary = useCallback(async () => {
    if (mode !== "gate-api") return;
    try {
      const response = await fetch(
        `${TRADE_RECORDS_FEE_SUMMARY_ENDPOINT}?${feeSummaryQueryString({
          fromSec,
          toSec,
        })}`,
        { headers: baseHeaders() }
      );
      const payload = (await response.json()) as TradeRecordsFeeSummaryResponse;
      if (!response.ok || !payload?.success) {
        throw new Error(
          payload?.safeErrorMessage || "Gate trade records fee summary failed."
        );
      }
      setFeeSummary({
        totalFeeUsd: payload.totalFeeUsd,
        yearTotalFeeUsd: payload.yearTotalFeeUsd,
      });
      if (payload.connectionStatus === "degraded") {
        setConnectionStatus("degraded");
      }
    } catch {
      setConnectionStatus("degraded");
    }
  }, [fromSec, mode, toSec]);

  useEffect(() => {
    loadSnapshotRef.current = loadSnapshot;
  }, [loadSnapshot]);

  useEffect(() => {
    loadFeeSummaryRef.current = loadFeeSummary;
  }, [loadFeeSummary]);

  const refresh = useCallback(() => {
    if (mode === "mock") {
      clearReconnectTimer();
      setRecords(mockRecords);
      const nextSummary = summarizeTradeRecords(mockRecords);
      setSummary(nextSummary);
      setFeeSummary(mockFeeSummary(mockRecords));
      setLastUpdatedAt(Date.now());
      setError(
        previewState === "error"
          ? "交易明细读取失败，当前为安全错误预览。"
          : null
      );
      setHasMoreHistory(false);
      setNextCursorTs(null);
      setHasLoadedOnce(true);
      setConnectionStatus(
        previewState === "error" ? "disconnected" : "connected"
      );
      return;
    }
    loadSnapshot({ append: false });
    loadFeeSummary();
  }, [
    clearReconnectTimer,
    loadFeeSummary,
    loadSnapshot,
    mockRecords,
    mode,
    previewState,
  ]);

  const loadMore = useCallback(async () => {
    if (mode !== "gate-api" || loading || loadingMore || !hasMoreHistory)
      return;
    await loadSnapshot({ cursorTs: nextCursorTs, append: true });
  }, [hasMoreHistory, loadSnapshot, loading, loadingMore, mode, nextCursorTs]);

  const forceHubWatchdogReconnect = useCallback(() => {
    if (mode !== "gate-api") return;
    clearReconnectTimer();
    abortRef.current?.abort();
    abortRef.current = null;
    loadSnapshot({ append: false });
    loadFeeSummary();
    setStreamReconnectNonce((current) => current + 1);
  }, [clearReconnectTimer, loadFeeSummary, loadSnapshot, mode]);

  useCryptoHubWatchedConnection({
    key: `tradeRecords.stream.${fromSec}.${toSec}`,
    active: mode === "gate-api",
    status: connectionStatus,
    lastConnectedAt: lastUpdatedAt,
    reconnect: forceHubWatchdogReconnect,
  });

  useEffect(() => {
    if (mode === "mock") {
      clearReconnectTimer();
      setRecords(mockRecords);
      const nextSummary = summarizeTradeRecords(mockRecords);
      setSummary(nextSummary);
      setFeeSummary(mockFeeSummary(mockRecords));
      setLoading(previewState === "loading");
      setError(
        previewState === "error"
          ? "交易明细读取失败，当前为安全错误预览。"
          : null
      );
      setHasMoreHistory(false);
      setNextCursorTs(null);
      setHasLoadedOnce(true);
      setConnectionStatus(
        previewState === "error" ? "disconnected" : "connected"
      );
      return;
    }

    setHasLoadedOnce(false);
    loadSnapshot({ append: false });
    loadFeeSummary();
  }, [
    clearReconnectTimer,
    fromSec,
    loadFeeSummary,
    loadSnapshot,
    mockRecords,
    mode,
    previewState,
    toSec,
  ]);

  useEffect(() => {
    if (mode !== "gate-api") {
      abortRef.current?.abort();
      abortRef.current = null;
      clearReconnectTimer();
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    fetchEventSource(
      `${TRADE_RECORDS_STREAM_ENDPOINT}?${queryString({ fromSec, toSec })}`,
      {
        method: "GET",
        headers: baseHeaders(),
        signal: controller.signal,
        openWhenHidden: false,
        async onopen(response) {
          if (response.ok) {
            setConnectionStatus("connected");
            setError(null);
            clearReconnectTimer();
            return;
          }
          throw new Error(
            `Gate trade records stream failed: ${response.status}`
          );
        },
        onmessage(message) {
          const envelope = parseCryptoHubSse<TradeRecordsResponse>(
            message.data
          );
          const payload =
            envelope?.data ||
            cryptoHubSseData<TradeRecordsResponse>(message.data) ||
            parseSseJson<TradeRecordsResponse>(message.data);
          if (!payload) return;
          if (payload.success === false) {
            setConnectionStatus("disconnected");
            setError(
              payload.safeErrorMessage || "Gate trade records stream failed."
            );
            return;
          }
          applyPayload(
            payload,
            envelope?.type === "snapshot" || message.event === "snapshot"
              ? "replace"
              : "prepend"
          );
        },
        onerror(error) {
          const hasCachedRecords = recordsRef.current.length > 0;
          setConnectionStatus(hasCachedRecords ? "degraded" : "disconnected");
          setError(
            error instanceof Error
              ? error.message
              : "Gate trade records stream failed."
          );
          scheduleReconnect({ append: false });
          return RECONNECT_DELAY_MS;
        },
      }
    ).catch(() => null);

    return () => {
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, [
    applyPayload,
    clearReconnectTimer,
    fromSec,
    mode,
    scheduleReconnect,
    streamReconnectNonce,
    toSec,
  ]);

  useEffect(() => {
    return () => {
      clearReconnectTimer();
    };
  }, [clearReconnectTimer]);

  return {
    records,
    summary,
    feeSummary,
    loading,
    loadingMore,
    hasLoadedOnce,
    error,
    hasMoreHistory,
    lastUpdatedAt,
    connectionStatus,
    refresh,
    loadMore,
  };
}
