import { useEffect, useRef, useState } from "react";
import { BookmarkSimple, Check, Quotes, X } from "@phosphor-icons/react";
import DOMPurify from "dompurify";
import { textHash } from "./storage";
import { locatorForBlock } from "./parsers";

export default function ReaderMarkdownRenderer({
  document,
  onCite,
  readerTextSources = [],
  onFocusTextSource,
  onRemoveTextSource,
}) {
  const [activeBlockId, setActiveBlockId] = useState(null);
  const [htmlSelectionDraft, setHtmlSelectionDraft] = useState(null);
  const [htmlMarkedRange, setHtmlMarkedRange] = useState(null);
  const [htmlMarkedSelection, setHtmlMarkedSelection] = useState(null);
  const [htmlMarkAvailable, setHtmlMarkAvailable] = useState(false);
  const [htmlFlashMark, setHtmlFlashMark] = useState(false);
  const [htmlCitationRanges, setHtmlCitationRanges] = useState([]);
  const [htmlCitationLabels, setHtmlCitationLabels] = useState([]);
  const pageRef = useRef(null);
  const containerRef = useRef(null);
  const flashTimerRef = useRef(null);
  const blocks = document?.content?.blocks || [];
  const htmlFallback =
    document?.documentType === "docx" && document?.content?.html;

  useEffect(() => {
    const jump = (event) => {
      if (event.detail?.locator?.type === "html-fallback") {
        openHtmlSourceSelection(event.detail);
        return;
      }
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
  }, [htmlCitationRanges, htmlMarkedRange, htmlMarkedSelection]);

  useEffect(() => {
    if (!window.CSS?.highlights) return;
    CSS.highlights.delete("reader-docx-draft");
    CSS.highlights.delete("reader-docx-mark");
    CSS.highlights.delete("reader-docx-flash");
    CSS.highlights.delete("reader-docx-citation");
    if (htmlSelectionDraft?.range) {
      CSS.highlights.set(
        "reader-docx-draft",
        new Highlight(htmlSelectionDraft.range)
      );
    }
    if (htmlMarkedRange) {
      CSS.highlights.set("reader-docx-mark", new Highlight(htmlMarkedRange));
    }
    if (htmlCitationRanges.length) {
      CSS.highlights.set(
        "reader-docx-citation",
        new Highlight(...htmlCitationRanges.map((item) => item.range))
      );
    }
    if (htmlFlashMark && htmlMarkedRange) {
      CSS.highlights.set("reader-docx-flash", new Highlight(htmlMarkedRange));
    }
    return () => {
      CSS.highlights.delete("reader-docx-draft");
      CSS.highlights.delete("reader-docx-mark");
      CSS.highlights.delete("reader-docx-flash");
      CSS.highlights.delete("reader-docx-citation");
    };
  }, [htmlCitationRanges, htmlFlashMark, htmlMarkedRange, htmlSelectionDraft]);

  useEffect(() => {
    return () => window.clearTimeout(flashTimerRef.current);
  }, []);

  useEffect(() => {
    setHtmlCitationRanges((current) =>
      current.filter((citation) =>
        readerTextSources.some(
          (source) => source.sourceKey === citation.sourceKey
        )
      )
    );
  }, [readerTextSources]);

  useEffect(() => {
    function updateLabels() {
      const page = pageRef.current;
      if (!page) return;
      const pageRect = page.getBoundingClientRect();
      setHtmlCitationLabels(
        htmlCitationRanges
          .map((citation) => {
            const rect = citation.range.getClientRects()?.[0];
            if (!rect) return null;
            return {
              sourceKey: citation.sourceKey,
              citationNo: citation.citationNo,
              left: Math.max(8, rect.right - pageRect.left - 8),
              top: Math.max(8, rect.top - pageRect.top - 10),
            };
          })
          .filter(Boolean)
      );
    }
    updateLabels();
    window.addEventListener("resize", updateLabels);
    return () => window.removeEventListener("resize", updateLabels);
  }, [htmlCitationRanges]);

  function clearBrowserSelection() {
    const selection = window.getSelection?.();
    if (selection?.removeAllRanges) selection.removeAllRanges();
  }

  function rangeRootElement(range) {
    const node = range?.startContainer;
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function pointIntersectsRange(range, x, y) {
    if (!range) return false;
    return [...range.getClientRects()].some(
      (rect) =>
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    );
  }

  function openHtmlMarkedSelection() {
    if (!htmlMarkedRange || !htmlMarkedSelection) return;
    openHtmlSourceSelection(htmlMarkedSelection);
    setHtmlMarkAvailable(false);
  }

  function openHtmlSourceSelection(source) {
    const citation = htmlCitationRanges.find(
      (item) => item.sourceKey === source?.sourceKey
    );
    const range = citation?.range || htmlMarkedRange;
    const payload = citation?.payload || source || htmlMarkedSelection;
    if (!range || !payload) return;
    rangeRootElement(range)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    flashHtmlMark();
    setHtmlSelectionDraft({
      range: range.cloneRange(),
      payload,
    });
    clearBrowserSelection();
  }

  function handleHtmlClick(event) {
    const selectedText = window.getSelection?.()?.toString()?.trim();
    if (selectedText) return;
    const clickedCitation = htmlCitationRanges.find((citation) =>
      pointIntersectsRange(citation.range, event.clientX, event.clientY)
    );
    if (clickedCitation) {
      openHtmlSourceSelection(clickedCitation.payload);
      return;
    }
    if (!pointIntersectsRange(htmlMarkedRange, event.clientX, event.clientY))
      return;
    openHtmlMarkedSelection();
  }

  function handleHtmlSelection() {
    window.setTimeout(() => {
      const selection = window.getSelection?.();
      if (!selection || selection.rangeCount === 0) return;
      const selectedText = selection.toString().trim();
      if (!selectedText) return;
      const range = selection.getRangeAt(0);
      const root = containerRef.current;
      if (!root || !root.contains(range.commonAncestorContainer)) return;
      const clonedRange = range.cloneRange();
      const selectionHash = textHash(selectedText);
      const payload = {
        source: document.source,
        documentTitle: document.title,
        documentType: document.documentType,
        readerDocumentId: document.readerDocumentId,
        localDocumentId: document.localDocumentId,
        backupReaderDocumentId: document.backupReaderDocumentId,
        selectedText,
        textHash: selectionHash,
        locator: {
          type: "html-fallback",
          textHash: selectionHash,
        },
        locatorLabel: "临时可读预览",
      };
      setHtmlMarkedRange(clonedRange.cloneRange());
      setHtmlMarkedSelection(payload);
      setHtmlMarkAvailable(false);
      setHtmlSelectionDraft({
        range: clonedRange,
        payload,
      });
    }, 0);
  }

  function flashHtmlMark() {
    setHtmlFlashMark(true);
    window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      setHtmlFlashMark(false);
      flashTimerRef.current = window.setTimeout(() => {
        setHtmlFlashMark(true);
        flashTimerRef.current = window.setTimeout(
          () => setHtmlFlashMark(false),
          220
        );
      }, 180);
    }, 220);
  }

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

  if (htmlFallback) {
    return (
      <div className="relative pb-12">
        <div
          ref={pageRef}
          className="relative mx-auto max-w-[820px] rounded-md bg-white px-12 py-10 text-slate-950 shadow-[0_18px_50px_rgba(15,23,42,0.12)]"
        >
          <div
            ref={containerRef}
            className="reader-docx-html-fallback"
            onClick={handleHtmlClick}
            onMouseUp={handleHtmlSelection}
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(document.content.html),
            }}
          />
          {htmlCitationLabels.map((label) => (
            <button
              key={label.sourceKey}
              type="button"
              onClick={() => onFocusTextSource?.(label.sourceKey)}
              className="absolute z-40 flex h-5 min-w-[20px] items-center justify-center rounded-full border border-white bg-emerald-500 px-1 text-[10px] font-bold leading-none text-white shadow-[0_8px_18px_rgba(16,185,129,0.28)]"
              style={{ left: label.left, top: label.top }}
              title={`定位 TXT 引用 ${label.citationNo}`}
              aria-label={`定位 TXT 引用 ${label.citationNo}`}
            >
              {label.citationNo}
            </button>
          ))}
        </div>
        {!htmlSelectionDraft && htmlMarkedRange && htmlMarkAvailable && (
          <button
            type="button"
            onClick={openHtmlMarkedSelection}
            className="motion-hover sticky right-3 top-3 z-30 ml-auto mt-[-42px] flex h-9 w-fit items-center gap-1.5 rounded-full border border-white/70 bg-white/88 px-3 text-xs font-bold text-slate-700 shadow-[0_14px_34px_rgba(15,23,42,0.16)] backdrop-blur-xl hover:-translate-y-0.5 hover:bg-sky-50 hover:text-sky-700 light:border-slate-200"
            title="回到标记"
            aria-label="回到标记"
          >
            <BookmarkSimple size={16} />
            回到标记
          </button>
        )}
        {htmlSelectionDraft && (
          <div className="sticky right-3 top-3 z-30 ml-auto mt-[-42px] flex w-fit flex-col overflow-hidden rounded-full border border-white/70 bg-white/85 shadow-[0_14px_34px_rgba(15,23,42,0.18)] backdrop-blur-xl light:border-slate-200">
            <button
              type="button"
              onClick={() => {
                const citedSource = onCite(htmlSelectionDraft.payload);
                if (citedSource) {
                  setHtmlCitationRanges((current) => [
                    ...current.filter(
                      (item) => item.sourceKey !== citedSource.sourceKey
                    ),
                    {
                      range: htmlSelectionDraft.range.cloneRange(),
                      payload: {
                        ...htmlSelectionDraft.payload,
                        ...citedSource,
                      },
                      sourceKey: citedSource.sourceKey,
                      citationNo: citedSource.citationNo,
                    },
                  ]);
                  setHtmlMarkedSelection({
                    ...htmlSelectionDraft.payload,
                    ...citedSource,
                  });
                }
                setHtmlSelectionDraft(null);
                clearBrowserSelection();
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
              onClick={() => {
                setHtmlMarkedRange(htmlSelectionDraft.range.cloneRange());
                setHtmlMarkedSelection(htmlSelectionDraft.payload);
                setHtmlMarkAvailable(true);
                setHtmlSelectionDraft(null);
                clearBrowserSelection();
              }}
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
                if (htmlSelectionDraft?.payload?.sourceKey)
                  onRemoveTextSource?.(htmlSelectionDraft.payload.sourceKey);
                setHtmlSelectionDraft(null);
                setHtmlMarkedRange(null);
                setHtmlMarkedSelection(null);
                setHtmlMarkAvailable(false);
                clearBrowserSelection();
              }}
              className="group flex h-10 w-10 items-center justify-center border-none bg-transparent text-slate-700 motion-hover hover:bg-rose-50 hover:text-rose-600"
              title="取消选区"
              aria-label="取消选区"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <style>
          {`
            ::highlight(reader-docx-draft),
            ::highlight(reader-docx-mark),
            ::highlight(reader-docx-citation) {
              background: rgba(250, 204, 21, 0.28);
            }
            ::highlight(reader-docx-flash) {
              background: rgba(253, 224, 71, 0.52);
            }
            .reader-docx-html-fallback {
              font-family: "Times New Roman", "Songti SC", "SimSun", serif;
              font-size: 15px;
              line-height: 1.72;
              color: #111827;
            }
            .reader-docx-html-fallback h1,
            .reader-docx-html-fallback h2,
            .reader-docx-html-fallback h3 {
              margin: 1.2em 0 0.6em;
              font-weight: 700;
              line-height: 1.35;
            }
            .reader-docx-html-fallback h1 { font-size: 1.7em; }
            .reader-docx-html-fallback h2 { font-size: 1.35em; }
            .reader-docx-html-fallback h3 { font-size: 1.16em; }
            .reader-docx-html-fallback p {
              margin: 0 0 0.85em;
            }
            .reader-docx-html-fallback strong,
            .reader-docx-html-fallback b {
              font-weight: 700;
            }
            .reader-docx-html-fallback em,
            .reader-docx-html-fallback i {
              font-style: italic;
            }
            .reader-docx-html-fallback ul,
            .reader-docx-html-fallback ol {
              margin: 0 0 0.9em 1.6em;
              padding: 0;
            }
            .reader-docx-html-fallback table {
              width: 100%;
              border-collapse: collapse;
              margin: 1em 0;
              table-layout: auto;
            }
            .reader-docx-html-fallback th,
            .reader-docx-html-fallback td {
              border: 1px solid #cbd5e1;
              padding: 7px 9px;
              vertical-align: top;
            }
            .reader-docx-html-fallback th {
              background: #f8fafc;
              font-weight: 700;
            }
          `}
        </style>
      </div>
    );
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
