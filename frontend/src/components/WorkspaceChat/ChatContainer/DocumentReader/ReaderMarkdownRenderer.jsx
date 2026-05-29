import { useEffect, useRef, useState } from "react";
import { Quotes } from "@phosphor-icons/react";
import { locatorForBlock } from "./parsers";

export default function ReaderMarkdownRenderer({ document, onCite }) {
  const [activeBlockId, setActiveBlockId] = useState(null);
  const containerRef = useRef(null);
  const blocks = document?.content?.blocks || [];

  useEffect(() => {
    const jump = (event) => {
      const blockId = event.detail?.locator?.blockId;
      if (!blockId) return;
      const element = containerRef.current?.querySelector(
        `[data-reader-block-id="${CSS.escape(blockId)}"]`
      );
      if (!element) return;
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      setActiveBlockId(blockId);
      setTimeout(() => setActiveBlockId(null), 1400);
    };
    window.addEventListener("anythingllm-document-reader-jump", jump);
    return () =>
      window.removeEventListener("anythingllm-document-reader-jump", jump);
  }, []);

  function citeBlock(block) {
    const locator = locatorForBlock(block);
    onCite({
      ...locator,
      source: document.source,
      documentTitle: document.title,
      documentType: document.documentType,
      readerDocumentId: document.readerDocumentId,
      localDocumentId: document.localDocumentId,
      backupReaderDocumentId: document.backupReaderDocumentId,
      locatorLabel: block.type === "heading" ? "标题" : "段落",
    });
  }

  return (
    <div ref={containerRef} className="space-y-3 pb-12">
      {blocks.map((block) => {
        const isHeading = block.type === "heading";
        return (
          <div
            key={block.blockId}
            data-reader-block-id={block.blockId}
            className={`group rounded-md border px-3 py-2 motion-hover ${
              activeBlockId === block.blockId
                ? "border-sky-400 bg-sky-400/15"
                : "border-transparent hover:border-white/10 light:hover:border-slate-200"
            }`}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {isHeading ? (
                  <h3 className="m-0 text-sm font-semibold text-white light:text-slate-900">
                    {block.text}
                  </h3>
                ) : block.type === "code" ? (
                  <pre className="m-0 whitespace-pre-wrap rounded bg-black/30 p-2 text-xs text-white/80 light:bg-slate-100 light:text-slate-800">
                    {block.text}
                  </pre>
                ) : (
                  <p className="m-0 whitespace-pre-wrap text-sm leading-6 text-white/80 light:text-slate-700">
                    {block.text}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => citeBlock(block)}
                className="opacity-0 group-hover:opacity-100 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 text-white/70 hover:text-white light:border-slate-200 light:text-slate-500 light:hover:text-slate-900"
                title="引用此段"
              >
                <Quotes size={14} />
              </button>
            </div>
          </div>
        );
      })}
      {blocks.length === 0 && (
        <p className="text-sm text-white/50 light:text-slate-500">
          没有可显示的结构化正文。
        </p>
      )}
    </div>
  );
}
