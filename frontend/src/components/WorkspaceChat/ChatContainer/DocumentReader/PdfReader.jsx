import {
  BookmarkSimple,
  Check,
  CircleNotch,
  Crop,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Mouse,
  X,
} from "@phosphor-icons/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { PdfHighlighter, Highlight } from "react-pdf-highlighter";
import "pdfjs-dist/web/pdf_viewer.css";
import "react-pdf-highlighter/dist/esm/style/PdfHighlighter.css";
import "react-pdf-highlighter/dist/esm/style/Highlight.css";
import "react-pdf-highlighter/dist/esm/style/AreaHighlight.css";
import "react-pdf-highlighter/dist/esm/style/MouseSelection.css";
import "react-pdf-highlighter/dist/esm/style/Tip.css";
import "react-pdf-highlighter/dist/esm/style/pdf_viewer.css";
import { downloadUrl } from "@/lib/communication/blobClient";
import {
  createCommunicationRequestId,
  shouldAttachClientIdentityToUrl,
  withClientIdentityHeaders,
} from "@/lib/communication/clientIdentity";
import ReaderDocument, {
  readerSensitiveHeadersForUrl,
  readerSensitiveSessionStateForUrl,
} from "@/models/readerDocument";
import { baseHeaders } from "@/utils/request";
import showToast from "@/utils/toast";
import {
  pdfProgressRestoreKey,
  pdfProgressRestoreTarget,
  shouldSuppressPdfProgressDuringRestore,
} from "@/utils/chat/readerProgress";
import {
  PDF_FAST_STREAM_MAX_BYTES,
  pdfLoadingPolicyForDocument,
  readerPdfSourceMatchesDocument,
  resolvePdfInitialTarget,
} from "@/utils/chat/readerPdfTarget";
import { taskScheduler } from "@/utils/tasks/taskScheduler";
import { detectPdfTextLayer } from "./pdfOcrDetection";
import { textHash } from "./storage";

const PDFJS_PUBLIC_BASE = `${import.meta.env.BASE_URL || "/"}`.replace(
  /\/?$/,
  "/"
);
const PDFJS_ASSET_BASE = `${PDFJS_PUBLIC_BASE}pdfjs/`;
const PDF_SCALE_STORAGE_KEY = "anythingllm_reader_pdf_scale_v1";
const MIN_SCREENSHOT_SELECTION_WIDTH = 20;
const MIN_SCREENSHOT_SELECTION_HEIGHT = 20;
const FAST_TARGET_RENDER_MAX_SCALE = 2.2;
const FAST_TARGET_RENDER_MIN_SCALE = 0.45;
const PDF_VIEWER_DESKTOP_CACHE_SIZE = 40;
const PDF_VIEWER_MOBILE_CACHE_SIZE = 18;
const PDF_VIEWER_LARGE_DOCUMENT_CACHE_SIZE = 88;
const PDF_VIEWER_LARGE_DOCUMENT_MIN_BYTES = 10 * 1024 * 1024;
const PDF_FAST_PREVIEW_BEFORE_PAGES = 2;
const PDF_FAST_PREVIEW_AFTER_PAGES = 5;
const PDF_FAST_PREVIEW_CONCURRENCY = 3;
const PDF_SELECTION_CLEANUP_DELAY_MS = 120;
const PDF_RENDERING_STATE_FINISHED = 3;
const PDF_PAGE_KEEPALIVE_PATCH_KEY = "__athenaPdfPageKeepalive";

const EMPTY_SCREENSHOT_DRAG_STATE = {
  isDragging: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
  selection: null,
};

function cleanPdfHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([, value]) => value !== null && value !== undefined && value !== ""
    )
  );
}

function pdfSourceUrl(url) {
  if (!url) return url;
  try {
    return downloadUrl(url);
  } catch {
    return url;
  }
}

function pdfHttpHeadersForUrl(url) {
  if (!url || /^(blob:|data:)/i.test(String(url))) return undefined;
  const headers = cleanPdfHeaders({
    ...baseHeaders(),
    ...readerSensitiveHeadersForUrl(url),
  });
  const nextHeaders = shouldAttachClientIdentityToUrl(url)
    ? withClientIdentityHeaders(headers, {
        requestId: createCommunicationRequestId(),
      })
    : headers;
  return Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined;
}

function isPdfAuthError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("session client mismatch") ||
    message.includes("no auth token")
  );
}

function isProtectedHttpPdfUrl(url) {
  return !!url && /^https?:/i.test(String(url));
}

function pdfBaseLoadingOptions(pdfLoadingPolicy) {
  return {
    rangeChunkSize: pdfLoadingPolicy.rangeChunkSize,
    disableRange: pdfLoadingPolicy.disableRange,
    disableStream: pdfLoadingPolicy.disableStream,
    disableAutoFetch: pdfLoadingPolicy.disableAutoFetch,
    cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
  };
}

function pdfBlobLoadingOptions() {
  return {
    disableRange: true,
    disableStream: false,
    disableAutoFetch: false,
    cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
  };
}

const SCREENSHOT_OCR_STATUS = {
  idle: "idle",
  processing: "processing",
};
const SOURCE_HIGHLIGHT_RESTORE_MAX_ATTEMPTS = 12;
const SOURCE_HIGHLIGHT_RESTORE_DELAY_MS = 80;
const PDF_PROGRESS_RESTORE_MAX_ATTEMPTS = 40;
const PDF_PROGRESS_RESTORE_DELAY_MS = 150;
const PDF_PROGRESS_RESTORE_DONE_GUARD_MS = 900;

async function thumbnailFromPdfDocument(pdfDocument) {
  return taskScheduler.schedule(
    async () => {
      const page = await pdfDocument.getPage(1);
      const viewport = page.getViewport({ scale: 0.22 });
      const canvas = window.document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      await page.render({ canvasContext: context, viewport }).promise;
      return canvas.toDataURL("image/jpeg", 0.72);
    },
    {
      kind: "reader-thumbnail-render",
      label: "reader:pdf-thumbnail-display",
      priority: "P1",
      policy: "visible",
      resource: "render",
      abortable: true,
      scope: { route: "reader", surface: "reader-thumbnail-display" },
    }
  ).promise;
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

function pdfDocumentIdentity(document = {}) {
  return (
    document.readerDocumentId ||
    document.backupReaderDocumentId ||
    document.localDocumentId ||
    document.workspaceDocPath ||
    document.title ||
    "pdf"
  );
}

function pdfDocumentFingerprint(document = {}) {
  return [
    document.metadata?.originalFingerprint,
    document.metadata?.previewFingerprint,
    document.metadata?.size,
    document.metadata?.mtimeMs,
    document.objectUrl,
    document.title,
  ]
    .filter(Boolean)
    .join(":");
}

function clampPointToContainer(event, container) {
  const rect = container.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    containerWidth: rect.width,
    containerHeight: rect.height,
  };
}

function selectionFromPoints(startX, startY, currentX, currentY, dimensions) {
  const x = Math.min(startX, currentX);
  const y = Math.min(startY, currentY);
  const width = Math.abs(currentX - startX);
  const height = Math.abs(currentY - startY);
  const containerWidth = Math.max(1, dimensions.containerWidth || 1);
  const containerHeight = Math.max(1, dimensions.containerHeight || 1);
  return {
    x,
    y,
    width,
    height,
    containerWidth,
    containerHeight,
    ratioX: x / containerWidth,
    ratioY: y / containerHeight,
    ratioWidth: width / containerWidth,
    ratioHeight: height / containerHeight,
  };
}

function clampRatio(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function rectIntersection(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return {
    left,
    top,
    right,
    bottom,
    width,
    height,
    area: width * height,
  };
}

function PdfDocumentLifecycle({ pdfDocument, onReady }) {
  useEffect(() => {
    onReady?.(pdfDocument);
  }, [onReady, pdfDocument]);
  return null;
}

function readerPdfDebug(stage, detail = {}) {
  if (typeof window === "undefined") return;
  const payload = {
    stage,
    at: Math.round(window.performance?.now?.() || Date.now()),
    ...detail,
  };
  window.dispatchEvent(
    new CustomEvent("athena-reader-pdf-stage", { detail: payload })
  );
  if (import.meta.env.DEV || window.__ATHENA_READER_DEBUG__ === true) {
    console.debug("[reader:pdf]", payload);
  }
}

function isCoarsePointerDevice() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(pointer: coarse)")?.matches === true;
}

function desiredPdfViewerCacheSize({
  pdfSizeBytes = 0,
  pdfDocument = null,
} = {}) {
  if (isCoarsePointerDevice()) return PDF_VIEWER_MOBILE_CACHE_SIZE;
  const isLargeDocument =
    Number(pdfSizeBytes || 0) >= PDF_VIEWER_LARGE_DOCUMENT_MIN_BYTES ||
    Number(pdfDocument?.numPages || 0) >= PDF_VIEWER_DESKTOP_CACHE_SIZE;
  return isLargeDocument
    ? PDF_VIEWER_LARGE_DOCUMENT_CACHE_SIZE
    : PDF_VIEWER_DESKTOP_CACHE_SIZE;
}

function pdfPreviewDisplayPages({
  targetPageNumber = 1,
  pageCount = 0,
  before = PDF_FAST_PREVIEW_BEFORE_PAGES,
  after = PDF_FAST_PREVIEW_AFTER_PAGES,
} = {}) {
  const center = Math.max(1, Math.round(Number(targetPageNumber) || 1));
  const maxPage = Number(pageCount || 0);
  const start = Math.max(1, center - before);
  const end = maxPage > 0 ? Math.min(maxPage, center + after) : center + after;
  const pages = [];
  for (let page = start; page <= end; page++) pages.push(page);
  return pages;
}

function pdfPreviewFetchOrder(displayPages = [], targetPageNumber = 1) {
  const target = Math.max(1, Math.round(Number(targetPageNumber) || 1));
  return [...displayPages].sort((a, b) => {
    const distanceA = Math.abs(a - target);
    const distanceB = Math.abs(b - target);
    if (distanceA !== distanceB) return distanceA - distanceB;
    if (a === target) return -1;
    if (b === target) return 1;
    return a - b;
  });
}

