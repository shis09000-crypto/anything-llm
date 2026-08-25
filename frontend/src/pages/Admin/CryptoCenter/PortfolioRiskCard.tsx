import React from "react";
import type { CryptoDashboardSnapshot } from "@/hooks/cryptoHub/useCryptoDashboard";

const LEVEL_STYLE = {
  safe: {
    label: "安全",
    tone: "text-emerald-300",
    badge: "border-emerald-400/25 bg-emerald-400/10",
  },
  watch: {
    label: "关注",
    tone: "text-amber-300",
    badge: "border-amber-400/25 bg-amber-400/10",
  },
  danger: {
    label: "危险",
    tone: "text-red-300",
    badge: "border-red-400/25 bg-red-400/10",
  },
};

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="min-h-[132px] rounded-2xl border border-white/10 bg-white/[0.045] p-5">
      <p className="text-sm font-bold leading-5 text-white/65">{label}</p>
      <p className="mt-3 text-2xl font-black leading-none text-white">
        {value}
      </p>
      {note ? (
        <p className="mt-3 text-xs font-medium leading-5 text-white/50">
          {note}
        </p>
      ) : null}
    </div>
  );
}

export default function PortfolioRiskCard({
  snapshot,
}: {
  snapshot: CryptoDashboardSnapshot | null;
}) {
  const risk = snapshot?.risk;
  const style = LEVEL_STYLE[risk?.level || "watch"];
  const formatPct = (value: number | null | undefined) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${numeric.toFixed(2)}%` : "--";
  };
  const formatMoney = (value: number | null | undefined) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `$${numeric.toFixed(2)}` : "$--";
  };

  return (
    <section className="overflow-hidden rounded-[28px] border border-[#D6A84F]/16 bg-black/45 p-5 shadow-[0_24px_90px_rgba(0,0,0,.30)] backdrop-blur-xl md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-[#E8C46B]/55">
            Portfolio Risk
          </p>
          <h2 className="mt-1 text-2xl font-black text-[#D6A84F]">
            组合风险中心
          </h2>
          <p className="mt-2 text-sm font-medium leading-6 text-white/58">
            确定性规则计算 · 只读 · 不生成交易指令
          </p>
        </div>
        <div
          className={`rounded-full border px-4 py-2 text-sm font-black ${style.badge} ${style.tone}`}
        >
          {risk ? `${style.label} · ${risk.score}` : "等待风险快照"}
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <Metric
          label="最大单资产占比"
          value={formatPct(risk?.metrics.largestAssetPct)}
          note={risk?.metrics.largestAsset || "--"}
        />
        <Metric
          label="稳定币占比"
          value={formatPct(risk?.metrics.stablecoinPct)}
        />
        <Metric
          label="合约名义价值 / 组合"
          value={formatPct(risk?.metrics.futuresToPortfolioPct)}
          note={formatMoney(risk?.metrics.futuresNotionalUsd)}
        />
        <Metric
          label="保证金压力"
          value={formatPct(risk?.metrics.marginPressurePct)}
          note={`初始 ${formatMoney(risk?.metrics.accountInitialMarginUsd)} · 维持 ${formatMoney(risk?.metrics.accountMaintenanceMarginUsd)}`}
        />
        <Metric
          label="最近强平参考距离"
          value={formatPct(risk?.metrics.minLiquidationDistancePct)}
          note="交叉保证金下仅供参考"
        />
        <Metric
          label="当前窗口最大回撤"
          value={formatPct(risk?.metrics.maxDrawdownPct)}
        />
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto]">
        <div className="grid gap-2">
          {risk?.alerts?.length ? (
            risk.alerts.map((alert) => (
              <div
                key={alert.id}
                className={`rounded-xl border px-4 py-3 ${alert.severity === "critical" ? "border-red-400/18 bg-red-400/[0.06]" : "border-amber-400/18 bg-amber-400/[0.06]"}`}
              >
                <p className="text-sm font-black text-white/88">
                  {alert.title}
                </p>
                <p className="mt-2 text-sm leading-6 text-white/62">
                  {alert.message}
                </p>
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-5 py-4 text-base font-bold leading-6 text-emerald-100/85">
              当前没有触发集中度、保证金、强平距离、回撤或新鲜度告警。
            </div>
          )}
        </div>
        <div className="min-w-[240px] rounded-xl border border-[#D6A84F]/16 bg-[#D6A84F]/[0.055] px-5 py-4 text-sm font-medium leading-6 text-white/58">
          <p>Gate 实盘：${snapshot?.portfolio.gate.totalValueUsd || "--"}</p>
          <p>
            补充持仓：${snapshot?.portfolio.supplemental.totalValueUsd || "--"}
          </p>
          <p>
            合计守恒：
            {snapshot?.portfolio.invariant.valid ? "通过" : "等待校验"}
          </p>
        </div>
      </div>
    </section>
  );
}
