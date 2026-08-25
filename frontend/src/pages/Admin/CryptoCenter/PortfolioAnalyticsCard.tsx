import React, { useMemo, useState } from "react";
import { cryptoHubFetch } from "@/hooks/cryptoHub/useCryptoHubQuery";
import type { CryptoDashboardSnapshot } from "@/hooks/cryptoHub/useCryptoDashboard";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";

type PerformanceWindow = "7d" | "30d" | "90d" | "365d";

type PerformanceResponse = {
  success: boolean;
  window: PerformanceWindow;
  history: {
    changeUsd?: number;
    changePct?: number;
    maxDrawdownPct?: number;
    nav?: number;
  };
  attribution: {
    totalGateEquityChangeUsd: number;
    futuresRealizedPnlUsd: number;
    futuresUnrealizedPnlUsd: number;
    feesUsd: number;
    fundingUsd: number | null;
    spotPriceEffectUsd: number | null;
    status: "partial";
    guidance: string;
  };
  coverage: {
    tradeHistoryDays: number;
    requestedDays: number;
    supplementalIncluded: false;
  };
};

type RebalanceResponse = {
  success: true;
  readOnly: true;
  executable: false;
  totalValueUsd: number;
  items: Array<{
    symbol: string;
    currentPct: number;
    targetPct: number;
    deltaUsd: number;
    direction: "increase" | "decrease" | "hold";
  }>;
};

