import { X } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { READER_EVENT_OPEN_DRAWER } from "./storage";

export function readerSourcesForTurn(sourcesByTurn = {}, chatKey, turn = {}) {
  const keys = [
    `${chatKey}:${turn.turnId}`,
    turn.chatId ? `${chatKey}:chat:${turn.chatId}` : null,
  ].filter(Boolean);
  return keys.flatMap((key) => sourcesByTurn[key] || []);
}

function isTextSource(source = {}) {
  return source.delivery === "txt" || source.mime === "text/plain";
}

export default function ReaderTextSourceCards({
  sources = [],
  focusedSignal = null,
  onRemove = null,
  className = "",
  itemClassName = "",
  removable = false,
}) {
  const refs = useRef({});
  const textSources = sources.filter(isTextSource);

  useEffect(() => {
    const sourceKey = focusedSignal?.sourceKey;
    if (!sourceKey) return;
    const element = refs.current[sourceKey];
    if (!element) return;
    element.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "start",
    });
    element.classList.remove("reader-text-source-card-flash");
    window.setTimeout(
      () => element.classList.add("reader-text-source-card-flash"),
      0
    );
  }, [focusedSignal]);

  if (!textSources.length) return null;

  function jump(source) {
    window.dispatchEvent(new CustomEvent(READER_EVENT_OPEN_DRAWER));
    window.dispatchEvent(
      new CustomEvent("anythingllm-document-reader-jump", { detail: source })
    );
  }

  return (
    <div
      className={`reader-text-source-strip flex max-w-full flex-nowrap gap-2 overflow-x-auto overflow-y-hidden pb-1 ${className}`}
    >
      {textSources.map((source) => (
        <button
          key={source.sourceKey || source.textHash}
          ref={(node) => {
            if (node && source.sourceKey) refs.current[source.sourceKey] = node;
          }}
          type="button"
          onClick={() => jump(source)}
          className={`motion-hover group relative flex w-[230px] shrink-0 items-center gap-2 rounded-xl border border-emerald-200/80 bg-white/90 px-3 py-2 text-left shadow-[0_10px_28px_rgba(15,23,42,0.10)] backdrop-blur-xl hover:-translate-y-0.5 hover:border-emerald-300 hover:bg-emerald-50 light:bg-white ${itemClassName}`}
          title={`${source.tempTextTitle || source.fileName || "临时文本.txt"}\n\n${source.selectedText || ""}`}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500 text-[10px] font-bold text-white">
            TXT
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1">
              {source.citationNo && (
                <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
                  {source.citationNo}
                </span>
              )}
              <span className="truncate text-xs font-bold text-slate-800">
                {source.tempTextTitle || source.fileName || "临时文本.txt"}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-slate-500">
              伴读引用
            </span>
          </span>
          {removable && (
            <span
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation();
                onRemove?.(source.sourceKey, source);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onRemove?.(source.sourceKey, source);
              }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400 opacity-80 hover:bg-rose-50 hover:text-rose-500"
              aria-label="移除 TXT 引用"
            >
              <X size={12} />
            </span>
          )}
        </button>
      ))}
      <style>
        {`
          .reader-text-source-strip {
            scrollbar-width: thin;
          }
          .reader-text-source-card-flash {
            animation: reader-text-source-card-flash 0.62s cubic-bezier(0.4, 0, 0.2, 1) 2;
          }
          @keyframes reader-text-source-card-flash {
            0%, 100% {
              box-shadow: 0 10px 28px rgba(15, 23, 42, 0.10);
            }
            45% {
              box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.28), 0 18px 42px rgba(16, 185, 129, 0.22);
            }
          }
        `}
      </style>
    </div>
  );
}
