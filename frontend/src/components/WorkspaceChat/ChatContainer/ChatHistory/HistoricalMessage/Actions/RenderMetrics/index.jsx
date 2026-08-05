import { formatDateTimeAsMoment } from "@/utils/directories";
import { formatDuration, numberWithCommas } from "@/utils/numbers";
import React, { useEffect, useState, useContext } from "react";
import { useTranslation } from "react-i18next";
import { mobileShellRuntimeActive } from "@/utils/mobileRuntime";
const MetricsContext = React.createContext();
const SHOW_METRICS_KEY = "anythingllm_show_chat_metrics";
const SHOW_METRICS_EVENT = "anythingllm_show_metrics_change";

/**
 * Format the output TPS to a string
 * @param {number} outputTps - output TPS
 * @returns {string}
 */
function formatTps(outputTps) {
  try {
    return outputTps < 1000
      ? outputTps.toFixed(2)
      : numberWithCommas(outputTps.toFixed(0));
  } catch {
    return "";
  }
}

/**
 * Get the show metrics setting from localStorage `anythingllm_show_chat_metrics` key
 * @returns {boolean}
 */
function getAutoShowMetrics() {
  return window?.localStorage?.getItem(SHOW_METRICS_KEY) === "true";
}

/**
 * Build the metrics string for a given metrics object
 * - Model name
 * - Duration and output TPS
 * - Timestamp
 * @param {metrics: {duration:number, outputTps: number, model?: string, timestamp?: number}} metrics
 * @returns {string}
 */
function buildMetricsString(
  metrics = {},
  execution = {},
  unknownModelLabel = ""
) {
  const model = execution?.model || metrics?.model || unknownModelLabel;
  const performance =
    metrics?.duration && metrics?.outputTps
      ? `${formatDuration(metrics.duration)} (${formatTps(metrics.outputTps)} tok/s)`
      : "";
  return [
    model,
    performance,
    metrics?.timestamp
      ? formatDateTimeAsMoment(metrics.timestamp, "MMM D, HH:mm")
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Toggle the show metrics setting in localStorage `anythingllm_show_chat_metrics` key
 * @returns {void}
 */
function toggleAutoShowMetrics() {
  const currentValue = getAutoShowMetrics() || false;
  window?.localStorage?.setItem(SHOW_METRICS_KEY, !currentValue);
  window.dispatchEvent(
    new CustomEvent(SHOW_METRICS_EVENT, {
      detail: { showMetricsAutomatically: !currentValue },
    })
  );
  return !currentValue;
}

/**
 * Provider for the metrics context that controls the visibility of the metrics
 * per-chat based on the user's preference.
 * @param {React.ReactNode} children
 * @returns {React.ReactNode}
 */
export function MetricsProvider({ children }) {
  const [showMetricsAutomatically, setShowMetricsAutomatically] =
    useState(getAutoShowMetrics());

  useEffect(() => {
    function handleShowingMetricsEvent(e) {
      if (!e?.detail?.hasOwnProperty("showMetricsAutomatically")) return;
      setShowMetricsAutomatically(e.detail.showMetricsAutomatically);
    }
    console.log("Adding event listener for metrics visibility");
    window.addEventListener(SHOW_METRICS_EVENT, handleShowingMetricsEvent);
    return () =>
      window.removeEventListener(SHOW_METRICS_EVENT, handleShowingMetricsEvent);
  }, []);

  return (
    <MetricsContext.Provider
      value={{ showMetricsAutomatically, setShowMetricsAutomatically }}
    >
      {children}
    </MetricsContext.Provider>
  );
}

/**
 * Render the metrics for a given chat, if available
 * @param {metrics: {duration:number, outputTps: number, model: string, timestamp: number}} props
 * @returns
 */
export default function RenderMetrics({ metrics = {}, execution = null }) {
  const { t } = useTranslation();
  // Inherit the showMetricsAutomatically state from the MetricsProvider so the state is shared across all chats
  const { showMetricsAutomatically, setShowMetricsAutomatically } =
    useContext(MetricsContext);
  const hasKnownModel = Boolean(execution?.model || metrics?.model);
  const hasExecutionEvidence = Boolean(execution);
  const hasPerformance = Boolean(metrics?.duration && metrics?.outputTps);
  if (
    (!hasKnownModel && !hasExecutionEvidence && !hasPerformance) ||
    mobileShellRuntimeActive()
  )
    return null;

  return (
    <button
      type="button"
      onClick={() => setShowMetricsAutomatically(toggleAutoShowMetrics())}
      data-tooltip-id="metrics-visibility"
      data-tooltip-content={
        showMetricsAutomatically
          ? t("chat_window.metrics_visibility.hover_only")
          : t("chat_window.metrics_visibility.always_show")
      }
      className={`border-none flex md:justify-end items-center gap-x-[8px] -ml-7 ${showMetricsAutomatically ? "opacity-100" : "opacity-0"} md:group-hover:opacity-100 motion-hover`}
    >
      <p className="cursor-pointer text-xs font-mono text-zinc-400 light:text-slate-500">
        {buildMetricsString(
          metrics,
          execution,
          t("chat_window.metrics_visibility.unknown_model")
        )}
      </p>
    </button>
  );
}
