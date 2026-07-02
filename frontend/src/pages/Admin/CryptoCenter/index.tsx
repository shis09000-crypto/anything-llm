import React, { Suspense, useEffect, useState } from "react";
import { useSoftSettingsShell } from "@/components/SoftSettings/context";
import { useCryptoHubInit } from "@/hooks/cryptoHub/useCryptoHubInit";
import { markCryptoCenterPerf } from "./perf";

const CryptoCenterContent = React.lazy(() => import("./CryptoCenterContent"));

function CryptoHubStatusPill({
  ready,
  running,
  error,
  progress,
  onRetry,
}: ReturnType<typeof useCryptoHubInit> & { onRetry: () => void }) {
  const pct = Math.round(progress?.overallPct || (ready ? 100 : 0));
  const label = ready
    ? "Crypto Hub 已就绪"
    : error
      ? "Crypto Hub 初始化异常"
      : running
        ? `Crypto Hub 初始化 ${pct}%`
        : "Crypto Hub 准备中";

  return (
    <div className="pointer-events-none fixed right-5 top-5 z-[120] flex justify-end">
      <div
        className={[
          "pointer-events-auto flex items-center gap-3 rounded-full border px-4 py-2 text-xs font-black shadow-[0_14px_46px_rgba(0,0,0,.35)] backdrop-blur-xl",
          ready
            ? "border-emerald-300/20 bg-emerald-950/45 text-emerald-100"
            : error
              ? "border-red-300/25 bg-red-950/50 text-red-100"
              : "border-[#D6A84F]/25 bg-black/55 text-[#E8C46B]",
        ].join(" ")}
      >
        <span
          className={[
            "h-2 w-2 rounded-full",
            ready ? "bg-emerald-300" : error ? "bg-red-300" : "bg-[#D6A84F]",
          ].join(" ")}
        />
        <span>{label}</span>
        {error ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full border border-white/15 px-2 py-1 text-[11px] text-white/85 hover:bg-white/10"
          >
            重试
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SkeletonCard({
  className = "",
  height = 220,
}: {
  className?: string;
  height?: number;
}) {
  return (
    <div
      className={[
        "relative overflow-hidden rounded-[28px] border border-[#D6A84F]/12 bg-white/[0.045] shadow-[0_24px_90px_rgba(0,0,0,.28)]",
        className,
      ].join(" ")}
      style={{ minHeight: height }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(214,168,79,.14),transparent_34%),linear-gradient(110deg,transparent,rgba(255,255,255,.06),transparent)]" />
      <div className="relative grid h-full content-between gap-5 p-7">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-full bg-[#D6A84F]/14" />
          <div className="grid flex-1 gap-3">
            <div className="h-4 w-40 rounded-full bg-white/12" />
            <div className="h-3 w-24 rounded-full bg-white/8" />
          </div>
        </div>
        <div className="grid gap-3">
          <div className="h-9 w-56 rounded-full bg-white/12" />
          <div className="h-3 w-full rounded-full bg-white/8" />
          <div className="h-3 w-2/3 rounded-full bg-white/8" />
        </div>
      </div>
    </div>
  );
}

function CryptoCenterShellFrame() {
  const hasPersistentSettingsShell = useSoftSettingsShell();

  useEffect(() => {
    markCryptoCenterPerf("shell_painted");
  }, []);

  return (
    <div
      className={[
        "overflow-hidden bg-[#08090b] text-slate-100",
        hasPersistentSettingsShell ? "h-full w-full" : "h-screen w-screen",
      ].join(" ")}
    >
      <div className="pointer-events-none fixed inset-0 z-0 h-screen w-screen bg-[#050505]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_0%,rgba(214,168,79,.18),transparent_34%),radial-gradient(circle_at_82%_12%,rgba(69,105,255,.12),transparent_32%),linear-gradient(180deg,rgba(12,12,13,.84),rgba(4,4,5,.98))]" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(214,168,79,.08)_1px,transparent_1px),linear-gradient(180deg,rgba(214,168,79,.06)_1px,transparent_1px)] bg-[size:58px_58px] opacity-20" />
      </div>

      <main className="relative z-10 h-full w-full overflow-y-auto bg-transparent">
        <div className="relative min-h-full overflow-hidden px-4 py-6 md:px-6 md:py-8">
          <div className="relative z-10 mx-auto grid min-h-[calc(100vh-48px)] w-full max-w-[1224px] content-start gap-6">
            <header className="w-full pt-1">
              <h1 className="text-3xl font-black tracking-normal text-[#D6A84F] drop-shadow-[0_0_22px_rgba(214,168,79,.22)] md:text-5xl">
                加密货币专区
              </h1>
              <p className="mt-2 text-sm font-semibold text-[#E8C46B]/70">
                Crypto Center
              </p>
              <div className="mt-5 h-px w-full bg-gradient-to-r from-[#D6A84F]/85 via-[#D6A84F]/42 to-transparent shadow-[0_0_18px_rgba(214,168,79,.26)]" />
            </header>

            <div className="grid gap-6 xl:grid-cols-[640px_560px]">
              <SkeletonCard height={380} />
              <SkeletonCard height={380} />
            </div>

            <div className="h-px w-full bg-gradient-to-r from-[#D6A84F]/90 via-[#D6A84F]/45 to-transparent shadow-[0_0_20px_rgba(214,168,79,.28)]" />

            <div>
              <h2 className="text-2xl font-black tracking-normal text-[#D6A84F] md:text-3xl">
                现货：BTC ETH专区
              </h2>
              <p className="mt-1 text-xs font-semibold uppercase tracking-normal text-[#E8C46B]/62">
                Spot Market
              </p>
            </div>

            <div className="grid gap-6 xl:grid-cols-[480px_1fr]">
              <SkeletonCard height={560} />
              <SkeletonCard height={560} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function CryptoCenter() {
  const hub = useCryptoHubInit();
  const [loadContent, setLoadContent] = useState(false);

  useEffect(() => {
    let timeout: number | null = null;
    let idleHandle: number | null = null;
    const schedule = () => setLoadContent(true);

    const raf = window.requestAnimationFrame(() => {
      if ("requestIdleCallback" in window) {
        idleHandle = window.requestIdleCallback(schedule, { timeout: 180 });
        return;
      }
      timeout = window.setTimeout(schedule, 90);
    });

    return () => {
      window.cancelAnimationFrame(raf);
      if (timeout) window.clearTimeout(timeout);
      if (idleHandle !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleHandle);
      }
    };
  }, []);

  useEffect(() => {
    if (hub.ready) markCryptoCenterPerf("hub_ready");
  }, [hub.ready]);

  return (
    <>
      {loadContent ? (
        <Suspense fallback={<CryptoCenterShellFrame />}>
          <CryptoCenterContent />
        </Suspense>
      ) : (
        <CryptoCenterShellFrame />
      )}
      <CryptoHubStatusPill {...hub} onRetry={hub.retry} />
    </>
  );
}
