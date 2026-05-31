import { FileText, MapPin } from "@phosphor-icons/react";
import { useDocumentReader } from "./Provider";

function sourcesForTurn(sourcesByTurn = {}, chatKey, turn) {
  const keys = [
    `${chatKey}:${turn.turnId}`,
    turn.chatId ? `${chatKey}:chat:${turn.chatId}` : null,
  ].filter(Boolean);
  return keys.flatMap((key) => sourcesByTurn[key] || []);
}

export default function DocumentSourceChips({ chatKey, turn }) {
  const context = useDocumentReader();
  const sources = sourcesForTurn(context?.sourcesByTurn, chatKey, turn);
  if (!sources.length) return null;

  function jump(source) {
    window.dispatchEvent(
      new CustomEvent("anythingllm-document-reader-jump", { detail: source })
    );
    context?.setDrawerOpen?.(false);
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {sources.map((source, index) => {
        const isTextSource =
          source.delivery === "txt" || source.mime === "text/plain";
        return (
          <button
            key={`${source.textHash}-${index}`}
            type="button"
            onClick={() => jump(source)}
            className={`flex max-w-[280px] items-center gap-1 rounded-full border px-3 py-1 text-xs ${
              isTextSource
                ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/20 light:border-emerald-200 light:bg-emerald-50 light:text-emerald-700"
                : "border-sky-300/20 bg-sky-400/10 text-sky-100 hover:bg-sky-400/20 light:border-sky-200 light:bg-sky-50 light:text-sky-700"
            }`}
            title={source.selectedText}
          >
            {isTextSource ? (
              <span className="shrink-0 rounded bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                TXT
              </span>
            ) : (
              <FileText size={13} className="shrink-0" />
            )}
            <span className="truncate">
              {isTextSource
                ? source.tempTextTitle || source.fileName || "临时文本.txt"
                : source.documentTitle || "伴读文档"}
            </span>
            {source.locatorLabel && (
              <>
                <MapPin size={12} className="shrink-0 opacity-70" />
                <span className="truncate opacity-80">
                  {source.locatorLabel}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
