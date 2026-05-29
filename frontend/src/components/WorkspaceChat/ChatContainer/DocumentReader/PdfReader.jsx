import { BookmarkSimple, Check, X } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import {
  PdfLoader,
  PdfHighlighter,
  Highlight,
  Popup,
} from "react-pdf-highlighter";
import "pdfjs-dist/web/pdf_viewer.css";
import "react-pdf-highlighter/dist/esm/style/PdfHighlighter.css";
import "react-pdf-highlighter/dist/esm/style/Highlight.css";
import "react-pdf-highlighter/dist/esm/style/AreaHighlight.css";
import "react-pdf-highlighter/dist/esm/style/MouseSelection.css";
import "react-pdf-highlighter/dist/esm/style/Tip.css";
import "react-pdf-highlighter/dist/esm/style/pdf_viewer.css";
import { textHash } from "./storage";

export default function PdfReader({ document, onCite }) {
  const scrollToRef = useRef(null);
  const [highlights, setHighlights] = useState([]);
  const [selectionDraft, setSelectionDraft] = useState(null);
  const url = document?.objectUrl;

  if (!url) {
    return (
      <p className="text-sm text-white/50 light:text-slate-500">
        PDF 原始文件不可用，无法预览。
      </p>
    );
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-xl border border-white/10 bg-slate-100 light:border-slate-200">
      <PdfLoader
        url={url}
        beforeLoad={
          <div className="flex h-full items-center justify-center p-4 text-sm text-slate-500">
            正在加载 PDF...
          </div>
        }
      >
        {(pdfDocument) => (
          <PdfHighlighter
            pdfDocument={pdfDocument}
            enableAreaSelection={() => false}
            onScrollChange={() => {}}
            scrollRef={(scrollTo) => {
              scrollToRef.current = scrollTo;
            }}
            highlights={highlights}
            onSelectionFinished={(position, content, hideTipAndSelection) => {
              const selectedText = content.text || "";
              if (!selectedText.trim()) return null;
              const highlight = {
                id: `${position.pageNumber}-${textHash(selectedText)}`,
                position,
                content,
              };
              const nextSelection = {
                source: document.source,
                documentTitle: document.title,
                documentType: "pdf",
                readerDocumentId: document.readerDocumentId,
                localDocumentId: document.localDocumentId,
                backupReaderDocumentId: document.backupReaderDocumentId,
                selectedText,
                textHash: textHash(selectedText),
                locator: { page: position.pageNumber },
                locatorLabel: `page ${position.pageNumber}`,
              };
              setHighlights([highlight]);
              setSelectionDraft(nextSelection);
              hideTipAndSelection();
              return null;
            }}
            highlightTransform={(
              highlight,
              index,
              setTip,
              hideTip,
              viewportToScaled,
              screenshot,
              isScrolledTo
            ) => (
              <Popup
                popupContent={
                  <div className="rounded bg-black px-2 py-1 text-xs text-white">
                    PDF 引用
                  </div>
                }
                onMouseOver={(popupContent) =>
                  setTip(highlight, () => popupContent)
                }
                onMouseOut={hideTip}
                key={index}
              >
                <Highlight
                  isScrolledTo={isScrolledTo}
                  position={highlight.position}
                  comment={{ text: highlight.content?.text || "" }}
                />
              </Popup>
            )}
          />
        )}
      </PdfLoader>
      {selectionDraft && (
        <div className="absolute right-3 top-3 z-30 flex flex-col overflow-hidden rounded-full border border-white/70 bg-white/85 shadow-[0_14px_34px_rgba(15,23,42,0.18)] backdrop-blur-xl light:border-slate-200">
          <button
            type="button"
            onClick={() => {
              onCite(selectionDraft);
              setSelectionDraft(null);
            }}
            className="group flex h-10 w-10 items-center justify-center border-none bg-transparent text-slate-700 motion-hover hover:bg-sky-50 hover:text-sky-600"
            title="加入伴读引用"
            aria-label="加入伴读引用"
          >
            <Check size={18} />
          </button>
          <div className="mx-auto h-px w-5 bg-slate-200" />
          <button
            type="button"
            onClick={() => setSelectionDraft(null)}
            className="group flex h-10 w-10 items-center justify-center border-none bg-transparent text-slate-700 motion-hover hover:bg-amber-50 hover:text-amber-600"
            title="保留标记"
            aria-label="保留标记"
          >
            <BookmarkSimple size={18} />
          </button>
          <div className="mx-auto h-px w-5 bg-slate-200" />
          <button
            type="button"
            onClick={() => {
              setSelectionDraft(null);
              setHighlights([]);
            }}
            className="group flex h-10 w-10 items-center justify-center border-none bg-transparent text-slate-700 motion-hover hover:bg-rose-50 hover:text-rose-600"
            title="取消选区"
            aria-label="取消选区"
          >
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