function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "待分类";
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export default function PortfolioAnalyticsCard({
  snapshot,
}: {
  snapshot: CryptoDashboardSnapshot | null;
}) {
  const [window, setWindow] = useState<PerformanceWindow>("30d");
  const [performance, setPerformance] = useState<PerformanceResponse | null>(
    null
  );
  const [performanceLoading, setPerformanceLoading] = useState(false);
  const [targets, setTargets] = useState({ BTC: "45", ETH: "35", USDT: "20" });
  const [rebalance, setRebalance] = useState<RebalanceResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const targetTotal = useMemo(
    () =>
      Object.values(targets).reduce(
        (sum, value) => sum + (Number(value) || 0),
        0
      ),
    [targets]
  );

  async function loadPerformance(nextWindow = window) {
    setWindow(nextWindow);
    setPerformanceLoading(true);
    setMessage(null);
    try {
      const result = await requestPriorityQueue.schedule(
        ({ signal }: { signal: AbortSignal }) =>
          cryptoHubFetch<PerformanceResponse>(
            `/portfolio-performance?window=${nextWindow}`,
            {
              signal,
              communicationScene: "crypto-background",
              task: false,
            }
          ),
        {
          priority: "P3",
          label: `crypto:portfolio-performance:${nextWindow}`,
          kind: "crypto",
          scope: { route: "crypto-center", surface: "portfolio-performance" },
          policy: "background",
          dedupeKey: `crypto:portfolio-performance:${nextWindow}`,
        }
      );
      setPerformance(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "收益归因读取失败");
    } finally {
      setPerformanceLoading(false);
    }
  }

  async function simulate() {
    if (Math.abs(targetTotal - 100) > 0.01) {
      setMessage("目标比例合计必须为 100%。");
      return;
    }
    setMessage(null);
    try {
      const result = await cryptoHubFetch<RebalanceResponse>(
        "/rebalance-simulation",
        {
          method: "POST",
          body: JSON.stringify({
            targets: Object.fromEntries(
              Object.entries(targets).map(([symbol, value]) => [
                symbol,
                Number(value),
              ])
            ),
          }),
          headers: { "Content-Type": "application/json" },
          communicationScene: "crypto-visible",
          task: false,
        }
      );
      setRebalance(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "再平衡模拟失败");
    }
  }

  return (
    <section className="grid gap-5 rounded-[28px] border border-[#D6A84F]/16 bg-black/45 p-5 shadow-[0_24px_90px_rgba(0,0,0,.30)] backdrop-blur-xl lg:grid-cols-2 md:p-6">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-[#E8C46B]/55">
              Attribution
            </p>
            <h2 className="mt-1 text-xl font-black text-[#D6A84F]">
              Gate 收益与回撤
            </h2>
          </div>
          <div className="flex gap-1 rounded-xl bg-white/[0.04] p-1">
            {(["7d", "30d", "90d", "365d"] as PerformanceWindow[]).map(
              (item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => loadPerformance(item)}
                  className={`rounded-lg px-3 py-2 text-xs font-black ${window === item ? "bg-[#D6A84F] text-black" : "text-white/48 hover:text-white/80"}`}
                >
                  {item.toUpperCase()}
                </button>
              )
            )}
          </div>
        </div>
        {performance ? (
          <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl bg-white/[0.035] p-3">
              <p className="text-white/40">Gate 权益变化</p>
              <p className="mt-1 font-black text-white">
                {money(performance.attribution.totalGateEquityChangeUsd)}
              </p>
            </div>
            <div className="rounded-xl bg-white/[0.035] p-3">
              <p className="text-white/40">最大回撤</p>
              <p className="mt-1 font-black text-white">
                {(performance.history.maxDrawdownPct || 0).toFixed(2)}%
              </p>
            </div>
            <div className="rounded-xl bg-white/[0.035] p-3">
              <p className="text-white/40">合约已实现</p>
              <p className="mt-1 font-black text-white">
                {money(performance.attribution.futuresRealizedPnlUsd)}
              </p>
            </div>
            <div className="rounded-xl bg-white/[0.035] p-3">
              <p className="text-white/40">合约未实现</p>
              <p className="mt-1 font-black text-white">
                {money(performance.attribution.futuresUnrealizedPnlUsd)}
              </p>
            </div>
            <div className="rounded-xl bg-white/[0.035] p-3">
              <p className="text-white/40">手续费</p>
              <p className="mt-1 font-black text-white">
                {money(-Math.abs(performance.attribution.feesUsd))}
              </p>
            </div>
            <div className="rounded-xl bg-white/[0.035] p-3">
              <p className="text-white/40">资金费率 / 现货归因</p>
              <p className="mt-1 font-black text-white">待证据补齐</p>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => loadPerformance("30d")}
            disabled={performanceLoading}
            className="mt-5 rounded-xl border border-[#D6A84F]/25 bg-[#D6A84F]/10 px-4 py-3 text-sm font-black text-[#E8C46B] disabled:opacity-50"
          >
            {performanceLoading ? "正在读取…" : "按需加载 30 日归因"}
          </button>
        )}
        <p className="mt-4 text-[11px] leading-5 text-white/35">
          补充持仓不进入收益历史。无法确认的入金、转账、资金费率和现货价格归因不会被计作投资收益。
        </p>
      </div>

      <div className="border-white/8 lg:border-l lg:pl-5">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-[#E8C46B]/55">
          Simulation Only
        </p>
        <h2 className="mt-1 text-xl font-black text-[#D6A84F]">
          只读再平衡模拟
        </h2>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {Object.entries(targets).map(([symbol, value]) => (
            <label
              key={symbol}
              className="rounded-xl border border-white/8 bg-white/[0.035] p-3 text-xs text-white/45"
            >
              {symbol}
              <input
                value={value}
                inputMode="decimal"
                onChange={(event) =>
                  setTargets((current) => ({
                    ...current,
                    [symbol]: event.target.value,
                  }))
                }
                className="mt-2 w-full bg-transparent text-lg font-black text-white outline-none"
              />
              <span>%</span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span
            className={`text-xs font-bold ${Math.abs(targetTotal - 100) <= 0.01 ? "text-emerald-300" : "text-red-300"}`}
          >
            合计 {targetTotal.toFixed(2)}%
          </span>
          <button
            type="button"
            onClick={simulate}
            disabled={!snapshot}
            className="rounded-xl bg-[#D6A84F] px-4 py-3 text-sm font-black text-black disabled:opacity-40"
          >
            计算偏离金额
          </button>
        </div>
        {rebalance ? (
          <div className="mt-4 grid gap-2">
            {rebalance.items
              .filter((item) => Math.abs(item.deltaUsd) >= 0.01)
              .map((item) => (
                <div
                  key={item.symbol}
                  className="flex items-center justify-between rounded-lg bg-white/[0.035] px-3 py-2 text-xs"
                >
                  <span className="font-black text-white/75">
                    {item.symbol} · {item.currentPct.toFixed(2)}% →{" "}
                    {item.targetPct.toFixed(2)}%
                  </span>
                  <span
                    className={
                      item.deltaUsd >= 0 ? "text-emerald-300" : "text-amber-300"
                    }
                  >
                    {money(item.deltaUsd)}
                  </span>
                </div>
              ))}
            <p className="text-[11px] text-white/32">
              模拟结果不可执行，不会创建订单、划转或修改杠杆。
            </p>
          </div>
        ) : null}
        {message ? (
          <p className="mt-3 text-xs font-bold text-red-300/80">{message}</p>
        ) : null}
      </div>
    </section>
  );
}
