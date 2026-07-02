import React, { useEffect, useMemo } from "react";
import OpenFuturesPositionsCard from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/OpenFuturesPositionsCard";
import TradeRecordsTable from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/TradeRecordsTable";
import {
  mockOpenFuturesPositions,
  mockOpenFuturesSummary,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/openFuturesPositionsMockData";
import { useOpenFuturesPositionsData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useOpenFuturesPositionsData";
import { useTradeRecordsTableController } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useTradeRecordsTableController";
import type { OpenFuturesPositionsCardProps } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/openFuturesPositionsTypes";
import { markCryptoCenterPerf } from "./perf";

export default function FuturesTradingSection({
  contentMaxWidth,
  positionsHeight,
  visiblePositionCount,
  tradeRecordsHeight,
}: {
  contentMaxWidth: number;
  positionsHeight: number;
  visiblePositionCount: number;
  tradeRecordsHeight: number;
}) {
  useEffect(() => {
    markCryptoCenterPerf("trade_records_chunk_loaded");
  }, []);

  const openFuturesPositions = useOpenFuturesPositionsData({
    mode: "gate-api",
    mockPositions: mockOpenFuturesPositions,
    mockSummary: mockOpenFuturesSummary,
  });
  const tradeRecordsController = useTradeRecordsTableController({
    mode: "gate-api",
    initialRangePreset: "30d",
    initialPageSize: 10,
  });
  const openFuturesPositionsParams = useMemo<OpenFuturesPositionsCardProps>(
    () => ({
      positions: openFuturesPositions.positions,
      summary: openFuturesPositions.summary,
      filterLabel: "全部合约",
      lastUpdatedAt: openFuturesPositions.lastUpdatedAt,
      loading: openFuturesPositions.loading,
      error: openFuturesPositions.error,
      status: openFuturesPositions.status,
      onRefresh: openFuturesPositions.refresh,
      cardWidth: contentMaxWidth,
      cardHeight: positionsHeight,
      visiblePositionCount,
      borderRadius: 28,
      compactMode: false,
      showSummaryFooter: true,
      showLeverageBars: true,
    }),
    [
      contentMaxWidth,
      openFuturesPositions,
      positionsHeight,
      visiblePositionCount,
    ]
  );

  return (
    <>
      <div
        className="mx-auto w-full max-w-full overflow-x-hidden"
        style={{ maxWidth: contentMaxWidth }}
      >
        <OpenFuturesPositionsCard {...openFuturesPositionsParams} />
      </div>
      <div
        className="mx-auto w-full max-w-full overflow-x-hidden"
        style={{ maxWidth: contentMaxWidth }}
      >
        <TradeRecordsTable
          {...tradeRecordsController.tableProps}
          cardWidth={contentMaxWidth}
          cardHeight={tradeRecordsHeight}
          borderRadius={28}
          compactMode={false}
        />
      </div>
    </>
  );
}
