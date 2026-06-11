import React from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  WarningCircle,
} from "@phosphor-icons/react";

const phaseLabels = {
  initializing: "初始化加密数据中心",
  connecting: "连接加密数据中心",
  loading: "加载加密数据",
  ready: "已完成",
  degraded: "降级运行",
  error: "初始化失败",
};

const forceWhiteTextStyle = {
  color: "#FFFFFF",
  WebkitTextFillColor: "#FFFFFF",
  textShadow: "0 0 12px rgba(255,255,255,0.22)",
};

function statusTone(status) {
  if (status === "ready") return "已完成";
  if (status === "degraded") return "降级";
  if (status === "error") return "失败";
  if (status === "loading") return "加载中";
  return "等待";
}

export default function CryptoHubLoadingOverlay({ progress, error, onRetry }) {
  const pct = progress?.overallPct || 0;
  const phase = progress?.phase || "initializing";

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-[#05070A]/88 px-4 backdrop-blur-xl light:bg-slate-950/70">
      <div
        className="w-full max-w-[560px] rounded-[28px] border border-[#D6A84F]/25 bg-[#090D13]/95 p-6 text-white shadow-[0_30px_90px_rgb(0_0_0_/_0.42)]"
        style={forceWhiteTextStyle}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div
              className="text-lg font-bold text-white"
              style={forceWhiteTextStyle}
            >
              初始化加密数据中心
            </div>
            <div
              className="mt-2 text-sm text-white"
              style={forceWhiteTextStyle}
            >
              {phaseLabels[phase] || phaseLabels.initializing}
            </div>
          </div>
          {phase === "ready" || phase === "degraded" ? (
            <CheckCircle
              className="h-7 w-7 text-emerald-300"
              weight="duotone"
            />
          ) : error || phase === "error" ? (
            <WarningCircle className="h-7 w-7 text-red-300" weight="duotone" />
          ) : (
            <ArrowsClockwise
              className="h-7 w-7 animate-spin text-[#D6A84F]"
              weight="bold"
            />
          )}
        </div>

        <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full w-full rounded-full bg-[#D6A84F]"
            style={{
              transform: `scaleX(${Math.max(4, Math.min(100, pct)) / 100})`,
              transformOrigin: "left center",
              transition:
                "transform var(--motion-panel-duration) var(--motion-ease-standard)",
            }}
          />
        </div>
        <div
          className="mt-2 text-right text-xs font-bold text-white"
          style={forceWhiteTextStyle}
        >
          {pct}%
        </div>

        <div className="mt-5 grid gap-2">
          {(progress?.items || []).map((item) => (
            <div
              key={item.key}
              className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/[.035] px-3 py-2"
            >
              <div>
                <div
                  className="text-xs font-bold text-white"
                  style={forceWhiteTextStyle}
                >
                  {item.label}
                </div>
                <div
                  className="mt-0.5 text-[11px] text-white"
                  style={forceWhiteTextStyle}
                >
                  {item.safeErrorMessage || item.message || ""}
                </div>
              </div>
              <div
                className="min-w-[64px] text-right text-xs font-bold text-white"
                style={forceWhiteTextStyle}
              >
                {statusTone(item.status)}
              </div>
            </div>
          ))}
        </div>

        {error || phase === "error" ? (
          <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-100">
            <span>{error || "Crypto Hub 初始化失败"}</span>
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg border border-red-200/30 px-3 py-1 font-bold text-white transition hover:bg-red-300/10"
            >
              重试
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
