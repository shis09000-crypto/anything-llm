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
      {sources.map((source, index) => (
        <button
          key={`${source.textHash}-${index}`}
          type="button"
          onClick={() => jump(source)}
          className="flex max-w-[260px] items-center gap-1 rounded-full border border-sky-300/20 bg-sky-400/10 px-3 py-1 text-xs text-sky-100 hover:bg-sky-400/20 light:border-sky-200 light:bg-sky-50 light:text-sky-700"
          title={source.selectedText}
        >
          <FileText size={13} className="shrink-0" />
          <span className="truncate">{source.documentTitle || "伴读文档"}</span>
          {source.locatorLabel && (
            <>
              <MapPin size={12} className="shrink-0 opacity-70" />
              <span className="truncate opacity-80">{source.locatorLabel}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
