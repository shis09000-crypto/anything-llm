import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowClockwise,
  CaretDown,
  CheckCircle,
  Pulse,
  Question,
  WarningCircle,
} from "@phosphor-icons/react";
import paths from "@/utils/paths";
import { useWorkspaceHealth } from "@/contexts/WorkspaceHealthProvider";
import { useTranslation } from "react-i18next";

const CLOSE_DELAY_MS = 400;
const SEVERITY_RANK = {
  critical: 3,
  warning: 2,
  info: 1,
};

function dateLocale(language = "zh") {
  if (String(language).startsWith("ja")) return "ja-JP";
  if (String(language).startsWith("en")) return "en-US";
  return "zh-CN";
}

function formatTime(value, locale, fallback) {
  if (!value) return fallback;
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return fallback;
  }
}

function statusTone(beacon, score) {
  if (!beacon || beacon.unknown) {
    return {
      ring: "ring-slate-400/30",
      bg: "bg-slate-500/16 light:bg-slate-100",
      text: "text-slate-300 light:text-slate-600",
      dot: "bg-slate-400",
      glass: "liquid-glass-health-unknown",
    };
  }
  if (beacon.processing) {
    return {
      ring: "ring-sky-400/40 animate-pulse",
      bg: "bg-sky-500/18 light:bg-sky-100",
      text: "text-sky-200 light:text-sky-700",
      dot: "bg-sky-400",
      glass: "liquid-glass-health-processing",
    };
  }
  if (score >= 90) {
    return {
      ring: "ring-emerald-400/35",
      bg: "bg-emerald-500/18 light:bg-emerald-100",
      text: "text-emerald-200 light:text-emerald-700",
      dot: "bg-emerald-400",
      glass: "liquid-glass-health-healthy",
    };
  }
  if (score >= 70) {
    return {
      ring: "ring-yellow-400/35",
      bg: "bg-yellow-500/18 light:bg-yellow-100",
      text: "text-yellow-100 light:text-yellow-700",
      dot: "bg-yellow-400",
      glass: "liquid-glass-health-warning",
    };
  }
  if (score >= 50) {
    return {
      ring: "ring-orange-400/35",
      bg: "bg-orange-500/18 light:bg-orange-100",
      text: "text-orange-100 light:text-orange-700",
      dot: "bg-orange-400",
      glass: "liquid-glass-health-degraded",
    };
  }
  return {
    ring: "ring-red-400/40",
    bg: "bg-red-500/18 light:bg-red-100",
    text: "text-red-100 light:text-red-700",
    dot: "bg-red-400",
    glass: "liquid-glass-health-critical",
  };
}

function statusIcon(beacon, score) {
  if (!beacon || beacon.unknown) return <Question size={16} weight="bold" />;
  if (beacon.processing) return <Pulse size={16} weight="bold" />;
  if (score >= 90) return <CheckCircle size={16} weight="fill" />;
  return <WarningCircle size={16} weight="fill" />;
}

function statusLabel(beacon, score, t) {
  if (!beacon || beacon.unknown) return t("workspace-health.unknown");
  if (beacon.processing) return t("workspace-health.processing");
  if (score >= 90) return t("workspace-health.healthy");
  if (score >= 70) return t("workspace-health.attention");
  if (score >= 50) return t("workspace-health.degraded");
  return t("workspace-health.critical");
}

function eventTone(severity = "info") {
  if (severity === "critical") {
    return "border-red-400/40 bg-red-500/10 shadow-[0_0_18px_rgba(248,113,113,0.22)] light:bg-red-50 light:border-red-200";
  }
  if (severity === "warning") {
    return "border-yellow-400/40 bg-yellow-500/10 shadow-[0_0_18px_rgba(250,204,21,0.20)] light:bg-yellow-50 light:border-yellow-200";
  }
  return "border-white/10 bg-white/[0.03] light:border-slate-100 light:bg-slate-50";
}

function eventTextTone(severity = "info") {
  if (severity === "critical") return "text-red-100 light:text-red-700";
  if (severity === "warning") return "text-yellow-100 light:text-yellow-700";
  return "text-white/80 light:text-slate-700";
}

function severityLabel(severity = "info", t) {
  if (severity === "critical") return t("workspace-health.critical");
  if (severity === "warning") return t("workspace-health.warning");
  return t("workspace-health.info");
}

