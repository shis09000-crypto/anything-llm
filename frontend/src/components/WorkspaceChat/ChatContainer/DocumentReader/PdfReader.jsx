import {
  BookmarkSimple,
  Check,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  X,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { PdfLoader, PdfHighlighter, Highlight } from "react-pdf-highlighter";
import "pdfjs-dist/web/pdf_viewer.css";
import "react-pdf-highlighter/dist/esm/style/PdfHighlighter.css";
import "react-pdf-highlighter/dist/esm/style/Highlight.css";
import "react-pdf-highlighter/dist/esm/style/AreaHighlight.css";
import "react-pdf-highlighter/dist/esm/style/MouseSelection.css";
import "react-pdf-highlighter/dist/esm/style/Tip.css";
import "react-pdf-highlighter/dist/esm/style/pdf_viewer.css";
import { textHash } from "./storage";

const PDFJS_PUBLIC_BASE = `${import.meta.env.BASE_URL || "/"}`.replace(
  /\/?$/,
  "/"
);
const PDFJS_ASSET_BASE = `${PDFJS_PUBLIC_BASE}pdfjs/`;
const PDF_SCALE_STORAGE_KEY = "anythingllm_reader_pdf_scale_v1";

async function thumbnailFromPdfDocument(pdfDocument) {
  const page = await pdfDocument.getPage(1);
  const viewport = page.getViewport({ scale: 0.22 });
  const canvas = window.document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.72);
}

function clampScale(value) {
  return Math.max(0.65, Math.min(2.5, Number(value) || 1));
}

function pdfScaleDocumentKey(document = {}) {
  const stableId =
    document.readerDocumentId ||
    document.backupReaderDocumentId ||
    document.workspaceDocPath ||
    document.localDocumentId ||
    [
      document.bookKey,
      document.title,
      document.fileName,
      document.documentType || "pdf",
    ]
      .filter(Boolean)
      .join(":");
  return stableId ? `pdf:${stableId}` : null;
}

