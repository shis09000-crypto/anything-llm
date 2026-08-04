import { useMemo, useState } from "react";
import { CaretDown, Check, Hammer, Warning } from "@phosphor-icons/react";
import AgentAnimation from "@/media/animations/agent-animation.webm";
import AgentStatic from "@/media/animations/agent-static.png";
import { useTranslation } from "react-i18next";
import {
  displayToolName,
  formatTimelineContent,
  formatToolPayloadPreview,
  formatToolStatus,
} from "@/utils/chat/toolTimelineI18n";
import { useThoughtExpansion } from "../ThoughtContainer";

function formatPayload(data) {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function compactText(data, maxLength = 220) {
  const text = formatPayload(data).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function formatTimestamp(event = {}) {
  const timestamp = event.createdAt || event.requestedAt || event.timestamp;
  if (!timestamp) return null;

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isErroredToolResult(event = {}) {
  const status = String(event.status || "").toLowerCase();
  const exitCode = Number(event.exitCode);
  return (
    status.includes("error") ||
    status.includes("fail") ||
    !!event.error ||
    !!event.errorMessage ||
    !!event.storageError ||
    event.timedOut === true ||
    event.isError === true ||
    (event.exitCode !== undefined && !Number.isNaN(exitCode) && exitCode !== 0)
  );
}

function toolPayload(event = {}) {
  if (event.type === "tool_call")
    return event.args ?? event.payload ?? event.content;
  return (
    event.outputPreview ??
    event.summary ??
    event.result ??
    event.errorMessage ??
    event.error ??
    event.content
  );
}

function toolSummary(event = {}, t) {
  const status = formatToolStatus(event, t);
  const toolName = displayToolName(event.toolName, t);
  const preview = formatToolPayloadPreview(compactText(toolPayload(event)), t);
  return `${status} ${toolName}${preview ? `: ${preview}` : ""}`;
}

function normalizeDisplayEvent(event = {}, index, t) {
  const displayType = ["tool_call", "tool_result"].includes(event.type)
    ? "tool"
    : "thought";
  return {
    ...event,
    displayType,
    displayContent:
      displayType === "tool"
        ? toolSummary(event, t)
        : formatTimelineContent(event.content, t),
    sortTime: event.createdAt || event.requestedAt || event.timestamp || 0,
    originalIndex: index,
  };
}

export default function ThoughtTimeline({
  events = [],
  toolEvents = [],
  isRunning = false,
  stateId = null,
}) {
  const { t } = useTranslation();
  const { expanded: persistedExpanded, setExpanded: setPersistedExpanded } =
    useThoughtExpansion(stateId);
  const [localExpanded, setLocalExpanded] = useState(false);
  const isExpanded = stateId ? persistedExpanded : localExpanded;
  const setIsExpanded = stateId ? setPersistedExpanded : setLocalExpanded;
  const visibleEvents = useMemo(
    () =>
      [...events, ...toolEvents]
        .map((event, index) => normalizeDisplayEvent(event, index, t))
        .filter((event) => {
          if (event.displayType === "tool") return !!event.displayContent;
          return !!event.content;
        })
        .sort((a, b) => {
          if (a.sortTime && b.sortTime && a.sortTime !== b.sortTime) {
            return a.sortTime - b.sortTime;
          }
          if (a.sortTime && !b.sortTime) return -1;
          if (!a.sortTime && b.sortTime) return 1;
          return a.originalIndex - b.originalIndex;
        }),
    [events, toolEvents, t]
  );
  if (visibleEvents.length === 0 && !isRunning) return null;

  const currentEvent = visibleEvents[visibleEvents.length - 1];
  const canExpand = visibleEvents.length > 1;

  function handleExpandClick() {
    if (!canExpand) return;
    setIsExpanded(!isExpanded);
  }

  return (
    <div className="flex justify-center w-full pr-4 my-1">
      <div className="w-full flex flex-col">
        <div
          onClick={handleExpandClick}
          className="relative bg-zinc-800 light:bg-slate-100 p-4 rounded-2xl"
        >
          <div className="absolute top-4 left-4 w-[18px] h-[18px]">
            {isRunning ? (
              <video
                autoPlay
                loop
                muted
                playsInline
                className="w-[18px] h-[18px] scale-[165%] motion-hover light:invert light:opacity-50"
                data-tooltip-id="agent-thinking"
                data-tooltip-content={t(
                  "chat_window.toolTimeline.agentThinking"
                )}
                aria-label={t("chat_window.toolTimeline.agentThinking")}
              >
                <source src={AgentAnimation} type="video/webm" />
              </video>
            ) : (
              <img
                src={AgentStatic}
                alt={t("chat_window.toolTimeline.agentComplete")}
                className="w-[18px] h-[18px] motion-hover light:invert light:opacity-50"
                data-tooltip-id="agent-thinking"
                data-tooltip-content={t(
                  "chat_window.toolTimeline.agentComplete"
                )}
                aria-label={t("chat_window.toolTimeline.agentComplete")}
              />
            )}
          </div>
          {canExpand && (
            <button
              type="button"
              onClick={handleExpandClick}
              className="absolute top-4 right-4 border-none text-zinc-200 light:text-slate-800 motion-hover"
              data-tooltip-id="expand-cot"
              data-tooltip-content={
                isExpanded
                  ? t("chat_window.toolTimeline.hideThoughtChain")
                  : t("chat_window.toolTimeline.showThoughtChain")
              }
              aria-label={
                isExpanded
                  ? t("chat_window.toolTimeline.hideThoughtChain")
                  : t("chat_window.toolTimeline.showThoughtChain")
              }
            >
              <CaretDown
                className={`w-4 h-4 transform motion-hover ${isExpanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
          <div
            className={`ml-[28px] mr-[26px] transition-[max-height] origin-top ${isExpanded ? "" : "overflow-hidden max-h-[18px]"}`}
          >
            <div className="text-zinc-200 light:text-slate-800 font-mono text-sm leading-[18px]">
              {!isExpanded ? (
                <span className="block w-full truncate">
                  {isRunning
                    ? currentEvent?.displayContent ||
                      t("chat_window.toolTimeline.status.working")
                    : t("chat_window.toolTimeline.agentComplete")}
                </span>
              ) : (
                <div className="space-y-2">
                  {visibleEvents.map((event) =>
                    event.displayType === "tool" ? (
                      <ToolTimelineRow key={event.id} event={event} />
                    ) : (
                      <div key={event.id}>{event.displayContent}</div>
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolTimelineRow({ event }) {
  const { t } = useTranslation();
  const isCall = event.type === "tool_call";
  const isError = event.type === "tool_result" && isErroredToolResult(event);
  const status = formatToolStatus(event, t);
  const timestamp = formatTimestamp(event);
  const payload = formatToolPayloadPreview(
    compactText(toolPayload(event), 500),
    t
  );
  const error = compactText(
    event.errorMessage || event.error || event.storageError || "",
    500
  );

  return (
    <div className="flex gap-2 text-xs leading-5 text-zinc-300 light:text-slate-700">
      <span className="mt-[2px] shrink-0">
        {isCall ? (
          <Hammer size={14} />
        ) : isError ? (
          <Warning size={14} className="text-red-400 light:text-red-600" />
        ) : (
          <Check size={14} className="text-green-400 light:text-green-600" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
          <span className="font-semibold text-zinc-100 light:text-slate-900">
            {status} {displayToolName(event.toolName, t)}
          </span>
          {timestamp && (
            <span className="text-[11px] text-zinc-500 light:text-slate-500">
              {timestamp}
            </span>
          )}
        </div>
        {payload && (
          <div className="break-words text-zinc-400 light:text-slate-600">
            {payload}
          </div>
        )}
        {error && error !== payload && (
          <div className="break-words text-red-300 light:text-red-600">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
