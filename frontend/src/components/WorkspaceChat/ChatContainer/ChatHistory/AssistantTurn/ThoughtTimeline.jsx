import { useMemo, useState } from "react";
import { CaretDown, Check, Hammer, Warning } from "@phosphor-icons/react";
import AgentAnimation from "@/media/animations/agent-animation.webm";
import AgentStatic from "@/media/animations/agent-static.png";

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

function toolSummary(event = {}) {
  const toolName = event.toolName || "tool";
  const isError = event.type === "tool_result" && isErroredToolResult(event);
  const status =
    event.type === "tool_call" ? "Calling" : isError ? "Errored" : "Returned";
  const preview = compactText(toolPayload(event));
  return `${status} ${toolName}${preview ? `: ${preview}` : ""}`;
}

function normalizeDisplayEvent(event = {}, index) {
  const displayType = ["tool_call", "tool_result"].includes(event.type)
    ? "tool"
    : "thought";
  return {
    ...event,
    displayType,
    displayContent: displayType === "tool" ? toolSummary(event) : event.content,
    sortTime: event.createdAt || event.requestedAt || event.timestamp || 0,
    originalIndex: index,
  };
}

export default function ThoughtTimeline({
  events = [],
  toolEvents = [],
  isRunning = false,
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const visibleEvents = useMemo(
    () =>
      [...events, ...toolEvents]
        .map(normalizeDisplayEvent)
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
    [events, toolEvents]
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
                data-tooltip-content="Agent is thinking..."
                aria-label="Agent is thinking..."
              >
                <source src={AgentAnimation} type="video/webm" />
              </video>
            ) : (
              <img
                src={AgentStatic}
                alt="Agent complete"
                className="w-[18px] h-[18px] motion-hover light:invert light:opacity-50"
                data-tooltip-id="agent-thinking"
                data-tooltip-content="Agent has finished thinking"
                aria-label="Agent has finished thinking"
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
                isExpanded ? "Hide thought chain" : "Show thought chain"
              }
              aria-label={
                isExpanded ? "Hide thought chain" : "Show thought chain"
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
                  {currentEvent?.displayContent ||
                    (isRunning ? "Working..." : "Finished.")}
                </span>
              ) : (
                <div className="space-y-2">
                  {visibleEvents.map((event) =>
                    event.displayType === "tool" ? (
                      <ToolTimelineRow key={event.id} event={event} />
                    ) : (
                      <div key={event.id}>{event.content}</div>
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
  const isCall = event.type === "tool_call";
  const isError = event.type === "tool_result" && isErroredToolResult(event);
  const status = isCall ? "Calling" : isError ? "Errored" : "Returned";
  const timestamp = formatTimestamp(event);
  const payload = compactText(toolPayload(event), 500);
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
            {status} {event.toolName || "tool"}
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