function readPdfScaleMap() {
  try {
    if (typeof window === "undefined") return {};
    const parsed = JSON.parse(
      window.localStorage.getItem(PDF_SCALE_STORAGE_KEY) || "{}"
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readPdfScale(document) {
  const key = pdfScaleDocumentKey(document);
  if (!key) return 1;
  return clampScale(readPdfScaleMap()[key] || 1);
}

function writePdfScale(document, scale) {
  try {
    if (typeof window === "undefined") return;
    const key = pdfScaleDocumentKey(document);
    if (!key) return;
    window.localStorage.setItem(
      PDF_SCALE_STORAGE_KEY,
      JSON.stringify({
        ...readPdfScaleMap(),
        [key]: Number(clampScale(scale).toFixed(2)),
      })
    );
  } catch {}
}

export default function PdfReader({
  document,
  onCite,
  onThumbnailReady,
  onProgressChange,
  readerTextSources = [],
  onFocusTextSource,
  onRemoveTextSource,
}) {
  const containerRef = useRef(null);
  const highlighterRef = useRef(null);
  const scrollToRef = useRef(null);
  const scrollRestoreRef = useRef(null);
  const flashTimerRef = useRef(null);
  const restoreTimerRef = useRef(null);
  const selectionCleanupFrameRef = useRef([]);
  const restoredDocumentRef = useRef(null);
  const thumbnailDocumentIdRef = useRef(null);
  const [highlights, setHighlights] = useState([]);
  const [selectionDraft, setSelectionDraft] = useState(null);
  const [scale, setScale] = useState(() => readPdfScale(document));
  const [flashHighlightId, setFlashHighlightId] = useState(null);
  const [markAvailable, setMarkAvailable] = useState(false);
  const [markedHighlightId, setMarkedHighlightId] = useState(null);
  const url = document?.objectUrl;
  const pdfScaleKey = pdfScaleDocumentKey(document);

  const scaleValue = scale.toFixed(2);
  const zoomPercent = Math.round(scale * 100);
  const markedHighlight =
    markAvailable && markedHighlightId
      ? highlights.find((highlight) => highlight.id === markedHighlightId)
      : null;
  const isPdfPreview = document?.renderType === "pdf-preview";

  function clearBrowserSelection() {
    const selection = window.getSelection?.();
    if (selection?.removeAllRanges) selection.removeAllRanges();
  }

  function cancelSelectionCleanup() {
    selectionCleanupFrameRef.current.forEach((frameId) =>
      window.cancelAnimationFrame(frameId)
    );
    selectionCleanupFrameRef.current = [];
  }

  function deferSelectionCleanup(hideTipAndSelection) {
    cancelSelectionCleanup();
    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(() => {
        hideTipAndSelection?.();
        clearBrowserSelection();
        selectionCleanupFrameRef.current = [];
      });
      selectionCleanupFrameRef.current = [secondFrame];
    });
    selectionCleanupFrameRef.current = [firstFrame];
  }

  function viewerContainer() {
    return highlighterRef.current?.viewer?.container || null;
  }

  function pageElements(container) {
    return [...(container?.querySelectorAll(".page[data-page-number]") || [])];
  }

  function capturePdfProgress() {
    const container = viewerContainer();
    if (!container) return null;
    const range = container.scrollHeight - container.clientHeight;
    const scrollRatio = range > 0 ? container.scrollTop / range : 0;
    const pages = pageElements(container);
    const containerTop = container.getBoundingClientRect().top;
    const activePage = pages
      .map((page, index) => {
        const rect = page.getBoundingClientRect();
        const topDistance = Math.abs(rect.top - containerTop);
        const pageOffsetRatio = Math.max(
          0,
          Math.min(1, (containerTop - rect.top) / Math.max(1, rect.height))
        );
        return {
          pageNumber:
            Number(page.getAttribute("data-page-number")) || index + 1,
          pageOffsetRatio,
          topDistance,
        };
      })
      .sort((a, b) => a.topDistance - b.topDistance)[0];
    return {
      label: "阅读进度",
      percent: scrollRatio * 100,
      scrollRatio,
      scrollTop: container.scrollTop,
      locator: activePage
        ? {
            ...(isPdfPreview ? { type: "pdf-preview" } : {}),
            page: activePage.pageNumber,
            pageOffsetRatio: activePage.pageOffsetRatio,
          }
        : null,
    };
  }

  function reportPdfProgress() {
    const progress = capturePdfProgress();
    if (progress) onProgressChange?.(progress);
  }

  function flashHighlight(highlightId) {
    setFlashHighlightId(highlightId);
    window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(
      () => setFlashHighlightId(null),
      1300
    );
  }

  function openSelectionPanelFromHighlight(highlight, options = {}) {
    if (!highlight?.selection) return;
    scrollToRef.current?.(highlight);
    flashHighlight(highlight.id);
    setSelectionDraft(highlight.selection);
    if (options.consumeMark) setMarkAvailable(false);
    clearBrowserSelection();
  }

  function scrollToSelectionSource(source) {
    if (!source) return;
    const matchingHighlight = highlights.find(
      (highlight) =>
        highlight.selection?.textHash === source.textHash ||
        highlight.id === source.highlightId
    );
    if (matchingHighlight) {
      openSelectionPanelFromHighlight(matchingHighlight);
      return;
    }
    const container = viewerContainer();
    const pageNumber = Number(source.locator?.page || 0);
    if (!container || !pageNumber) return;
    const page = pageElements(container).find(
      (element) =>
        Number(element.getAttribute("data-page-number")) === pageNumber
    );
    if (!page) return;
    const offsetRatio = Number(source.locator?.pageOffsetRatio || 0);
    container.scrollTo({
      top: page.offsetTop + page.clientHeight * Math.max(0, offsetRatio),
      behavior: "smooth",
    });
    if (source.position) {
      const highlight = {
        id:
          source.highlightId ||
          `${source.locator?.page || 0}-${source.textHash}`,
        position: source.position,
        content: { text: source.selectedText || "" },
        selection: source,
        sourceKey: source.sourceKey,
        citationNo: source.citationNo,
      };
      setHighlights((current) => [
        ...current.filter((item) => item.sourceKey !== source.sourceKey),
        highlight,
      ]);
      setSelectionDraft(source);
    }
  }

  function restorePdfProgress(attempt = 0) {
    const progress = document.progress || {};
    const container = viewerContainer();
    if (!container) return;
    const pageNumber = Number(progress.locator?.page || 0);
    const pages = pageElements(container);
    const page = pageNumber
      ? pages.find(
          (element) =>
            Number(element.getAttribute("data-page-number")) === pageNumber
        )
      : null;
    if (page) {
      const pageOffsetRatio = Number(progress.locator?.pageOffsetRatio || 0);
      container.scrollTop =
        page.offsetTop + page.clientHeight * Math.max(0, pageOffsetRatio);
      return;
    }
    if (attempt < 10 && (pageNumber || pages.length === 0)) {
      restoreTimerRef.current = window.setTimeout(
        () => restorePdfProgress(attempt + 1),
        150
      );
      return;
    }
    const ratio =
      typeof progress.scrollRatio === "number"
        ? progress.scrollRatio
        : Number(progress.percent || 0) / 100;
    const range = container.scrollHeight - container.clientHeight;
    if (range > 0 && ratio) container.scrollTop = range * ratio;
  }

  function rememberScrollPosition() {
    const container = viewerContainer();
    if (!container) return;
    const range = container.scrollHeight - container.clientHeight;
    scrollRestoreRef.current = {
      ratio: range > 0 ? container.scrollTop / range : 0,
      left: container.scrollLeft,
    };
  }

  function setScaleAndRemember(nextScale) {
    const normalizedScale = Number(clampScale(nextScale).toFixed(2));
    setScale(normalizedScale);
    writePdfScale(document, normalizedScale);
  }

  function updateScale(delta) {
    rememberScrollPosition();
    setScale((current) => {
      const next = clampScale(current + delta);
      const normalizedScale = Number(next.toFixed(2));
      writePdfScale(document, normalizedScale);
      return normalizedScale;
    });
  }

  function setScaleFromPercent(percent) {
    rememberScrollPosition();
    setScaleAndRemember(percent / 100);
  }

  useEffect(() => {
    if (!pdfScaleKey) {
      setScale(1);
      return;
    }
    setScale(clampScale(readPdfScaleMap()[pdfScaleKey] || 1));
  }, [pdfScaleKey]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let startScale = scale;
    let lastWheelAt = 0;
    const handleWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const now = Date.now();
      if (now - lastWheelAt < 80) return;
      lastWheelAt = now;
      const intensity = Math.min(
        1.6,
        Math.max(0.45, Math.abs(event.deltaY) / 120)
      );
      updateScale(event.deltaY > 0 ? -0.03 * intensity : 0.03 * intensity);
    };
    const handleGestureStart = (event) => {
      event.preventDefault();
      startScale = scale;
    };
    const handleGestureChange = (event) => {
      event.preventDefault();
      rememberScrollPosition();
      const dampedScale = 1 + (event.scale - 1) * 0.35;
      setScaleAndRemember(startScale * dampedScale);
    };
    node.addEventListener("wheel", handleWheel, { passive: false });
    node.addEventListener("gesturestart", handleGestureStart, {
      passive: false,
    });
    node.addEventListener("gesturechange", handleGestureChange, {
      passive: false,
    });
    return () => {
      node.removeEventListener("wheel", handleWheel);
      node.removeEventListener("gesturestart", handleGestureStart);
      node.removeEventListener("gesturechange", handleGestureChange);
    };
  }, [scale]);

  useEffect(() => {
    const highlighter = highlighterRef.current;
    const viewer = highlighter?.viewer;
    if (!viewer) return;
    const restore = scrollRestoreRef.current;
    viewer.currentScaleValue = scaleValue;
    window.setTimeout(() => {
      const container = viewer.container;
      if (!container || !restore) return;
      const range = container.scrollHeight - container.clientHeight;
      container.scrollTop = range > 0 ? range * restore.ratio : 0;
      container.scrollLeft = restore.left || 0;
      reportPdfProgress();
    }, 80);
  }, [scaleValue]);

  useEffect(() => {
    return () => {
      window.clearTimeout(flashTimerRef.current);
      window.clearTimeout(restoreTimerRef.current);
      cancelSelectionCleanup();
    };
  }, []);

  useEffect(() => {
    const jump = (event) => scrollToSelectionSource(event.detail);
    window.addEventListener("anythingllm-document-reader-jump", jump);
    return () =>
      window.removeEventListener("anythingllm-document-reader-jump", jump);
  }, [highlights]);

  useEffect(() => {
    setHighlights((current) =>
      current.filter((highlight) => {
        if (!highlight.sourceKey) return true;
        return readerTextSources.some(
          (source) => source.sourceKey === highlight.sourceKey
        );
      })
    );
  }, [readerTextSources]);

  if (!url) {
    return (
      <p className="text-sm text-white/50 light:text-slate-500">
        PDF 原始文件不可用，无法预览。
      </p>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-0 overflow-hidden rounded-xl border border-white/10 bg-slate-100 light:border-slate-200"
    >
      <PdfLoader
        url={url}
        workerSrc={`${PDFJS_ASSET_BASE}pdf.worker.min.js`}
        cMapUrl={`${PDFJS_ASSET_BASE}cmaps/`}
        cMapPacked={true}
        standardFontDataUrl={`${PDFJS_ASSET_BASE}standard_fonts/`}
        beforeLoad={
          <div className="flex h-full items-center justify-center p-4 text-sm text-slate-500">
            {isPdfPreview ? "正在加载版式预览..." : "正在加载 PDF..."}
          </div>
        }
      >
        {(pdfDocument) => {
          const thumbnailKey =
            document.readerDocumentId ||
            document.localDocumentId ||
            document.title;
          if (
            onThumbnailReady &&
            thumbnailDocumentIdRef.current !== thumbnailKey &&
            !document.thumbnailDataUrl
          ) {
            thumbnailDocumentIdRef.current = thumbnailKey;
            thumbnailFromPdfDocument(pdfDocument)
              .then((thumbnail) => onThumbnailReady(thumbnail))
              .catch(() => null);
          }

          return (
            <PdfHighlighter
              ref={highlighterRef}
              pdfDocument={pdfDocument}
              pdfScaleValue={scaleValue}
              enableAreaSelection={() => false}
              scrollRef={(scrollTo) => {
                scrollToRef.current = scrollTo;
                const restoreKey =
                  document.readerDocumentId ||
                  document.localDocumentId ||
                  document.title;
                if (restoredDocumentRef.current !== restoreKey) {
                  restoredDocumentRef.current = restoreKey;
                  window.clearTimeout(restoreTimerRef.current);
                  restoreTimerRef.current = window.setTimeout(
                    () => restorePdfProgress(0),
                    150
                  );
                }
              }}
              onScrollChange={reportPdfProgress}
              highlights={highlights}
              onSelectionFinished={(
                position,
                content,
                hideTipAndSelection,
                showSelectionAsHighlight
              ) => {
                const selectedText = content.text || "";
                if (!selectedText.trim()) return null;
                showSelectionAsHighlight?.();
                const highlight = {
                  id: `${position.pageNumber}-${textHash(selectedText)}`,
                  position,
                  content,
                };
                const currentLocator = capturePdfProgress()?.locator || {};
                const nextSelection = {
                  source: document.source,
                  documentTitle: document.title,
                  documentType: document.documentType || "pdf",
                  readerDocumentId: document.readerDocumentId,
                  localDocumentId: document.localDocumentId,
                  backupReaderDocumentId: document.backupReaderDocumentId,
                  selectedText,
                  textHash: textHash(selectedText),
                  position,
                  locator: {
                    ...(isPdfPreview ? { type: "pdf-preview" } : {}),
                    page: position.pageNumber,
                    ...(currentLocator.pageOffsetRatio !== undefined
                      ? { pageOffsetRatio: currentLocator.pageOffsetRatio }
                      : {}),
                  },
                  locatorLabel: `page ${position.pageNumber}`,
                };
                highlight.selection = {
                  ...nextSelection,
                  highlightId: highlight.id,
                };
                setHighlights((current) => [
                  ...current.filter(
                    (item) =>
                      item.sourceKey ||
                      (markAvailable && item.id === markedHighlightId)
                  ),
                  highlight,
                ]);
                setMarkAvailable(false);
                setMarkedHighlightId(highlight.id);
                setSelectionDraft(highlight.selection);
                deferSelectionCleanup(hideTipAndSelection);
                return null;
              }}
              highlightTransform={(
                highlight,
                index,
                _setTip,
                _hideTip,
                _viewportToScaled,
                _screenshot,
                _isScrolledTo
              ) => {
                const isDraft =
                  selectionDraft?.highlightId === highlight.id &&
                  !highlight.sourceKey;
                const isMarked =
                  markAvailable && markedHighlightId === highlight.id;
                const isCitation = !!highlight.sourceKey;
                return (
                  <div
                    key={index}
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation();
                      openSelectionPanelFromHighlight(highlight);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      openSelectionPanelFromHighlight(highlight);
                    }}
                    className={`reader-pdf-highlight relative cursor-pointer ${
                      isDraft ? "reader-pdf-highlight-draft" : ""
                    } ${isMarked ? "reader-pdf-highlight-marked" : ""} ${
                      isCitation ? "reader-pdf-highlight-citation" : ""
                    } ${
                      flashHighlightId === highlight.id
                        ? "reader-pdf-highlight-flash"
                        : ""
                    }`}
                  >
                    {highlight.sourceKey && highlight.citationNo && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onFocusTextSource?.(highlight.sourceKey);
                        }}
                        className="absolute -right-2 -top-2 z-40 flex h-5 min-w-[20px] items-center justify-center rounded-full border border-white bg-emerald-500 px-1 text-[10px] font-bold leading-none text-white shadow-[0_8px_18px_rgba(16,185,129,0.28)]"
                        title={`定位 TXT 引用 ${highlight.citationNo}`}
                        aria-label={`定位 TXT 引用 ${highlight.citationNo}`}
                      >
                        {highlight.citationNo}
                      </button>
                    )}
                    <Highlight
                      isScrolledTo={false}
                      position={highlight.position}
                      comment={null}
                    />
                  </div>
                );
              }}
            />
          );
        }}
      </PdfLoader>
      {!selectionDraft && markedHighlight && (
        <button
          type="button"
          onClick={() => {
            openSelectionPanelFromHighlight(markedHighlight, {
              consumeMark: true,
            });
          }}
          className="motion-hover absolute right-3 top-3 z-30 flex h-9 items-center gap-1.5 rounded-full border border-white/70 bg-white/88 px-3 text-xs font-bold text-slate-700 shadow-[0_14px_34px_rgba(15,23,42,0.16)] backdrop-blur-xl hover:-translate-y-0.5 hover:bg-sky-50 hover:text-sky-700 light:border-slate-200"
          title="回到标记"
          aria-label="回到标记"
        >
          <BookmarkSimple size={16} />
          回到标记
        </button>
      )}
      <div className="absolute bottom-3 right-3 z-30 flex items-center gap-2 rounded-full border border-white/70 bg-white/88 px-3 py-2 text-slate-700 shadow-[0_14px_34px_rgba(15,23,42,0.16)] backdrop-blur-xl light:border-slate-200">
        <button
          type="button"
          onClick={() => updateScale(-0.05)}
          className="motion-hover flex h-7 w-7 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100 hover:text-slate-950"
          title="缩小"
          aria-label="缩小 PDF"
        >
          <MagnifyingGlassMinus size={16} />
        </button>
        <input
          type="range"
          min="65"
          max="250"
          step="5"
          value={zoomPercent}
          onChange={(event) => setScaleFromPercent(event.target.value)}
          className="h-1.5 w-28 accent-blue-500"
          aria-label="PDF 缩放"
        />
        <button
          type="button"
          onClick={() => updateScale(0.05)}
          className="motion-hover flex h-7 w-7 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100 hover:text-slate-950"
          title="放大"
          aria-label="放大 PDF"
        >
          <MagnifyingGlassPlus size={16} />
        </button>
        <span className="min-w-[42px] text-right text-xs font-bold tabular-nums text-slate-600">
          {zoomPercent}%
        </span>
      </div>
      {selectionDraft && (
        <div className="absolute right-3 top-3 z-30 flex flex-col overflow-hidden rounded-full border border-white/70 bg-white/85 shadow-[0_14px_34px_rgba(15,23,42,0.18)] backdrop-blur-xl light:border-slate-200">
          <button
            type="button"
            onClick={() => {
              const citedSource = onCite(selectionDraft);
              if (citedSource) {
                setHighlights((current) =>
                  current.map((highlight) =>
                    highlight.id !== selectionDraft.highlightId
                      ? highlight
                      : {
                          ...highlight,
                          sourceKey: citedSource.sourceKey,
                          citationNo: citedSource.citationNo,
                          selection: {
                            ...highlight.selection,
                            ...citedSource,
                          },
                        }
                  )
                );
              }
              setSelectionDraft(null);
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
              setMarkedHighlightId(selectionDraft?.highlightId || null);
              setMarkAvailable(true);
              setSelectionDraft(null);
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
              if (selectionDraft?.sourceKey)
                onRemoveTextSource?.(selectionDraft.sourceKey);
              setSelectionDraft(null);
              setHighlights((current) =>
                current.filter(
                  (highlight) => highlight.id !== selectionDraft?.highlightId
                )
              );
              setMarkAvailable(false);
              setMarkedHighlightId(null);
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
          .PdfHighlighter__highlight-layer {
            z-index: 7 !important;
          }

          .PdfHighlighter__highlight-layer .Highlight,
          .reader-pdf-highlight {
            z-index: 8;
          }

          .reader-pdf-highlight-flash .Highlight__parts {
            animation: reader-pdf-highlight-flash 0.62s cubic-bezier(0.4, 0, 0.2, 1) 2;
          }

          .Highlight__part {
            background: rgba(250, 204, 21, 0.34) !important;
            border-radius: 2px;
            box-shadow: 0 0 0 1px rgba(202, 138, 4, 0.16);
            mix-blend-mode: multiply;
            pointer-events: auto;
            transition: background 0.24s cubic-bezier(0.4, 0, 0.2, 1), filter 0.24s cubic-bezier(0.4, 0, 0.2, 1);
          }

          .reader-pdf-highlight-draft .Highlight__part {
            background: rgba(250, 204, 21, 0.46) !important;
            box-shadow: 0 0 0 1px rgba(202, 138, 4, 0.24), 0 6px 16px rgba(250, 204, 21, 0.12);
          }

          .reader-pdf-highlight-marked .Highlight__part {
            background: rgba(251, 191, 36, 0.38) !important;
          }

          .reader-pdf-highlight-citation .Highlight__part {
            background: rgba(52, 211, 153, 0.3) !important;
            box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.18);
          }

          .Highlight--scrolledTo .Highlight__part {
            background: rgba(250, 204, 21, 0.42) !important;
          }

          @keyframes reader-pdf-highlight-flash {
            0%, 100% {
              background: rgba(250, 204, 21, 0.34);
              filter: brightness(1);
            }
            45% {
              background: rgba(253, 224, 71, 0.5);
              filter: brightness(1.18);
            }
          }
        `}
      </style>
    </div>
  );
}