function FastPdfTargetLayer({
  document,
  pdfDocument,
  pdfSizeBytes = 0,
  target,
  scale,
  hidden,
  title,
  onRendered,
}) {
  const wrapperRef = useRef(null);
  const canvasRef = useRef(null);
  const pageRefs = useRef(new Map());
  const renderTaskRef = useRef(null);
  const [status, setStatus] = useState("idle");
  const [renderedPage, setRenderedPage] = useState(null);
  const [previewPages, setPreviewPages] = useState({});
  const manifestPageCount = Number(
    document?.metadata?.pdfManifest?.pageCount || 0
  );
  const estimatedPageFromRatio =
    target?.ratio !== null && target?.ratio !== undefined
      ? Math.max(
          1,
          Math.round(
            Math.max(1, pdfDocument?.numPages || manifestPageCount || 1) *
              Number(target.ratio)
          )
        )
      : null;
  const targetPageNumber = Math.min(
    Math.max(
      1,
      pdfDocument?.numPages || manifestPageCount || target?.page || 1
    ),
    target?.page || estimatedPageFromRatio || 1
  );
  const targetOriginalUrl =
    document?.documentType === "pdf"
      ? document?.metadata?.originalUrl ||
        document?.metadata?.stream?.url ||
        null
      : null;
  const previewPageCount = pdfDocument?.numPages || manifestPageCount || 0;
  const displayPages = useMemo(
    () =>
      pdfPreviewDisplayPages({
        targetPageNumber,
        pageCount: previewPageCount,
      }),
    [previewPageCount, targetPageNumber]
  );
  const previewOnlyMode =
    Number(pdfSizeBytes || 0) >= PDF_VIEWER_LARGE_DOCUMENT_MIN_BYTES;

  const setPageRef = useCallback(
    (pageNumber) => (node) => {
      if (node) pageRefs.current.set(pageNumber, node);
      else pageRefs.current.delete(pageNumber);
    },
    []
  );

  const scrollFastPreviewToTarget = useCallback(() => {
    window.requestAnimationFrame(() => {
      const wrapper = wrapperRef.current;
      const targetNode = pageRefs.current.get(targetPageNumber);
      if (!wrapper || !targetNode) return;
      const offsetRatio = Math.max(
        0,
        Math.min(1, target?.pageOffsetRatio || 0)
      );
      const targetTop =
        targetNode.offsetTop +
        targetNode.clientHeight * offsetRatio -
        wrapper.clientHeight * 0.18;
      wrapper.scrollTop = Math.max(0, targetTop);
    });
  }, [target?.pageOffsetRatio, targetPageNumber]);

  useEffect(() => {
    if (!targetOriginalUrl || hidden) {
      setPreviewPages({});
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const objectUrls = [];
    const fetchOrder = pdfPreviewFetchOrder(displayPages, targetPageNumber);
    setPreviewPages(
      Object.fromEntries(
        displayPages.map((page) => [page, { status: "queued", url: null }])
      )
    );
    readerPdfDebug("target-preview-strip-start", {
      pages: fetchOrder,
      targetPage: targetPageNumber,
      reason: target?.reason,
    });

    async function loadPreviewPage(pageNumber) {
      setPreviewPages((current) => ({
        ...current,
        [pageNumber]: { ...(current[pageNumber] || {}), status: "loading" },
      }));
      try {
        const startedAt = window.performance?.now?.() || Date.now();
        const { response, blob } = await ReaderDocument.pagePreviewBlob(
          targetOriginalUrl,
          pageNumber,
          { signal: controller.signal }
        );
        if (cancelled) return;
        if (!response.ok || !blob?.size)
          throw new Error("Target page preview unavailable.");
        const objectUrl = URL.createObjectURL(blob);
        objectUrls.push(objectUrl);
        setPreviewPages((current) => ({
          ...current,
          [pageNumber]: {
            status: "done",
            url: objectUrl,
            size: blob.size,
            cache: response.headers?.get?.("X-Reader-Page-Preview-Cache"),
          },
        }));
        readerPdfDebug("target-page-preview-done", {
          page: pageNumber,
          targetPage: targetPageNumber,
          reason: target?.reason,
          size: blob.size,
          cache: response.headers?.get?.("X-Reader-Page-Preview-Cache"),
          durationMs: Math.round(
            (window.performance?.now?.() || Date.now()) - startedAt
          ),
        });
        if (pageNumber === targetPageNumber) {
          scrollFastPreviewToTarget();
          onRendered?.({ page: targetPageNumber, reason: target?.reason });
        }
      } catch (error) {
        if (cancelled || error?.name === "AbortError") return;
        setPreviewPages((current) => ({
          ...current,
          [pageNumber]: {
            ...(current[pageNumber] || {}),
            status: "error",
            error: error?.message || String(error),
          },
        }));
        readerPdfDebug("target-page-preview-error", {
          page: pageNumber,
          targetPage: targetPageNumber,
          reason: target?.reason,
          message: error?.message || String(error),
        });
      }
    }

    async function loadPreviewStrip() {
      let cursor = 0;
      const workerCount = Math.min(
        PDF_FAST_PREVIEW_CONCURRENCY,
        fetchOrder.length
      );
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (!cancelled && cursor < fetchOrder.length) {
            const pageNumber = fetchOrder[cursor++];
            await loadPreviewPage(pageNumber);
          }
        })
      );
    }

    loadPreviewStrip();

    return () => {
      cancelled = true;
      controller.abort();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [
    displayPages,
    hidden,
    onRendered,
    scrollFastPreviewToTarget,
    target?.reason,
    targetOriginalUrl,
    targetPageNumber,
  ]);

  useEffect(() => {
    let cancelled = false;
    const pageNumber = targetPageNumber;
    const offsetRatio = Math.max(0, Math.min(1, target?.pageOffsetRatio || 0));

    async function renderTargetPage() {
      if (previewOnlyMode || !pdfDocument || !canvasRef.current) return;
      renderTaskRef.current?.cancel?.();
      setStatus("rendering");
      setRenderedPage(null);
      readerPdfDebug("target-page-render-start", {
        page: pageNumber,
        reason: target?.reason,
      });

      try {
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(
          320,
          (wrapperRef.current?.clientWidth || 760) - 40
        );
        const fitScale = Math.max(
          FAST_TARGET_RENDER_MIN_SCALE,
          Math.min(
            FAST_TARGET_RENDER_MAX_SCALE,
            availableWidth / Math.max(1, baseViewport.width)
          )
        );
        const viewport = page.getViewport({
          scale: fitScale * clampScale(scale || 1),
        });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d", { alpha: false });
        const outputScale = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, viewport.width, viewport.height);
        const renderTask = page.render({ canvasContext: context, viewport });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
        if (cancelled) return;
        setRenderedPage(pageNumber);
        setStatus("done");
        window.requestAnimationFrame(() => {
          const wrapper = wrapperRef.current;
          if (!wrapper) return;
          const pageTop = canvas.offsetTop || 0;
          const targetTop =
            pageTop +
            canvas.clientHeight * offsetRatio -
            wrapper.clientHeight * 0.18;
          wrapper.scrollTop = Math.max(0, targetTop);
        });
        readerPdfDebug("target-page-render-done", {
          page: pageNumber,
          reason: target?.reason,
        });
        onRendered?.({ page: pageNumber, reason: target?.reason });
      } catch (error) {
        if (cancelled || error?.name === "RenderingCancelledException") return;
        setStatus("error");
        readerPdfDebug("target-page-render-error", {
          page: pageNumber,
          reason: target?.reason,
          message: error?.message || String(error),
        });
      }
    }

    renderTargetPage();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel?.();
    };
  }, [
    onRendered,
    pdfDocument,
    pdfDocument?.numPages,
    previewOnlyMode,
    scale,
    targetPageNumber,
    target?.page,
    target?.pageOffsetRatio,
    target?.ratio,
    target?.reason,
  ]);

  const targetPreview = previewPages[targetPageNumber];
  const targetPreviewReady = targetPreview?.status === "done";
  const anyPreviewReady = Object.values(previewPages).some(
    (page) => page?.status === "done"
  );

  return (
    <div
      className={`absolute inset-0 z-20 flex flex-col bg-slate-100 transition-opacity duration-200 light:bg-slate-100 ${
        hidden ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      aria-hidden={hidden}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200/70 bg-white/80 px-4 py-2 text-xs font-semibold text-slate-500 backdrop-blur">
        <span className="truncate">
          正在优先打开定位区块
          {target?.page ? ` · 第 ${target.page} 页` : ""}
        </span>
        {target?.reason && (
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-600">
            {target.reason}
          </span>
        )}
      </div>
      <div ref={wrapperRef} className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto flex min-h-full w-full max-w-[920px] flex-col items-center gap-4">
          {displayPages.map((pageNumber) => {
            const preview = previewPages[pageNumber];
            const isTarget = pageNumber === targetPageNumber;
            return (
              <div
                key={pageNumber}
                ref={setPageRef(pageNumber)}
                className={`relative w-full max-w-[860px] rounded bg-white shadow-[0_18px_46px_rgba(15,23,42,0.12)] ${
                  isTarget ? "ring-2 ring-sky-300/60" : ""
                }`}
              >
                <div className="absolute left-3 top-3 z-10 rounded-full border border-white/80 bg-white/85 px-2 py-0.5 text-[11px] font-semibold text-slate-500 shadow-sm backdrop-blur">
                  Page {pageNumber}
                </div>
                {preview?.url ? (
                  <img
                    src={preview.url}
                    alt={`${title || "PDF"} 第 ${pageNumber} 页预览`}
                    className="block h-auto w-full rounded"
                    draggable={false}
                    onLoad={() => {
                      if (isTarget) scrollFastPreviewToTarget();
                    }}
                  />
                ) : (
                  <div
                    className={`flex min-h-[520px] w-full items-center justify-center rounded bg-gradient-to-br from-slate-50 to-slate-100 text-sm text-slate-500 ${
                      isTarget ? "min-h-[620px]" : ""
                    }`}
                  >
                    {preview?.status === "error"
                      ? "页面预览失败，完整阅读器后台接管中..."
                      : isTarget
                        ? "正在极速生成定位页..."
                        : "邻近页面加载中..."}
                  </div>
                )}
                {!previewOnlyMode && isTarget && (
                  <canvas
                    ref={canvasRef}
                    className={`absolute inset-0 h-full w-full rounded bg-white transition-opacity duration-200 ${
                      status === "done" ? "opacity-100" : "opacity-0"
                    }`}
                    aria-label={title || "PDF 目标区块预览"}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {(renderedPage || targetPreviewReady || anyPreviewReady) && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-white/80 bg-white/90 px-3 py-1 text-xs font-semibold text-slate-500 shadow-[0_12px_28px_rgba(15,23,42,0.12)] backdrop-blur">
          第{" "}
          {targetPreviewReady
            ? targetPageNumber
            : renderedPage || targetPageNumber}{" "}
          页已可读，邻近页面与完整阅读器后台接管中
        </div>
      )}
    </div>
  );
}

const PdfReader = forwardRef(function PdfReader(
  {
    document,
    onCite,
    onThumbnailReady,
    onProgressChange,
    readerTextSources = [],
    onFocusTextSource,
    onRemoveTextSource,
  },
  ref
) {
  const containerRef = useRef(null);
  const highlighterRef = useRef(null);
  const scrollToRef = useRef(null);
  const scrollRestoreRef = useRef(null);
  const flashTimerRef = useRef(null);
  const restoreTimerRef = useRef(null);
  const selectionCleanupFrameRef = useRef([]);
  const selectionCleanupTimerRef = useRef(null);
  const sourceHighlightRestoreTimerRef = useRef(null);
  const restoredDocumentRef = useRef(null);
  const progressRestoreRef = useRef(null);
  const thumbnailDocumentIdRef = useRef(null);
  const renderedPageKeepaliveRef = useRef(new Map());
  const detectionRequestRef = useRef({ key: null, runId: 0 });
  const ocrConfigRequestRef = useRef({ key: null, runId: 0 });
  const screenshotDragRef = useRef(EMPTY_SCREENSHOT_DRAG_STATE);
  const screenshotLayoutFrameRef = useRef(null);
  const [readerContainerReady, setReaderContainerReady] = useState(false);
  const [highlights, setHighlights] = useState([]);
  const [selectionDraft, setSelectionDraft] = useState(null);
  const [scale, setScale] = useState(() => readPdfScale(document));
  const [flashHighlightId, setFlashHighlightId] = useState(null);
  const [markAvailable, setMarkAvailable] = useState(false);
  const [markedHighlightId, setMarkedHighlightId] = useState(null);
  const [detectionStatus, setDetectionStatus] = useState("idle");
  const [ocrState, setOcrState] = useState({
    isScannedPdf: false,
    ocrFallbackEnabled: false,
    detectionResult: null,
  });
  const [ocrConfigStatus, setOcrConfigStatus] = useState("idle");
  const [ocrConfig, setOcrConfig] = useState(null);
  const [toolMode, setToolMode] = useState("mouse");
  const [screenshotDragState, setScreenshotDragState] = useState(
    EMPTY_SCREENSHOT_DRAG_STATE
  );
  const [screenshotSelection, setScreenshotSelection] = useState(null);
  const [screenshotPanelOpen, setScreenshotPanelOpen] = useState(false);
  const [screenshotOcrStatus, setScreenshotOcrStatus] = useState(
    SCREENSHOT_OCR_STATUS.idle
  );
  const [screenshotLayoutTick, setScreenshotLayoutTick] = useState(0);
  const [pdfLoadState, setPdfLoadState] = useState({
    status: "idle",
    pdfDocument: null,
    error: null,
  });
  const [officialViewerReady, setOfficialViewerReady] = useState(false);
  const [jumpTargetSource, setJumpTargetSource] = useState(null);
  const url = document?.objectUrl;
  const sourceUrl = useMemo(() => pdfSourceUrl(url), [url]);
  const httpHeaders = useMemo(
    () => pdfHttpHeadersForUrl(sourceUrl),
    [sourceUrl]
  );
  const useRangeLoading =
    document?.renderType === "pdf-stream" ||
    document?.metadata?.stream?.supportsRange;
  const pdfSizeBytes = Number(
    document?.metadata?.stream?.size || document?.metadata?.size || 0
  );
  const pdfLoadingPolicy = useMemo(
    () =>
      pdfLoadingPolicyForDocument({
        useRangeLoading,
        sizeBytes: pdfSizeBytes,
      }),
    [pdfSizeBytes, useRangeLoading]
  );
  const initialPdfTarget = useMemo(
    () =>
      resolvePdfInitialTarget({
        document,
        readerTextSources,
        jumpSource: jumpTargetSource,
      }),
    [document, jumpTargetSource, readerTextSources]
  );
  const pdfScaleKey = pdfScaleDocumentKey(document);
  const documentId = pdfDocumentIdentity(document);
  const pdfFingerprint = pdfDocumentFingerprint(document);
  const pdfDetectionKey = `${documentId}:${pdfFingerprint}`;

  const scaleValue = scale.toFixed(2);
  const zoomPercent = Math.round(scale * 100);
  const markedHighlight =
    markAvailable && markedHighlightId
      ? highlights.find((highlight) => highlight.id === markedHighlightId)
      : null;
  const isPdfPreview = document?.renderType === "pdf-preview";
  const isOriginalPdf =
    document?.documentType === "pdf" && document?.renderType !== "pdf-preview";
  const showOcrTools =
    isOriginalPdf &&
    readerContainerReady &&
    detectionStatus === "done" &&
    ocrState.isScannedPdf;
  const screenshotModeAvailable = ocrConfigStatus === "configured";
  const screenshotButtonTitle = screenshotModeAvailable
    ? "截图框选模式"
    : ocrConfigStatus === "checking"
      ? "正在检查 OCR 配置"
      : ocrConfig?.reason
        ? `OCR 模型或 API Key 未配置：${ocrConfig.reason}`
        : "OCR 模型或 API Key 未配置";

  useEffect(() => {
    setJumpTargetSource(null);
  }, [documentId, pdfFingerprint]);

  useEffect(() => {
    setOfficialViewerReady(false);
  }, [
    documentId,
    pdfFingerprint,
    initialPdfTarget?.page,
    initialPdfTarget?.sourceKey,
  ]);

  function clearBrowserSelection() {
    const selection = window.getSelection?.();
    if (selection?.removeAllRanges) selection.removeAllRanges();
  }

  const setContainerNode = useCallback((node) => {
    containerRef.current = node;
    setReaderContainerReady(!!node);
  }, []);

  function setScreenshotDrag(nextState) {
    screenshotDragRef.current = nextState;
    setScreenshotDragState(nextState);
  }

  function resetScreenshotInteraction(options = {}) {
    setScreenshotDrag(EMPTY_SCREENSHOT_DRAG_STATE);
    if (options.clearSelection) {
      setScreenshotSelection(null);
      setScreenshotPanelOpen(false);
      setScreenshotOcrStatus(SCREENSHOT_OCR_STATUS.idle);
    }
    if (options.resetMode) setToolMode("mouse");
  }

  function scheduleScreenshotLayoutUpdate() {
    if (screenshotLayoutFrameRef.current) return;
    screenshotLayoutFrameRef.current = window.requestAnimationFrame(() => {
      screenshotLayoutFrameRef.current = null;
      setScreenshotLayoutTick((tick) => tick + 1);
    });
  }

  function cancelSelectionCleanup() {
    selectionCleanupFrameRef.current.forEach((frameId) =>
      window.cancelAnimationFrame(frameId)
    );
    selectionCleanupFrameRef.current = [];
    window.clearTimeout(selectionCleanupTimerRef.current);
    selectionCleanupTimerRef.current = null;
  }

  function deferSelectionCleanup(hideTipAndSelection) {
    cancelSelectionCleanup();
    readerPdfDebug("selection-cleanup-scheduled", {
      delayMs: PDF_SELECTION_CLEANUP_DELAY_MS,
    });
    selectionCleanupTimerRef.current = window.setTimeout(() => {
      const frameId = window.requestAnimationFrame(() => {
        highlighterRef.current?.renderHighlightLayers?.();
        hideTipAndSelection?.();
        clearBrowserSelection();
        window.requestAnimationFrame(() => {
          highlighterRef.current?.renderHighlightLayers?.();
          readerPdfDebug("selection-cleanup-done", {
            highlightCount: highlights.length,
            draft: !!selectionDraft,
          });
        });
        selectionCleanupFrameRef.current = [];
        selectionCleanupTimerRef.current = null;
      });
      selectionCleanupFrameRef.current = [frameId];
    }, PDF_SELECTION_CLEANUP_DELAY_MS);
  }

  function viewerContainer() {
    return highlighterRef.current?.viewer?.container || null;
  }

  function evictRenderedPageKeepalive(maxSize) {
    const cache = renderedPageKeepaliveRef.current;
    while (cache.size > maxSize) {
      const [pageId, entry] = cache.entries().next().value || [];
      if (!entry) break;
      cache.delete(pageId);
      entry.originalDestroy?.();
      readerPdfDebug("viewer-page-keepalive-evicted", {
        page: pageId,
        cacheSize: maxSize,
      });
    }
  }

  function rememberRenderedPageView(pageView) {
    if (!pageView?.id) return;
    const cacheSize = desiredPdfViewerCacheSize({
      pdfSizeBytes,
      pdfDocument: pdfLoadState.pdfDocument,
    });
    const patch = pageView[PDF_PAGE_KEEPALIVE_PATCH_KEY];
    if (!patch) return;
    const cache = renderedPageKeepaliveRef.current;
    cache.delete(pageView.id);
    cache.set(pageView.id, {
      pageView,
      originalDestroy: patch.originalDestroy,
    });
    evictRenderedPageKeepalive(cacheSize);
  }

  function applyPdfViewerPageKeepalive() {
    const viewer = highlighterRef.current?.viewer;
    const pages = Array.isArray(viewer?._pages) ? viewer._pages : [];
    if (!pages.length) return;
    let patched = 0;
    for (const pageView of pages) {
      if (!pageView || pageView[PDF_PAGE_KEEPALIVE_PATCH_KEY]) continue;
      const originalDestroy = pageView.destroy?.bind(pageView);
      if (typeof originalDestroy !== "function") continue;
      pageView[PDF_PAGE_KEEPALIVE_PATCH_KEY] = { originalDestroy };
      pageView.destroy = function athenaKeepRenderedPdfPage() {
        if (this.renderingState === PDF_RENDERING_STATE_FINISHED) {
          rememberRenderedPageView(this);
          if (renderedPageKeepaliveRef.current.has(this.id)) {
            readerPdfDebug("viewer-page-destroy-skipped", {
              page: this.id,
            });
            return;
          }
        }
        renderedPageKeepaliveRef.current.delete(this.id);
        return originalDestroy();
      };
      patched += 1;
    }
    if (patched > 0) {
      readerPdfDebug("viewer-page-keepalive-ready", {
        patched,
        cacheSize: desiredPdfViewerCacheSize({
          pdfSizeBytes,
          pdfDocument: pdfLoadState.pdfDocument,
        }),
        numPages: pdfLoadState.pdfDocument?.numPages || null,
      });
    }
  }

  function ensurePdfProgressRestoreState() {
    const key = pdfProgressRestoreKey(document, document?.progress);
    const existing = progressRestoreRef.current;
    if (
      existing?.documentId === documentId &&
      existing?.fingerprint === pdfFingerprint
    ) {
      return existing;
    }
    const targetProgress = document?.progress || null;
    const target = pdfProgressRestoreTarget(targetProgress);
    const nextState = {
      documentId,
      fingerprint: pdfFingerprint,
      key,
      target,
      targetProgress,
      status: target ? "pending" : "done",
      startedAt: Date.now(),
      completedAt: target ? 0 : Date.now(),
      userInteracted: false,
    };
    progressRestoreRef.current = nextState;
    return nextState;
  }

  function pdfRestoreGuard() {
    const state = progressRestoreRef.current || ensurePdfProgressRestoreState();
    const recentlyCompleted =
      state.status === "done" &&
      Date.now() - Number(state.completedAt || 0) <
        PDF_PROGRESS_RESTORE_DONE_GUARD_MS;
    return {
      ...state,
      active:
        state.status === "pending" ||
        state.status === "failed" ||
        recentlyCompleted,
    };
  }

  function finishPdfProgressRestore(status) {
    const state = progressRestoreRef.current || ensurePdfProgressRestoreState();
    progressRestoreRef.current = {
      ...state,
      status,
      completedAt: Date.now(),
    };
  }

  function markPdfUserInteraction() {
    const state = progressRestoreRef.current || ensurePdfProgressRestoreState();
    progressRestoreRef.current = { ...state, userInteracted: true };
  }

  useEffect(() => {
    if (!sourceUrl) {
      setPdfLoadState({ status: "idle", pdfDocument: null, error: null });
      return;
    }

    let cancelled = false;
    let loadingTask = null;
    let loadedDocument = null;
    let fallbackObjectUrl = null;
    const startedAt = Date.now();
    setOfficialViewerReady(false);
    setPdfLoadState({ status: "loading", pdfDocument: null, error: null });
    const sensitiveState = readerSensitiveSessionStateForUrl(sourceUrl);
    readerPdfDebug("document-load-start", {
      mode: pdfLoadingPolicy.mode,
      sourceKind: /^(blob:|data:)/i.test(String(sourceUrl || ""))
        ? "local"
        : "http",
      sensitive: {
        hasDescriptor: sensitiveState.hasDescriptor,
        hasHeader: sensitiveState.hasHeader,
        hasDirectSession: sensitiveState.hasDirectSession,
        hasAliasSession: sensitiveState.hasAliasSession,
        namespace: sensitiveState.namespace || null,
      },
      headerNames: Object.keys(httpHeaders || {}),
    });

    async function ensurePdfSensitiveSession(reason = "preflight") {
      if (!isProtectedHttpPdfUrl(sourceUrl)) return null;
      const before = readerSensitiveSessionStateForUrl(sourceUrl);
      if (!before.hasDescriptor || before.hasHeader) return before;
      readerPdfDebug("document-sensitive-refresh-start", {
        reason,
        namespace: before.namespace || null,
        hasDirectSession: before.hasDirectSession,
        hasAliasSession: before.hasAliasSession,
      });
      await ReaderDocument.refreshSensitiveSessionForUrl(sourceUrl, {
        task: {
          label: "reader:pdf-sensitive-session-refresh",
          kind: "reader",
          priority: "P0",
          policy: "foreground",
          resource: "network",
          emergency: true,
          intentRank: 0,
          scope: {
            route: "reader",
            surface: "reader-open",
            readerDocumentId: before.readerDocumentId || null,
          },
        },
      });
      const after = readerSensitiveSessionStateForUrl(sourceUrl);
      readerPdfDebug("document-sensitive-refresh-done", {
        reason,
        namespace: after.namespace || null,
        hasHeader: after.hasHeader,
        hasDirectSession: after.hasDirectSession,
        hasAliasSession: after.hasAliasSession,
      });
      return after;
    }

    function loadPdfViaHttp(pdfjs) {
      return pdfjs.getDocument({
        url: sourceUrl,
        httpHeaders: pdfHttpHeadersForUrl(sourceUrl),
        withCredentials: true,
        ...pdfBaseLoadingOptions(pdfLoadingPolicy),
      });
    }

    async function loadPdfDocument() {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf");
      pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_ASSET_BASE}pdf.worker.min.js`;
      try {
        await ensurePdfSensitiveSession("preflight");
        if (cancelled) return;
        loadingTask = loadPdfViaHttp(pdfjs);
        loadedDocument = await loadingTask.promise;
      } catch (error) {
        loadingTask?.destroy?.();
        loadingTask = null;
        if (!isPdfAuthError(error) || !isProtectedHttpPdfUrl(sourceUrl)) {
          throw error;
        }

        try {
          readerPdfDebug("document-auth-refresh-start", {
            message: error?.message || String(error),
          });
          await ReaderDocument.refreshSensitiveSessionForUrl(sourceUrl, {
            task: {
              label: "reader:pdf-auth-refresh",
              kind: "reader",
              priority: "P0",
              policy: "foreground",
              resource: "network",
              emergency: true,
              intentRank: 0,
              scope: {
                route: "reader",
                surface: "reader-open",
                readerDocumentId:
                  readerSensitiveSessionStateForUrl(sourceUrl)
                    .readerDocumentId || null,
              },
            },
          });
          if (cancelled) return;
          loadingTask = loadPdfViaHttp(pdfjs);
          loadedDocument = await loadingTask.promise;
          readerPdfDebug("document-auth-refresh-retry-done", {
            hasHeader: readerSensitiveSessionStateForUrl(sourceUrl).hasHeader,
          });
          return;
        } catch (retryError) {
          loadingTask?.destroy?.();
          loadingTask = null;
          readerPdfDebug("document-auth-refresh-retry-error", {
            message: retryError?.message || String(retryError),
            hasHeader: readerSensitiveSessionStateForUrl(sourceUrl).hasHeader,
          });
        }

        if (pdfSizeBytes > PDF_FAST_STREAM_MAX_BYTES) {
          readerPdfDebug("document-auth-fallback-skipped", {
            size: pdfSizeBytes,
            maxFallbackSize: PDF_FAST_STREAM_MAX_BYTES,
            message: error?.message || String(error),
          });
          throw error;
        }

        readerPdfDebug("document-auth-fallback-start", {
          message: error?.message || String(error),
        });
        const { blob } = await ReaderDocument.originalBlob(sourceUrl);
        if (cancelled) return;
        fallbackObjectUrl = URL.createObjectURL(blob);
        loadingTask = pdfjs.getDocument({
          url: fallbackObjectUrl,
          ...pdfBlobLoadingOptions(),
        });
        loadedDocument = await loadingTask.promise;
        readerPdfDebug("document-auth-fallback-done", {
          size: blob?.size || null,
        });
      }
      if (cancelled) {
        loadedDocument?.destroy?.();
        return;
      }
      readerPdfDebug("document-load-done", {
        durationMs: Date.now() - startedAt,
        mode: pdfLoadingPolicy.mode,
        numPages: loadedDocument?.numPages || null,
      });
      setPdfLoadState({
        status: "ready",
        pdfDocument: loadedDocument,
        error: null,
      });
    }

    loadPdfDocument().catch((error) => {
      if (cancelled) return;
      readerPdfDebug("document-load-error", {
        durationMs: Date.now() - startedAt,
        message: error?.message || String(error),
      });
      setPdfLoadState({
        status: "error",
        pdfDocument: null,
        error,
      });
    });

    return () => {
      cancelled = true;
      loadingTask?.destroy?.();
      loadedDocument?.destroy?.();
      if (fallbackObjectUrl) URL.revokeObjectURL(fallbackObjectUrl);
    };
  }, [
    httpHeaders,
    pdfLoadingPolicy.disableAutoFetch,
    pdfLoadingPolicy.disableRange,
    pdfLoadingPolicy.disableStream,
    pdfLoadingPolicy.mode,
    pdfLoadingPolicy.rangeChunkSize,
    pdfSizeBytes,
    sourceUrl,
  ]);

  useEffect(() => {
    readerPdfDebug("target-resolved", {
      page: initialPdfTarget?.page || null,
      ratio: initialPdfTarget?.ratio ?? null,
      reason: initialPdfTarget?.reason || null,
      sourceKey: initialPdfTarget?.sourceKey || null,
    });
  }, [
    initialPdfTarget?.page,
    initialPdfTarget?.ratio,
    initialPdfTarget?.reason,
    initialPdfTarget?.sourceKey,
  ]);

  useEffect(() => {
    if (!pdfLoadState.pdfDocument || officialViewerReady) return;
    const targetPage = Math.max(
      1,
      Math.round(Number(initialPdfTarget?.page || 1))
    );
    let cancelled = false;
    let attempts = 0;
    let timer = null;

    function checkOfficialTargetPage() {
      if (cancelled) return;
      attempts += 1;
      if (isOfficialPdfPageRendered(targetPage)) {
        setOfficialViewerReady(true);
        readerPdfDebug("official-viewer-ready", {
          targetPage,
          targetReason: initialPdfTarget?.reason || null,
          attempts,
        });
        return;
      }
      if (attempts <= 120) {
        timer = window.setTimeout(checkOfficialTargetPage, 100);
      }
    }

    timer = window.setTimeout(checkOfficialTargetPage, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    initialPdfTarget?.page,
    initialPdfTarget?.reason,
    officialViewerReady,
    pdfLoadState.pdfDocument,
    scaleValue,
  ]);

  function pageElements(container) {
    return [...(container?.querySelectorAll(".page[data-page-number]") || [])];
  }

  function pageElementByNumber(pageNumber) {
    const container = viewerContainer();
    if (!container || !pageNumber) return null;
    return pageElements(container).find(
      (page) => Number(page.getAttribute("data-page-number")) === pageNumber
    );
  }

  function isOfficialPdfPageRendered(pageNumber) {
    const page = pageElementByNumber(pageNumber);
    if (!page) return false;
    const canvas = page.querySelector("canvas");
    const loadingIcon = page.querySelector(".loadingIcon");
    return !!canvas?.width && !!canvas?.height && !loadingIcon;
  }

  function isValidScaledRect(rect) {
    return ["x1", "y1", "x2", "y2", "width", "height"].every((key) =>
      Number.isFinite(Number(rect?.[key]))
    );
  }

  function isValidScaledPosition(position) {
    if (!position || !Number.isFinite(Number(position.pageNumber)))
      return false;
    if (!isValidScaledRect(position.boundingRect)) return false;
    if (!Array.isArray(position.rects) || position.rects.length === 0)
      return false;
    return position.rects.every(isValidScaledRect);
  }

  function isPdfHighlightLayerReady(pageNumber) {
    const page = pageElementByNumber(pageNumber);
    const pageView = highlighterRef.current?.viewer?.getPageView?.(
      pageNumber - 1
    );
    return !!(page && pageView?.viewport && pageView?.textLayer?.textLayerDiv);
  }

  function sourceHighlightId(source, pageNumber) {
    return source.highlightId || `${pageNumber || 0}-${source.textHash}`;
  }

  function clearSourceHighlightRestoreTimer() {
    window.clearTimeout(sourceHighlightRestoreTimerRef.current);
    sourceHighlightRestoreTimerRef.current = null;
  }

  function restoreTextSourceHighlightWhenReady(
    source,
    pageNumber,
    attempt = 0
  ) {
    if (!isValidScaledPosition(source?.position)) return false;

    if (!isPdfHighlightLayerReady(pageNumber)) {
      if (attempt >= SOURCE_HIGHLIGHT_RESTORE_MAX_ATTEMPTS) return false;
      clearSourceHighlightRestoreTimer();
      sourceHighlightRestoreTimerRef.current = window.setTimeout(() => {
        restoreTextSourceHighlightWhenReady(source, pageNumber, attempt + 1);
      }, SOURCE_HIGHLIGHT_RESTORE_DELAY_MS);
      return true;
    }

    const id = sourceHighlightId(source, pageNumber);
    const highlight = {
      id,
      position: source.position,
      content: { text: source.selectedText || "" },
      selection: { ...source, highlightId: id },
      sourceKey: source.sourceKey,
      citationNo: source.citationNo,
    };

    setSelectionDraft(null);
    setMarkAvailable(false);
    setMarkedHighlightId(null);
    setHighlights((current) => [
      ...current.filter(
        (item) => item.sourceKey !== source.sourceKey && item.id !== id
      ),
      highlight,
    ]);
    window.requestAnimationFrame(() => {
      scrollToRef.current?.(highlight);
      highlighterRef.current?.renderHighlightLayers?.();
      flashHighlight(id);
    });
    return true;
  }

  function citationBadgeStyle(position) {
    const anchor = position?.rects?.[0] || position?.boundingRect;
    if (!anchor) return null;
    const left = Number(anchor.left);
    const top = Number(anchor.top);
    const width = Number(anchor.width);
    if (![left, top, width].every(Number.isFinite)) return null;
    return {
      left: `${Math.max(0, left + width - 10)}px`,
      top: `${Math.max(0, top - 12)}px`,
    };
  }

  function viewportRectFromContainerSelection(selection) {
    const container = containerRef.current;
    if (!container || !selection) return null;
    const containerRect = container.getBoundingClientRect();
    return {
      left: containerRect.left + selection.x,
      top: containerRect.top + selection.y,
      right: containerRect.left + selection.x + selection.width,
      bottom: containerRect.top + selection.y + selection.height,
      width: selection.width,
      height: selection.height,
    };
  }

  function anchorScreenshotSelection(selection) {
    const container = viewerContainer();
    const viewportRect = viewportRectFromContainerSelection(selection);
    if (!container || !viewportRect) return null;

    const pageMatch = pageElements(container)
      .map((page, index) => {
        const rect = page.getBoundingClientRect();
        const pageNumber =
          Number(page.getAttribute("data-page-number")) || index + 1;
        return {
          page,
          pageNumber,
          rect,
          intersection: rectIntersection(viewportRect, rect),
        };
      })
      .filter((candidate) => candidate.intersection.area > 0)
      .sort((a, b) => b.intersection.area - a.intersection.area)[0];

    if (!pageMatch) return null;

    const { rect, intersection, pageNumber } = pageMatch;
    if (
      intersection.width < MIN_SCREENSHOT_SELECTION_WIDTH ||
      intersection.height < MIN_SCREENSHOT_SELECTION_HEIGHT
    )
      return null;

    const id = `screenshot:${pageNumber}:${Date.now()}`;
    return {
      id,
      highlightId: id,
      pageNumber,
      ratioX: clampRatio((intersection.left - rect.left) / rect.width),
      ratioY: clampRatio((intersection.top - rect.top) / rect.height),
      ratioWidth: clampRatio(intersection.width / rect.width),
      ratioHeight: clampRatio(intersection.height / rect.height),
      documentTitle: document.title,
      documentType: document.documentType || "pdf",
      readerDocumentId: document.readerDocumentId,
      localDocumentId: document.localDocumentId,
      backupReaderDocumentId: document.backupReaderDocumentId,
      source: document.source,
      locator: {
        ...(isPdfPreview ? { type: "pdf-preview" } : {}),
        page: pageNumber,
        pageOffsetRatio: clampRatio(
          (intersection.top - rect.top) / rect.height
        ),
      },
      locatorLabel: `page ${pageNumber} 截图`,
      marked: false,
    };
  }

  function screenshotSelectionStyle(selection, layoutTick = 0) {
    void layoutTick;
    if (!selection) return null;
    const page = pageElementByNumber(selection.pageNumber);
    const container = containerRef.current;
    if (!page || !container) return null;

    const pageRect = page.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      left: `${pageRect.left - containerRect.left + selection.ratioX * pageRect.width}px`,
      top: `${pageRect.top - containerRect.top + selection.ratioY * pageRect.height}px`,
      width: `${selection.ratioWidth * pageRect.width}px`,
      height: `${selection.ratioHeight * pageRect.height}px`,
    };
  }

  function cropScreenshotSelectionDataUrl(selection) {
    const page = pageElementByNumber(selection?.pageNumber);
    const canvas = page?.querySelector("canvas");
    if (!page || !canvas) throw new Error("无法读取当前 PDF 页面图像。");

    const pageRect = page.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const selectionRect = {
      left: pageRect.left + selection.ratioX * pageRect.width,
      top: pageRect.top + selection.ratioY * pageRect.height,
      right:
        pageRect.left +
        (selection.ratioX + selection.ratioWidth) * pageRect.width,
      bottom:
        pageRect.top +
        (selection.ratioY + selection.ratioHeight) * pageRect.height,
    };
    const cropRect = rectIntersection(selectionRect, canvasRect);
    if (
      cropRect.width < MIN_SCREENSHOT_SELECTION_WIDTH ||
      cropRect.height < MIN_SCREENSHOT_SELECTION_HEIGHT
    ) {
      throw new Error("截图区域太小，无法识别。");
    }

    const scaleX = canvas.width / Math.max(1, canvasRect.width);
    const scaleY = canvas.height / Math.max(1, canvasRect.height);
    const sx = Math.max(
      0,
      Math.floor((cropRect.left - canvasRect.left) * scaleX)
    );
    const sy = Math.max(
      0,
      Math.floor((cropRect.top - canvasRect.top) * scaleY)
    );
    const sw = Math.min(canvas.width - sx, Math.ceil(cropRect.width * scaleX));
    const sh = Math.min(
      canvas.height - sy,
      Math.ceil(cropRect.height * scaleY)
    );
    if (sw <= 0 || sh <= 0) throw new Error("截图区域不可用。");

    const output = window.document.createElement("canvas");
    output.width = sw;
    output.height = sh;
    const outputContext = output.getContext("2d");
    if (!outputContext) throw new Error("无法创建截图画布。");
    outputContext.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return output.toDataURL("image/png");
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
    if (
      progress &&
      !shouldSuppressPdfProgressDuringRestore(progress, pdfRestoreGuard())
    ) {
      onProgressChange?.(progress);
    }
    if (screenshotSelection) scheduleScreenshotLayoutUpdate();
  }

  useImperativeHandle(
    ref,
    () => ({
      getCurrentProgress: () => capturePdfProgress(),
    }),
    [capturePdfProgress]
  );

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

  function scrollToScreenshotSelection(selection = screenshotSelection) {
    const container = viewerContainer();
    const page = pageElementByNumber(selection?.pageNumber);
    if (!container || !page || !selection) return;
    container.scrollTo({
      top: page.offsetTop + page.clientHeight * Math.max(0, selection.ratioY),
      behavior: "smooth",
    });
    window.setTimeout(scheduleScreenshotLayoutUpdate, 120);
  }

  async function citeScreenshotSelection() {
    if (
      !screenshotSelection ||
      screenshotOcrStatus === SCREENSHOT_OCR_STATUS.processing
    )
      return;

    try {
      setScreenshotOcrStatus(SCREENSHOT_OCR_STATUS.processing);
      showToast("正在识别截图文字", "info");
      const imageDataUrl = cropScreenshotSelectionDataUrl(screenshotSelection);
      const { response, data } = await ReaderDocument.ocrScreenshot(null, {
        imageDataUrl,
      });
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "OCR 识别失败。");
      }

      const selectedText = String(data.text || "").trim();
      if (!selectedText) throw new Error("OCR 未识别到文字。");

      const textHashValue = textHash(selectedText);
      const selectionPayload = {
        source: screenshotSelection.source,
        documentTitle: screenshotSelection.documentTitle,
        documentType: screenshotSelection.documentType,
        readerDocumentId: screenshotSelection.readerDocumentId,
        localDocumentId: screenshotSelection.localDocumentId,
        backupReaderDocumentId: screenshotSelection.backupReaderDocumentId,
        selectedText,
        textHash: textHashValue,
        highlightId: screenshotSelection.highlightId,
        locator: screenshotSelection.locator,
        locatorLabel: screenshotSelection.locatorLabel,
        screenshotSelection: {
          pageNumber: screenshotSelection.pageNumber,
          ratioX: screenshotSelection.ratioX,
          ratioY: screenshotSelection.ratioY,
          ratioWidth: screenshotSelection.ratioWidth,
          ratioHeight: screenshotSelection.ratioHeight,
        },
        ocrProvider: data.provider || ocrConfig?.provider || "alibaba",
        ocrModel: data.model || null,
      };
      const citedSource = onCite(selectionPayload);
      if (citedSource) {
        setScreenshotSelection((current) =>
          current?.id === screenshotSelection.id
            ? {
                ...current,
                ...citedSource,
                selectedText,
                textHash: textHashValue,
                marked: true,
              }
            : current
        );
        setScreenshotPanelOpen(false);
      }
    } catch (error) {
      showToast(error.message || "OCR 识别失败", "error");
    } finally {
      setScreenshotOcrStatus(SCREENSHOT_OCR_STATUS.idle);
    }
  }

  function markScreenshotSelection() {
    if (!screenshotSelection) return;
    setScreenshotSelection((current) =>
      current ? { ...current, marked: true } : current
    );
    setScreenshotPanelOpen(false);
  }

  function clearScreenshotSelection() {
    if (screenshotSelection?.sourceKey)
      onRemoveTextSource?.(screenshotSelection.sourceKey);
    setScreenshotSelection(null);
    setScreenshotPanelOpen(false);
    setScreenshotOcrStatus(SCREENSHOT_OCR_STATUS.idle);
  }

  function scrollToSelectionSource(source) {
    if (!source) return;
    clearSourceHighlightRestoreTimer();
    const matchingHighlight = highlights.find(
      (highlight) =>
        highlight.selection?.textHash === source.textHash ||
        highlight.id === source.highlightId
    );
    if (matchingHighlight) {
      if (matchingHighlight.sourceKey) {
        scrollToRef.current?.(matchingHighlight);
        flashHighlight(matchingHighlight.id);
        setSelectionDraft(null);
        clearBrowserSelection();
        return;
      }
      openSelectionPanelFromHighlight(matchingHighlight);
      return;
    }
    if (source.screenshotSelection) {
      const fallbackId =
        source.highlightId || source.sourceKey || `screenshot:${Date.now()}`;
      const screenshotSourceSelection = {
        ...source.screenshotSelection,
        id: fallbackId,
        highlightId: fallbackId,
        source: source.source,
        documentTitle: source.documentTitle,
        documentType: source.documentType || "pdf",
        readerDocumentId: source.readerDocumentId,
        localDocumentId: source.localDocumentId,
        backupReaderDocumentId: source.backupReaderDocumentId,
        locator: source.locator,
        locatorLabel: source.locatorLabel,
        sourceKey: source.sourceKey,
        citationNo: source.citationNo,
        selectedText: source.selectedText,
        textHash: source.textHash,
        marked: true,
      };
      setScreenshotSelection(screenshotSourceSelection);
      setScreenshotPanelOpen(true);
      scrollToScreenshotSelection(screenshotSourceSelection);
      return;
    }
    const container = viewerContainer();
    const pageNumber = Number(
      source.locator?.page || source.position?.pageNumber || 0
    );
    if (!container || !pageNumber) return;
    const page = pageElementByNumber(pageNumber);
    if (!page) {
      restoreTextSourceHighlightWhenReady(source, pageNumber);
      return;
    }
    const offsetRatio = Number(source.locator?.pageOffsetRatio || 0);
    container.scrollTo({
      top: page.offsetTop + page.clientHeight * Math.max(0, offsetRatio),
      behavior: "smooth",
    });
    restoreTextSourceHighlightWhenReady(source, pageNumber);
  }

  function schedulePdfProgressRestore(attempt = 0) {
    window.clearTimeout(restoreTimerRef.current);
    restoreTimerRef.current = window.setTimeout(
      () => restorePdfProgress(attempt + 1),
      PDF_PROGRESS_RESTORE_DELAY_MS
    );
  }

  function restorePdfProgress(attempt = 0) {
    const state = progressRestoreRef.current || ensurePdfProgressRestoreState();
    const target =
      state.target || pdfProgressRestoreTarget(state.targetProgress);
    if (!target) {
      finishPdfProgressRestore("done");
      return;
    }
    const container = viewerContainer();
    if (!container) {
      if (attempt < PDF_PROGRESS_RESTORE_MAX_ATTEMPTS) {
        schedulePdfProgressRestore(attempt);
        return;
      }
      finishPdfProgressRestore("failed");
      return;
    }
    const pageNumber = Number(target.page || 0);
    const pages = pageElements(container);
    const page = pageNumber
      ? pages.find(
          (element) =>
            Number(element.getAttribute("data-page-number")) === pageNumber
        )
      : null;
    if (page) {
      const pageOffsetRatio = Number(target.pageOffsetRatio || 0);
      container.scrollTop =
        page.offsetTop + page.clientHeight * Math.max(0, pageOffsetRatio);
      finishPdfProgressRestore("done");
      window.setTimeout(reportPdfProgress, 60);
      return;
    }
    if (
      attempt < PDF_PROGRESS_RESTORE_MAX_ATTEMPTS &&
      (pageNumber || pages.length === 0)
    ) {
      schedulePdfProgressRestore(attempt);
      return;
    }
    const range = container.scrollHeight - container.clientHeight;
    if (range > 0 && target.ratio) {
      container.scrollTop = range * target.ratio;
      finishPdfProgressRestore("done");
      window.setTimeout(reportPdfProgress, 60);
      return;
    }
    if (attempt < PDF_PROGRESS_RESTORE_MAX_ATTEMPTS && target.ratio) {
      schedulePdfProgressRestore(attempt);
      return;
    }
    finishPdfProgressRestore("failed");
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

  const handlePdfDocumentReady = useCallback(
    (pdfDocument) => {
      if (!pdfDocument || !isOriginalPdf) return;
      const key = pdfDetectionKey;
      if (detectionRequestRef.current.key === key) return;
      const runId = detectionRequestRef.current.runId + 1;
      detectionRequestRef.current = { key, runId };
      setDetectionStatus("checking");
      setOcrState({
        isScannedPdf: false,
        ocrFallbackEnabled: false,
        detectionResult: null,
      });

      detectPdfTextLayer({
        pdfDocument,
        documentId,
        pdfFingerprint,
      })
        .then((result) => {
          const current = detectionRequestRef.current;
          if (
            current.key !== key ||
            current.runId !== runId ||
            result.documentId !== documentId ||
            result.pdfFingerprint !== pdfFingerprint
          )
            return;
          setDetectionStatus("done");
          setOcrState({
            isScannedPdf: result.isLikelyScannedPdf,
            ocrFallbackEnabled: result.isLikelyScannedPdf,
            detectionResult: result,
          });
        })
        .catch(() => {
          const current = detectionRequestRef.current;
          if (current.key !== key || current.runId !== runId) return;
          setDetectionStatus("failed");
          setOcrState({
            isScannedPdf: false,
            ocrFallbackEnabled: false,
            detectionResult: {
              documentId,
              pdfFingerprint,
              isPdf: true,
              pageCount: Number(pdfDocument?.numPages || 0),
              hasTextLayer: false,
              extractedTextLength: 0,
              averageTextLengthPerPage: 0,
              isLikelyScannedPdf: false,
              reason: "detection_failed",
            },
          });
        });
    },
    [documentId, isOriginalPdf, pdfDetectionKey, pdfFingerprint]
  );

  useEffect(() => {
    if (!pdfScaleKey) {
      setScale(1);
      return;
    }
    setScale(clampScale(readPdfScaleMap()[pdfScaleKey] || 1));
  }, [pdfScaleKey]);

  useEffect(() => {
    const targetProgress = document?.progress || null;
    progressRestoreRef.current = {
      documentId,
      fingerprint: pdfFingerprint,
      key: pdfProgressRestoreKey(document, targetProgress),
      target: pdfProgressRestoreTarget(targetProgress),
      targetProgress,
      status: pdfProgressRestoreTarget(targetProgress) ? "pending" : "done",
      startedAt: Date.now(),
      completedAt: pdfProgressRestoreTarget(targetProgress) ? 0 : Date.now(),
      userInteracted: false,
    };
    restoredDocumentRef.current = null;
    window.clearTimeout(restoreTimerRef.current);
    detectionRequestRef.current = {
      key: null,
      runId: detectionRequestRef.current.runId + 1,
    };
    ocrConfigRequestRef.current = {
      key: null,
      runId: ocrConfigRequestRef.current.runId + 1,
    };
    setDetectionStatus(isOriginalPdf ? "idle" : "done");
    setOcrState({
      isScannedPdf: false,
      ocrFallbackEnabled: false,
      detectionResult: null,
    });
    setOcrConfigStatus("idle");
    setOcrConfig(null);
    setToolMode("mouse");
    clearSourceHighlightRestoreTimer();
    setScreenshotSelection(null);
    setScreenshotDrag(EMPTY_SCREENSHOT_DRAG_STATE);
    setScreenshotPanelOpen(false);
    setScreenshotOcrStatus(SCREENSHOT_OCR_STATUS.idle);
  }, [documentId, isOriginalPdf, pdfDetectionKey, pdfFingerprint]);

  useEffect(() => {
    if (!showOcrTools) return;
    const key = `${pdfDetectionKey}:global-reader`;
    if (ocrConfigRequestRef.current.key === key) return;

    const runId = ocrConfigRequestRef.current.runId + 1;
    ocrConfigRequestRef.current = { key, runId };
    setOcrConfigStatus("checking");
    ReaderDocument.ocrConfig(null)
      .then(({ response, data }) => {
        const current = ocrConfigRequestRef.current;
        if (current.key !== key || current.runId !== runId) return;
        if (!response.ok || !data?.success) {
          setOcrConfigStatus("failed");
          setOcrConfig(null);
          return;
        }
        setOcrConfig(data);
        setOcrConfigStatus(data.configured ? "configured" : "missing");
      })
      .catch(() => {
        const current = ocrConfigRequestRef.current;
        if (current.key !== key || current.runId !== runId) return;
        setOcrConfigStatus("failed");
        setOcrConfig(null);
      });
  }, [document?.workspaceSlug, pdfDetectionKey, showOcrTools]);

  useEffect(() => {
    if (toolMode !== "screenshot") return;
    const cancelOnEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      resetScreenshotInteraction({ resetMode: true });
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [toolMode]);

  useEffect(() => {
    const container = viewerContainer();
    if (!container || !screenshotSelection) return;
    const update = () => scheduleScreenshotLayoutUpdate();
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [readerContainerReady, pdfDetectionKey, screenshotSelection?.id]);

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
    const viewer = highlighterRef.current?.viewer;
    if (!viewer || !pdfLoadState.pdfDocument) return;
    const cacheSize = desiredPdfViewerCacheSize({
      pdfSizeBytes,
      pdfDocument: pdfLoadState.pdfDocument,
    });
    applyPdfViewerPageKeepalive();
    evictRenderedPageKeepalive(cacheSize);
    readerPdfDebug("viewer-page-keepalive-cache", {
      cacheSize,
      retained: renderedPageKeepaliveRef.current.size,
      numPages: pdfLoadState.pdfDocument?.numPages || null,
      sizeBytes: pdfSizeBytes || null,
    });
  }, [officialViewerReady, pdfLoadState.pdfDocument, pdfSizeBytes, scaleValue]);

  useEffect(() => {
    const pdfDocument = pdfLoadState.pdfDocument;
    const thumbnailKey =
      document.readerDocumentId || document.localDocumentId || document.title;
    if (
      !pdfDocument ||
      !onThumbnailReady ||
      thumbnailDocumentIdRef.current === thumbnailKey ||
      document.thumbnailDataUrl ||
      document.renderType === "pdf-stream" ||
      useRangeLoading
    ) {
      return;
    }
    thumbnailDocumentIdRef.current = thumbnailKey;
    thumbnailFromPdfDocument(pdfDocument)
      .then((thumbnail) => onThumbnailReady(thumbnail))
      .catch(() => null);
  }, [
    document.localDocumentId,
    document.readerDocumentId,
    document.renderType,
    document.thumbnailDataUrl,
    document.title,
    onThumbnailReady,
    pdfLoadState.pdfDocument,
    useRangeLoading,
  ]);

  useEffect(() => {
    return () => {
      window.clearTimeout(flashTimerRef.current);
      window.clearTimeout(restoreTimerRef.current);
      clearSourceHighlightRestoreTimer();
      if (screenshotLayoutFrameRef.current)
        window.cancelAnimationFrame(screenshotLayoutFrameRef.current);
      cancelSelectionCleanup();
      renderedPageKeepaliveRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const jump = (event) => {
      if (readerPdfSourceMatchesDocument(event.detail, document)) {
        setJumpTargetSource(event.detail);
        readerPdfDebug("target-resolved", {
          reason: "jump-source",
          page:
            event.detail?.locator?.page ||
            event.detail?.position?.pageNumber ||
            null,
        });
      }
      scrollToSelectionSource(event.detail);
    };
    window.addEventListener("anythingllm-document-reader-jump", jump);
    return () =>
      window.removeEventListener("anythingllm-document-reader-jump", jump);
  }, [document, highlights]);

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

  function handleScreenshotPointerDown(event) {
    if (toolMode !== "screenshot" || !screenshotModeAvailable) return;
    if (event.button !== 0 || event.pointerType === "touch") return;
    if (event.target?.closest?.("[data-reader-pdf-control='true']")) return;
    const container = containerRef.current;
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();
    container.setPointerCapture?.(event.pointerId);
    clearBrowserSelection();
    const point = clampPointToContainer(event, container);
    const nextState = {
      isDragging: true,
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      selection: selectionFromPoints(point.x, point.y, point.x, point.y, point),
    };
    setScreenshotSelection(null);
    setScreenshotPanelOpen(false);
    setScreenshotOcrStatus(SCREENSHOT_OCR_STATUS.idle);
    setScreenshotDrag(nextState);
  }

  function handleScreenshotPointerMove(event) {
    const current = screenshotDragRef.current;
    if (
      toolMode !== "screenshot" ||
      !current.isDragging ||
      current.pointerId !== event.pointerId
    )
      return;
    const container = containerRef.current;
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();
    const point = clampPointToContainer(event, container);
    setScreenshotDrag({
      ...current,
      currentX: point.x,
      currentY: point.y,
      selection: selectionFromPoints(
        current.startX,
        current.startY,
        point.x,
        point.y,
        point
      ),
    });
  }

  function handleScreenshotPointerUp(event) {
    const current = screenshotDragRef.current;
    if (
      toolMode !== "screenshot" ||
      !current.isDragging ||
      current.pointerId !== event.pointerId
    )
      return;
    const container = containerRef.current;
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();
    container.releasePointerCapture?.(event.pointerId);
    const point = clampPointToContainer(event, container);
    const selection = selectionFromPoints(
      current.startX,
      current.startY,
      point.x,
      point.y,
      point
    );
    setScreenshotDrag(EMPTY_SCREENSHOT_DRAG_STATE);
    setToolMode("mouse");

    if (
      selection.width < MIN_SCREENSHOT_SELECTION_WIDTH ||
      selection.height < MIN_SCREENSHOT_SELECTION_HEIGHT
    ) {
      setScreenshotSelection(null);
      setScreenshotPanelOpen(false);
      return;
    }

    const anchoredSelection = anchorScreenshotSelection(selection);
    if (!anchoredSelection) {
      setScreenshotSelection(null);
      setScreenshotPanelOpen(false);
      return;
    }

    setScreenshotSelection(anchoredSelection);
    setScreenshotPanelOpen(true);
    setScreenshotOcrStatus(SCREENSHOT_OCR_STATUS.idle);
    scheduleScreenshotLayoutUpdate();
  }

  function handleScreenshotPointerCancel(event) {
    const current = screenshotDragRef.current;
    if (!current.isDragging || current.pointerId !== event.pointerId) return;
    containerRef.current?.releasePointerCapture?.(event.pointerId);
    resetScreenshotInteraction({ resetMode: true });
  }

  const handleFastLayerRendered = useCallback(({ page, reason }) => {
    readerPdfDebug("target-fast-layer-readable", {
      page,
      reason,
    });
  }, []);

  if (!url) {
    return (
      <p className="text-sm text-white/50 light:text-slate-500">
        PDF 原始文件不可用，无法预览。
      </p>
    );
  }

  const anchoredScreenshotStyle = screenshotSelectionStyle(
    screenshotSelection,
    screenshotLayoutTick
  );
  const screenshotOcrProcessing =
    screenshotOcrStatus === SCREENSHOT_OCR_STATUS.processing;

  return (
    <div
      ref={setContainerNode}
      className={`relative h-full min-h-0 overflow-hidden rounded-xl border border-white/10 bg-slate-100 light:border-slate-200 ${
        toolMode === "screenshot" ? "cursor-crosshair select-none" : ""
      }`}
      onPointerDownCapture={(event) => {
        markPdfUserInteraction();
        handleScreenshotPointerDown(event);
      }}
      onPointerMoveCapture={handleScreenshotPointerMove}
      onPointerUpCapture={handleScreenshotPointerUp}
      onPointerCancelCapture={handleScreenshotPointerCancel}
      onWheelCapture={markPdfUserInteraction}
      onTouchStartCapture={markPdfUserInteraction}
      onKeyDownCapture={markPdfUserInteraction}
    >
      {isOriginalPdf && sourceUrl && (
        <FastPdfTargetLayer
          document={document}
          pdfDocument={pdfLoadState.pdfDocument}
          pdfSizeBytes={pdfSizeBytes}
          target={initialPdfTarget}
          scale={scale}
          hidden={officialViewerReady || pdfLoadState.status === "error"}
          title={document.title}
          onRendered={handleFastLayerRendered}
        />
      )}
      {pdfLoadState.status === "loading" && (
        <div className="flex h-full items-center justify-center p-4 text-sm text-slate-500">
          {isPdfPreview ? "正在加载版式预览..." : "正在定位阅读区块..."}
        </div>
      )}
      {pdfLoadState.status === "error" && (
        <div className="flex h-full items-center justify-center p-4 text-center text-sm text-red-500">
          PDF 加载失败：{pdfLoadState.error?.message || "未知错误"}
        </div>
      )}
      {pdfLoadState.pdfDocument && (
        <>
          <PdfDocumentLifecycle
            pdfDocument={pdfLoadState.pdfDocument}
            onReady={handlePdfDocumentReady}
          />
          <PdfHighlighter
            ref={highlighterRef}
            pdfDocument={pdfLoadState.pdfDocument}
            pdfScaleValue={scaleValue}
            enableAreaSelection={() => false}
            scrollRef={(scrollTo) => {
              scrollToRef.current = scrollTo;
              if (!officialViewerReady) {
                readerPdfDebug("official-viewer-mounted", {
                  targetPage: initialPdfTarget?.page || null,
                  targetReason: initialPdfTarget?.reason || null,
                });
              }
              const restoreState = ensurePdfProgressRestoreState();
              if (
                restoreState.target &&
                restoredDocumentRef.current !== restoreState.key
              ) {
                restoredDocumentRef.current = restoreState.key;
                window.clearTimeout(restoreTimerRef.current);
                restoreTimerRef.current = window.setTimeout(
                  () => restorePdfProgress(0),
                  PDF_PROGRESS_RESTORE_DELAY_MS
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
              readerPdfDebug("selection-finished", {
                page: position.pageNumber,
                chars: selectedText.length,
                highlightId: highlight.id,
              });
              setHighlights((current) => [
                ...current.filter((item) => item.id !== highlight.id),
                highlight,
              ]);
              setMarkAvailable(false);
              setMarkedHighlightId(highlight.id);
              setSelectionDraft(highlight.selection);
              showSelectionAsHighlight?.();
              window.requestAnimationFrame(() => {
                highlighterRef.current?.renderHighlightLayers?.();
                readerPdfDebug("selection-draft-rendered", {
                  page: position.pageNumber,
                  highlightId: highlight.id,
                });
              });
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
              const badgeStyle = citationBadgeStyle(highlight.position);
              const focusCitationHighlight = () => {
                onFocusTextSource?.(highlight.sourceKey);
                flashHighlight(highlight.id);
                setSelectionDraft(null);
                setMarkAvailable(false);
                clearBrowserSelection();
              };
              return (
                <div
                  key={index}
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (isCitation) {
                      focusCitationHighlight();
                      return;
                    }
                    openSelectionPanelFromHighlight(highlight);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    if (isCitation) {
                      focusCitationHighlight();
                      return;
                    }
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
                  {highlight.sourceKey &&
                    highlight.citationNo &&
                    badgeStyle && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onFocusTextSource?.(highlight.sourceKey);
                        }}
                        style={badgeStyle}
                        className="reader-pdf-highlight-citation-badge absolute z-40 flex h-5 min-w-[20px] items-center justify-center rounded-full border border-white bg-emerald-500 px-1 text-[10px] font-bold leading-none text-white shadow-[0_8px_18px_rgba(16,185,129,0.28)]"
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
        </>
      )}
      {showOcrTools && (
        <div
          data-reader-ocr-toolbar="true"
          data-reader-pdf-control="true"
          className="absolute left-3 top-3 z-40 flex flex-col overflow-hidden rounded-full border border-white/70 bg-white/88 shadow-[0_14px_34px_rgba(15,23,42,0.18)] backdrop-blur-xl light:border-slate-200"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              resetScreenshotInteraction({ resetMode: true });
            }}
            className={`group flex h-10 w-10 items-center justify-center border-none bg-transparent motion-hover ${
              toolMode === "mouse"
                ? "bg-sky-50 text-sky-700"
                : "text-slate-700 hover:bg-slate-50 hover:text-slate-950"
            }`}
            title="普通阅读模式"
            aria-label="普通阅读模式"
            aria-pressed={toolMode === "mouse"}
          >
            <Mouse size={18} />
          </button>
          <div className="mx-auto h-px w-5 bg-slate-200" />
          <button
            type="button"
            disabled={!screenshotModeAvailable}
            onClick={() => {
              if (!screenshotModeAvailable) return;
              setSelectionDraft(null);
              setToolMode("screenshot");
              clearBrowserSelection();
            }}
            className={`group flex h-10 w-10 items-center justify-center border-none bg-transparent motion-hover disabled:cursor-not-allowed disabled:text-slate-300 ${
              toolMode === "screenshot"
                ? "bg-emerald-50 text-emerald-700"
                : "text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
            }`}
            title={screenshotButtonTitle}
            aria-label={screenshotButtonTitle}
            aria-pressed={toolMode === "screenshot"}
          >
            <Crop size={18} />
          </button>
        </div>
      )}
      {screenshotDragState.isDragging && screenshotDragState.selection && (
        <div
          className="pointer-events-none absolute z-40 rounded border border-emerald-400 bg-emerald-300/20 shadow-[0_0_0_9999px_rgba(15,23,42,0.06)]"
          style={{
            left: `${screenshotDragState.selection.x}px`,
            top: `${screenshotDragState.selection.y}px`,
            width: `${screenshotDragState.selection.width}px`,
            height: `${screenshotDragState.selection.height}px`,
          }}
        />
      )}
      {screenshotSelection &&
        !screenshotDragState.isDragging &&
        anchoredScreenshotStyle && (
          <div
            className={`pointer-events-none absolute z-30 rounded border bg-emerald-300/12 ${
              screenshotSelection.sourceKey
                ? "border-sky-500 bg-sky-300/12"
                : "border-emerald-500"
            }`}
            style={anchoredScreenshotStyle}
          >
            {screenshotSelection.citationNo && (
              <span className="absolute -right-2 -top-2 z-40 flex h-5 min-w-[20px] items-center justify-center rounded-full border border-white bg-sky-500 px-1 text-[10px] font-bold leading-none text-white shadow-[0_8px_18px_rgba(14,165,233,0.28)]">
                {screenshotSelection.citationNo}
              </span>
            )}
          </div>
        )}
      {!selectionDraft &&
        screenshotSelection?.marked &&
        !screenshotPanelOpen &&
        !markedHighlight && (
          <button
            type="button"
            data-reader-pdf-control="true"
            onClick={() => {
              scrollToScreenshotSelection();
              setScreenshotPanelOpen(true);
            }}
            className="motion-hover absolute right-3 top-3 z-30 flex h-9 items-center gap-1.5 rounded-full border border-white/70 bg-white/88 px-3 text-xs font-bold text-slate-700 shadow-[0_14px_34px_rgba(15,23,42,0.16)] backdrop-blur-xl hover:-translate-y-0.5 hover:bg-emerald-50 hover:text-emerald-700 light:border-slate-200"
            title="回到截图标记"
            aria-label="回到截图标记"
          >
            <BookmarkSimple size={16} />
            回到标记
          </button>
        )}
      {screenshotSelection && screenshotPanelOpen && (
        <div
          data-reader-pdf-control="true"
          className="absolute right-3 top-3 z-30 flex flex-col overflow-hidden rounded-full border border-white/70 bg-white/85 shadow-[0_14px_34px_rgba(15,23,42,0.18)] backdrop-blur-xl light:border-slate-200"
        >
          <button
            type="button"
            disabled={screenshotOcrProcessing}
            onClick={citeScreenshotSelection}
            className="group flex h-10 w-10 items-center justify-center border-none bg-transparent text-slate-700 motion-hover hover:bg-sky-50 hover:text-sky-600 disabled:cursor-wait disabled:text-sky-500"
            title={
              screenshotOcrProcessing ? "正在识别截图文字" : "加入伴读引用"
            }
            aria-label={
              screenshotOcrProcessing ? "正在识别截图文字" : "加入伴读引用"
            }
          >
            {screenshotOcrProcessing ? (
              <CircleNotch size={18} className="animate-spin" />
            ) : (
              <Check size={18} />
            )}
          </button>
          <div className="mx-auto h-px w-5 bg-slate-200" />
          <button
            type="button"
            disabled={screenshotOcrProcessing}
            onClick={markScreenshotSelection}
            className="group flex h-10 w-10 items-center justify-center border-none bg-transparent text-slate-700 motion-hover hover:bg-amber-50 hover:text-amber-600 disabled:cursor-not-allowed disabled:text-slate-300"
            title="保留标记"
            aria-label="保留标记"
          >
            <BookmarkSimple size={18} />
          </button>
          <div className="mx-auto h-px w-5 bg-slate-200" />
          <button
            type="button"
            disabled={screenshotOcrProcessing}
            onClick={clearScreenshotSelection}
            className="group flex h-10 w-10 items-center justify-center border-none bg-transparent text-slate-700 motion-hover hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:text-slate-300"
            title="取消选区"
            aria-label="取消选区"
          >
            <X size={18} />
          </button>
        </div>
      )}
      {!selectionDraft && markedHighlight && (
        <button
          type="button"
          data-reader-pdf-control="true"
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
      <div
        data-reader-pdf-control="true"
        className="absolute bottom-3 right-3 z-30 flex items-center gap-2 rounded-full border border-white/70 bg-white/88 px-3 py-2 text-slate-700 shadow-[0_14px_34px_rgba(15,23,42,0.16)] backdrop-blur-xl light:border-slate-200"
      >
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
        <div
          data-reader-pdf-control="true"
          className="absolute right-3 top-3 z-30 flex flex-col overflow-hidden rounded-full border border-white/70 bg-white/85 shadow-[0_14px_34px_rgba(15,23,42,0.18)] backdrop-blur-xl light:border-slate-200"
        >
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
});

export default PdfReader;