export default function WorkspaceHealthBeacon({
  workspaceSlug,
  className = "",
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const health = useWorkspaceHealth();
  const closeTimer = useRef(null);
  const popoverRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const beacon = health?.beacon;
  const score = health?.displayScore ?? beacon?.score ?? null;
  const tone = useMemo(() => statusTone(beacon, score), [beacon, score]);
  const cooldownSeconds = Math.ceil((health?.cooldownRemainingMs || 0) / 1000);
  const destination = workspaceSlug
    ? paths.workspace.settings.healthCenter(workspaceSlug)
    : null;

  function openHealthCenter() {
    if (!destination) return;
    navigate(destination);
  }

  function showPopover() {
    clearTimeout(closeTimer.current);
    setOpen(true);
  }

  function scheduleClose() {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (popoverRef.current?.contains(document.activeElement)) return;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  }

  useEffect(() => {
    return () => clearTimeout(closeTimer.current);
  }, []);

  const locale = dateLocale(i18n.language);
  const fallbackTime = t("workspace-health.unavailable");
  const ariaScore = beacon?.unknown
    ? t("workspace-health.unknown")
    : `${score ?? "--"} ${t("workspace-health.scoreUnit")}`;
  const localizedStatus = statusLabel(beacon, score, t);
  const ariaStatus = localizedStatus;
  const abnormalEvents = useMemo(() => {
    const issues = (beacon?.topIssues || []).map((item) => ({
      ...item,
      type: "issue",
      createdAt: beacon?.lastUpdatedAt,
      severity: item.severity || "warning",
    }));
    const abnormalActivities = (beacon?.latestActivities || []).filter(
      (activity) => ["warning", "critical"].includes(activity.severity)
    );
    return [...issues, ...abnormalActivities]
      .sort(
        (a, b) =>
          (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0)
      )
      .slice(0, 5);
  }, [beacon]);
  const normalActivities = useMemo(
    () =>
      (beacon?.latestActivities || []).filter(
        (activity) => !["warning", "critical"].includes(activity.severity)
      ),
    [beacon]
  );

  return (
    <div
      className={`relative ${className}`}
      onPointerEnter={showPopover}
      onPointerLeave={scheduleClose}
      onFocusCapture={showPopover}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        scheduleClose();
      }}
    >
      <button
        type="button"
        aria-label={t("workspace-health.ariaOpen", {
          score: ariaScore,
          status: ariaStatus,
        })}
        title={t("workspace-health.title")}
        onClick={openHealthCenter}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            event.currentTarget.blur();
          }
        }}
        className={`liquid-glass-control liquid-glass-health ${tone.glass} group cursor-pointer flex items-center justify-center w-[35px] h-[35px] rounded-full ${tone.ring} ${tone.text} focus:outline-none focus:ring-2 focus:ring-sky-400`}
      >
        <span className="relative flex items-center justify-center">
          {score === null ? (
            statusIcon(beacon, score)
          ) : (
            <span className="text-[11px] font-bold leading-none">{score}</span>
          )}
          <span
            className={`absolute -right-[9px] -top-[8px] h-2 w-2 rounded-full ${tone.dot}`}
          />
        </span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t("workspace-health.title")}
          className="absolute right-0 top-[43px] z-50 flex max-h-[430px] w-[330px] flex-col overflow-hidden rounded-xl border border-white/10 light:border-slate-200 bg-zinc-900/95 light:bg-white shadow-2xl backdrop-blur text-white light:text-slate-800"
          onPointerEnter={showPopover}
          onPointerLeave={scheduleClose}
        >
          <div className="flex items-start justify-between gap-3 border-b border-white/10 light:border-slate-100 p-4 pb-3">
            <div>
              <div className="text-sm font-semibold">
                {t("workspace-health.title")}
              </div>
              <div className="mt-1 text-xs text-white/60 light:text-slate-500">
                {t("workspace-health.lastUpdated", {
                  time: formatTime(beacon?.lastUpdatedAt, locale, fallbackTime),
                })}
              </div>
            </div>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${tone.bg} ${tone.text}`}
            >
              {statusIcon(beacon, score)}
              {localizedStatus}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 pr-3">
            <p className="text-sm leading-5 text-white/80 light:text-slate-700">
              {beacon?.summary || t("workspace-health.summaryFallback")}
            </p>

            <div className="mt-3 rounded-lg bg-white/5 light:bg-slate-50 p-3 text-xs">
              <div className="font-semibold text-white/80 light:text-slate-700">
                {t("workspace-health.dataSourceTimes")}
              </div>
              <div className="mt-2 grid grid-cols-1 gap-1 text-white/55 light:text-slate-500">
                <span>
                  {t("workspace-health.summaryCache", {
                    time: formatTime(
                      beacon?.sourceTimes?.summaryCacheUpdatedAt,
                      locale,
                      fallbackTime
                    ),
                  })}
                </span>
                <span>
                  {t("workspace-health.latestActivity", {
                    time: formatTime(
                      beacon?.sourceTimes?.latestActivityAt,
                      locale,
                      fallbackTime
                    ),
                  })}
                </span>
                <span>
                  {t("workspace-health.workerHeartbeat", {
                    time: formatTime(
                      beacon?.sourceTimes?.latestWorkerHeartbeatAt,
                      locale,
                      fallbackTime
                    ),
                  })}
                </span>
              </div>
            </div>

            {beacon?.processingMessages?.length > 0 && (
              <div className="mt-3 rounded-lg border border-sky-400/20 bg-sky-500/10 p-3 text-xs text-sky-100 light:text-sky-700">
                <div className="font-semibold">
                  {t("workspace-health.processingTitle")}
                </div>
                <ul className="mt-2 space-y-1">
                  {beacon.processingMessages.map((message) => (
                    <li key={message}>- {message}</li>
                  ))}
                </ul>
              </div>
            )}

            {abnormalEvents.length > 0 && (
              <div className="mt-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-yellow-100 light:text-yellow-700">
                  <WarningCircle size={14} weight="fill" />
                  {t("workspace-health.abnormalEvents")}
                </div>
                <div className="space-y-2">
                  {abnormalEvents.map((item) => (
                    <div
                      key={`${item.type}-${item.title}-${item.detail}-${item.createdAt}`}
                      className={`rounded-lg border px-3 py-2 text-xs ${eventTone(item.severity)}`}
                    >
                      <div
                        className={`flex items-center justify-between gap-2 font-semibold ${eventTextTone(item.severity)}`}
                      >
                        <span>{item.title}</span>
                        <span className="shrink-0 rounded-full bg-black/20 light:bg-white/70 px-1.5 py-0.5 text-[10px]">
                          {severityLabel(item.severity, t)}
                        </span>
                      </div>
                      <div className="mt-1 text-white/55 light:text-slate-500">
                        {item.detail}
                        {item.createdAt
                          ? ` · ${formatTime(item.createdAt, locale, fallbackTime)}`
                          : ""}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-white/70 light:text-slate-600">
                <Activity size={14} />
                {t("workspace-health.recentActivity")}
              </div>
              <div className="space-y-2">
                {normalActivities.slice(0, 5).map((activity) => (
                  <div
                    key={`${activity.type}-${activity.createdAt}-${activity.title}`}
                    className={`rounded-lg border px-3 py-2 text-xs ${eventTone(activity.severity)}`}
                  >
                    <div
                      className={`font-medium ${eventTextTone(activity.severity)}`}
                    >
                      {activity.title}
                    </div>
                    <div className="mt-1 text-white/50 light:text-slate-500">
                      {activity.detail} ·{" "}
                      {formatTime(activity.createdAt, locale, fallbackTime)}
                    </div>
                  </div>
                ))}
                {normalActivities.length === 0 && (
                  <div className="text-xs text-white/45 light:text-slate-500">
                    {t("workspace-health.noRecentActivity")}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowAdvanced((current) => !current)}
              className="mt-3 flex w-full items-center justify-between rounded-lg border border-white/10 light:border-slate-200 px-3 py-2 text-xs text-white/70 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-50"
            >
              {t("workspace-health.advancedInfo")}
              <CaretDown
                size={14}
                className={`motion-hover ${showAdvanced ? "rotate-180" : ""}`}
              />
            </button>
            {showAdvanced && (
              <pre className="mt-2 max-h-[150px] overflow-auto rounded-lg bg-black/25 light:bg-slate-100 p-3 text-[11px] leading-5 text-white/65 light:text-slate-600">
                {JSON.stringify(beacon?.advanced || {}, null, 2)}
              </pre>
            )}

            {workspaceSlug && (
              <button
                type="button"
                onClick={() =>
                  navigate(paths.workspace.settings.readingTools(workspaceSlug))
                }
                className="mt-2 w-full rounded-lg px-3 py-2 text-xs text-white/55 light:text-slate-500 hover:bg-white/5 light:hover:bg-slate-50"
              >
                {t("workspace-health.adjustReadingTools")}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-white/10 light:border-slate-100 p-3">
            <button
              type="button"
              disabled={cooldownSeconds > 0 || health?.loading}
              onClick={(event) => {
                event.stopPropagation();
                health?.refreshBeacon?.();
              }}
              className="flex items-center gap-1 rounded-lg border border-white/10 light:border-slate-200 px-3 py-2 text-xs font-semibold text-white/75 light:text-slate-700 hover:bg-white/5 light:hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowClockwise size={14} />
              {cooldownSeconds > 0
                ? `${cooldownSeconds}s`
                : t("common.refresh")}
            </button>
            <button
              type="button"
              onClick={openHealthCenter}
              className="flex-1 rounded-lg bg-sky-500 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-400"
            >
              {t("workspace-health.fullDiagnostics")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
