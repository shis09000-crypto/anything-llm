import {
  BookmarkSimple,
  CaretLeft,
  CaretRight,
  Check,
  ListBullets,
  MagnifyingGlass,
  Minus,
  Plus,
  TextAa,
  X,
} from "@phosphor-icons/react";
import ePub from "epubjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { readerTextSourceKey, textHash } from "./storage";
import { thumbnailFromEpubBook } from "./thumbnails";

function clampFontSize(value) {
  return Math.max(80, Math.min(180, Number(value) || 100));
}

const PAGE_TURN_COOLDOWN_MS = 320;
const PAGE_TURN_ANIMATION_MS = 260;
const PAGE_TURN_SETTLE_TIMEOUT_MS = 1200;
const HORIZONTAL_WHEEL_THRESHOLD = 48;
const HORIZONTAL_WHEEL_DOMINANCE = 1.35;
const WHEEL_GESTURE_RESET_MS = 250;
const PREVIEW_WAIT_MS = 150;
const PREVIEW_REBUILD_DEBOUNCE_MS = 260;
const PREVIEW_SETTLE_TIMEOUT_MS = 2200;
const TOOL_REVEAL_DELAY_MS = 80;
const WHEEL_LISTENER_OPTIONS = { capture: true, passive: false };
const PREVIEW_PRIORITY_OFFSETS = [1, -1];
const PREVIEW_BACKGROUND_OFFSETS = [2, -2, 3, -3, 0];
const PREVIEW_OFFSETS = [
  ...PREVIEW_PRIORITY_OFFSETS,
  ...PREVIEW_BACKGROUND_OFFSETS,
];
const PREVIEW_OFFSET_SET = new Set(PREVIEW_OFFSETS);
const EPUB_PREFERENCES_STORAGE_KEY =
  "anythingllm_document_reader_epub_preferences:v1";
const EPUB_READER_FONT_FAMILY = '"Songti SC", "Noto Serif SC", "SimSun", serif';

const EPUB_READER_THEMES = {
  paper: {
    label: "平静",
    shellClassName: "bg-[#ead7b8] text-[#2f2417]",
    toolbarClassName: "bg-[#ead7b8]/92 text-[#2f2417]",
    surfaceClassName: "bg-[#ead7b8]",
    pageClassName: "bg-[#ead7b8]",
    popoverClassName: "border-[#d2b88f]/70 bg-[#ead7b8]/95 text-[#2f2417]",
    tocHeaderClassName: "bg-[#dec69e]/90 text-[#2f2417]",
    tocItemClassName: "bg-transparent text-[#2f2417] hover:bg-[#f8edd8]/70",
    tocDividerClassName: "border-[#8d724c]/20",
    turnButtonStateClassName:
      "focus-visible:bg-[#f8edd8]/50 active:bg-[#f8edd8]/50",
    controlClassName: "bg-[#f8edd8]/[0.72] text-[#2f2417] hover:bg-[#fff5e4]",
    mutedControlClassName: "bg-[#f8edd8]/[0.62] text-[#2f2417]/[0.55]",
    segmentedClassName: "bg-[#dec69e]",
    activeClassName: "border-[#6e5531] bg-[#fff5e4] text-[#2f2417]",
    inactiveClassName: "border-transparent bg-[#f8edd8] text-[#2f2417]",
    dividerClassName: "bg-[#8d724c]/25",
    sliderAccent: "#3b82f6",
    loadingClassName: "bg-[#ead7b8]/70 text-[#5f4a2e]",
    shadowStyle: "none",
    popoverShadowStyle: "0 24px 70px rgba(67,48,24,0.24)",
    sourceShadowStyle: "0 8px 18px rgba(16,185,129,0.28)",
    slideShadowColor: "rgba(66,43,15,0.18)",
    styles: {
      html: {
        background: "#ead7b8",
        "overscroll-behavior-x": "contain",
      },
      body: {
        color: "#2f2417",
        background: "#ead7b8",
        "box-sizing": "border-box",
        "font-family": EPUB_READER_FONT_FAMILY,
        "line-height": "1.78",
        margin: "0 auto",
        "max-width": "780px",
        padding: "clamp(60px, 9vh, 92px) clamp(52px, 9vw, 128px)",
      },
      p: {
        "text-align": "justify",
      },
      a: {
        color: "#9a6a24",
      },
      "::selection": {
        background: "rgba(146, 104, 41, 0.25)",
      },
    },
  },
  light: {
    label: "原始",
    shellClassName: "bg-[#f7f2e8] text-slate-900",
    toolbarClassName: "bg-[#f7f2e8]/92 text-slate-900",
    surfaceClassName: "bg-[#f7f2e8]",
    pageClassName: "bg-[#f7f2e8]",
    popoverClassName: "border-[#ddd5c7]/70 bg-[#f7f2e8]/95 text-slate-900",
    tocHeaderClassName: "bg-[#ebe4d6]/90 text-slate-900",
    tocItemClassName: "bg-transparent text-slate-900 hover:bg-white/70",
    tocDividerClassName: "border-slate-400/20",
    turnButtonStateClassName: "focus-visible:bg-white/55 active:bg-white/55",
    controlClassName: "bg-white/[0.78] text-slate-800 hover:bg-white",
    mutedControlClassName: "bg-white/[0.65] text-slate-500",
    segmentedClassName: "bg-[#ebe4d6]",
    activeClassName: "border-slate-700 bg-white text-slate-900",
    inactiveClassName: "border-transparent bg-[#fffdf7] text-slate-800",
    dividerClassName: "bg-slate-400/25",
    sliderAccent: "#3b82f6",
    loadingClassName: "bg-[#f7f2e8]/[0.72] text-slate-600",
    shadowStyle: "none",
    popoverShadowStyle: "0 24px 70px rgba(15,23,42,0.16)",
    sourceShadowStyle: "0 8px 18px rgba(16,185,129,0.28)",
    slideShadowColor: "rgba(15,23,42,0.16)",
    styles: {
      html: {
        background: "#f7f2e8",
        "overscroll-behavior-x": "contain",
      },
      body: {
        color: "#111827",
        background: "#f7f2e8",
        "box-sizing": "border-box",
        "font-family": EPUB_READER_FONT_FAMILY,
        "line-height": "1.72",
        margin: "0 auto",
        "max-width": "780px",
        padding: "clamp(60px, 9vh, 92px) clamp(52px, 9vw, 128px)",
      },
      p: {
        "text-align": "justify",
      },
      a: {
        color: "#2563eb",
      },
      "::selection": {
        background: "rgba(59, 130, 246, 0.22)",
      },
    },
  },
  dark: {
    label: "夜间",
    shellClassName: "bg-[#252525] text-[#f2eadf]",
    toolbarClassName: "bg-[#252525]/92 text-[#f2eadf]",
    surfaceClassName: "bg-[#252525]",
    pageClassName: "bg-[#252525]",
    popoverClassName: "border-white/10 bg-[#252525]/95 text-[#f2eadf]",
    tocHeaderClassName: "bg-white/10 text-[#f2eadf]",
    tocItemClassName: "bg-transparent text-[#f2eadf] hover:bg-white/[0.10]",
    tocDividerClassName: "border-white/10",
    turnButtonStateClassName: "focus-visible:bg-white/10 active:bg-white/10",
    controlClassName: "bg-white/10 text-[#f2eadf] hover:bg-white/[0.16]",
    mutedControlClassName: "bg-white/[0.08] text-[#f2eadf]/[0.45]",
    segmentedClassName: "bg-white/10",
    activeClassName: "border-[#f2eadf] bg-[#424242] text-[#f2eadf]",
    inactiveClassName: "border-transparent bg-[#3d3d3d] text-[#f2eadf]",
    dividerClassName: "bg-white/[0.18]",
    sliderAccent: "#93c5fd",
    loadingClassName: "bg-[#252525]/[0.72] text-[#f2eadf]",
    shadowStyle: "none",
    popoverShadowStyle: "0 24px 70px rgba(0,0,0,0.36)",
    sourceShadowStyle: "0 8px 18px rgba(16,185,129,0.28)",
    slideShadowColor: "rgba(0,0,0,0.32)",
    styles: {
      html: {
        background: "#252525",
        "overscroll-behavior-x": "contain",
      },
      body: {
        color: "#f2eadf",
        background: "#252525",
        "box-sizing": "border-box",
        "font-family": EPUB_READER_FONT_FAMILY,
        "line-height": "1.78",
        margin: "0 auto",
        "max-width": "780px",
        padding: "clamp(60px, 9vh, 92px) clamp(52px, 9vw, 128px)",
      },
      p: {
        "text-align": "justify",
      },
      a: {
        color: "#f6c56f",
      },
      "::selection": {
        background: "rgba(250, 204, 21, 0.24)",
      },
    },
  },
};

function themeByName(name) {
  return EPUB_READER_THEMES[name] || EPUB_READER_THEMES.paper;
}

function readEpubPreferences() {
  try {
    if (typeof window === "undefined")
      return { fontSize: 100, readerTheme: "paper" };
    const parsed = JSON.parse(
      window.localStorage.getItem(EPUB_PREFERENCES_STORAGE_KEY) || "{}"
    );
    return {
      fontSize: clampFontSize(parsed.fontSize || 100),
      readerTheme: EPUB_READER_THEMES[parsed.readerTheme]
        ? parsed.readerTheme
        : "paper",
    };
  } catch {
    return { fontSize: 100, readerTheme: "paper" };
  }
}

function writeEpubPreferences(preferences = {}) {
  try {
    if (typeof window === "undefined") return;
    const previous = readEpubPreferences();
    window.localStorage.setItem(
      EPUB_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        ...previous,
        ...preferences,
        fontSize: clampFontSize(preferences.fontSize || previous.fontSize),
      })
    );
  } catch {}
}

function isEpubSourceForDocument(source = {}, document = {}) {
  if (source.documentType !== "epub") return false;
  const sourceDocumentId =
    source.readerDocumentId || source.backupReaderDocumentId || null;
  if (sourceDocumentId) {
    return (
      document.readerDocumentId === sourceDocumentId ||
      document.backupReaderDocumentId === sourceDocumentId
    );
  }
  return (
    source.localDocumentId &&
    source.localDocumentId === document.localDocumentId
  );
}

export default function EpubReader({
  document,
  onCite,
  onThumbnailReady,
  onProgressChange,
  readerTextSources = [],
  onFocusTextSource,
  onRemoveTextSource,
}) {
  const readerShellRef = useRef(null);
  const containerRef = useRef(null);
  const previewHostRef = useRef(null);
  const incomingLayerRef = useRef(null);
  const outgoingLayerRef = useRef(null);
  const contentCleanupsRef = useRef([]);
  const bookRef = useRef(null);
  const renditionRef = useRef(null);
  const epubArrayBufferRef = useRef(null);
  const currentLocationRef = useRef(null);
  const previewCacheRef = useRef(new Map());
  const previewLayoutKeyRef = useRef(null);
  const previewWindowBaseCfiRef = useRef(null);
  const previewBuildTimerRef = useRef(null);
  const previewBuildGenerationRef = useRef(0);
  const previewObjectUrlsRef = useRef(new Set());
  const activeIncomingPreviewEntryRef = useRef(null);
  const previewDebugCountersRef = useRef({
    hit: 0,
    miss: 0,
    fallback: 0,
    buildReady: 0,
    buildFailed: 0,
    staleCleared: 0,
  });
  const epubSourcesRef = useRef([]);
  const annotationKeysRef = useRef(new Map());
  const flashTimerRef = useRef(null);
  const resizeTimerRef = useRef(null);
  const lastResizeRef = useRef({ width: 0, height: 0 });
  const pageTurnAtRef = useRef(0);
  const turnInFlightRef = useRef(false);
  const wheelGestureLockedRef = useRef(false);
  const wheelGestureTimerRef = useRef(null);
  const toolRevealTimersRef = useRef({ left: null, right: null });
  const turnEdgeRevealTimersRef = useRef({ left: null, right: null });
  const pageTurnTimerRef = useRef(null);
  const mainRenderWaitRef = useRef(null);
  const thumbnailDocumentIdRef = useRef(null);
  const tocRef = useRef([]);
  const initialPreferencesRef = useRef(readEpubPreferences());
  const readerThemeRef = useRef(initialPreferencesRef.current.readerTheme);
  const fontSizeRef = useRef(initialPreferencesRef.current.fontSize);
  const [toc, setToc] = useState([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectionDraft, setSelectionDraft] = useState(null);
  const [fontSize, setFontSize] = useState(
    initialPreferencesRef.current.fontSize
  );
  const [readerTheme, setReaderTheme] = useState(
    initialPreferencesRef.current.readerTheme
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bookmarkSavedAt, setBookmarkSavedAt] = useState(null);
  const [flashSourceKey, setFlashSourceKey] = useState(null);
  const [visibleToolCluster, setVisibleToolCluster] = useState(null);
  const [visibleTurnEdge, setVisibleTurnEdge] = useState(null);
  const [turnAnimation, setTurnAnimation] = useState(null);
  const [mainPaintReady, setMainPaintReady] = useState(false);
  const [mainLayerSuppressed, setMainLayerSuppressed] = useState(false);
  const [stablePageSnapshot, setStablePageSnapshot] = useState(null);
  const stablePageSnapshotRef = useRef(null);
  const [error, setError] = useState(null);
  const url = document?.objectUrl;
  const activeTheme = themeByName(readerTheme);

  useEffect(() => {
    readerThemeRef.current = readerTheme;
  }, [readerTheme]);

  useEffect(() => {
    fontSizeRef.current = fontSize;
  }, [fontSize]);

  const epubSources = useMemo(
    () =>
      (readerTextSources || []).filter((source) =>
        isEpubSourceForDocument(source, document)
      ),
    [document, readerTextSources]
  );

  useEffect(() => {
    epubSourcesRef.current = epubSources;
  }, [epubSources]);

  function clearEpubSelection(contents = null) {
    try {
      const selection =
        contents?.window?.getSelection?.() ||
        renditionRef.current?.getContents?.()?.[0]?.window?.getSelection?.();
      selection?.removeAllRanges?.();
    } catch {}
  }

  function setNavigationToc(nextToc = []) {
    tocRef.current = nextToc;
    setToc(nextToc);
  }

  function focusReaderShell() {
    readerShellRef.current?.focus?.({ preventScroll: true });
  }

  function registerReaderThemes(rendition) {
    try {
      for (const [name, theme] of Object.entries(EPUB_READER_THEMES)) {
        rendition.themes?.register?.(name, theme.styles);
      }
    } catch {}
  }

  function applyReaderTheme(
    rendition,
    themeName = readerThemeRef.current,
    size = fontSizeRef.current
  ) {
    try {
      rendition.themes?.select?.(themeName);
      rendition.themes?.fontSize?.(`${clampFontSize(size)}%`);
      rendition.themes?.font?.(EPUB_READER_FONT_FAMILY);
    } catch {}
  }

  function cssDeclarations(styles = {}) {
    return Object.entries(styles)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([property, value]) => `${property}: ${String(value)} !important;`)
      .join("\n");
  }

  function readerThemeStyleText(themeName, size) {
    const theme = themeByName(themeName);
    const htmlStyles = theme.styles?.html || {};
    const bodyStyles = theme.styles?.body || {};
    return `
      html {
        ${cssDeclarations(htmlStyles)}
      }
      body {
        ${cssDeclarations(bodyStyles)}
        font-family: ${EPUB_READER_FONT_FAMILY} !important;
        font-size: ${clampFontSize(size)}% !important;
      }
      body, body * {
        font-family: ${EPUB_READER_FONT_FAMILY} !important;
      }
    `;
  }

  function injectReaderThemeStyle(contentDocument, themeName, size) {
    if (!contentDocument) return;
    try {
      const styleId = "anythingllm-epub-reader-theme";
      let styleElement = contentDocument.getElementById(styleId);
      if (!styleElement) {
        styleElement = contentDocument.createElement("style");
        styleElement.id = styleId;
        (contentDocument.head || contentDocument.documentElement)?.appendChild(
          styleElement
        );
      }
      styleElement.textContent = readerThemeStyleText(themeName, size);
    } catch {}
  }

  function applyReaderThemeToContents(
    contents,
    themeName = readerThemeRef.current,
    size = fontSizeRef.current
  ) {
    if (!contents) return;
    const theme = themeByName(themeName);
    const htmlStyles = theme.styles?.html || {};
    const bodyStyles = theme.styles?.body || {};
    try {
      contents.css?.("font-family", EPUB_READER_FONT_FAMILY, true);
      contents.css?.("font-size", `${clampFontSize(size)}%`, true);
      for (const [property, value] of Object.entries(bodyStyles)) {
        if (value === undefined || value === null) continue;
        contents.css?.(property, String(value), true);
      }
    } catch {}
    try {
      const root = contents.document?.documentElement;
      const body = contents.document?.body;
      for (const [property, value] of Object.entries(htmlStyles)) {
        root?.style?.setProperty(property, String(value), "important");
      }
      for (const [property, value] of Object.entries(bodyStyles)) {
        body?.style?.setProperty(property, String(value), "important");
      }
      body?.style?.setProperty(
        "font-family",
        EPUB_READER_FONT_FAMILY,
        "important"
      );
      body?.style?.setProperty(
        "font-size",
        `${clampFontSize(size)}%`,
        "important"
      );
      injectReaderThemeStyle(contents.document, themeName, size);
    } catch {}
  }

  function applyReaderThemeToVisibleContents(
    rendition = renditionRef.current,
    themeName = readerThemeRef.current,
    size = fontSizeRef.current
  ) {
    try {
      for (const contents of rendition?.getContents?.() || []) {
        applyReaderThemeToContents(contents, themeName, size);
      }
    } catch {}
  }

  function applyReaderThemeToPreviewContainer(
    container,
    themeName = readerThemeRef.current,
    size = fontSizeRef.current
  ) {
    if (!container) return;
    const theme = themeByName(themeName);
    const htmlStyles = theme.styles?.html || {};
    const bodyStyles = theme.styles?.body || {};
    for (const iframe of container.querySelectorAll("iframe")) {
      try {
        const contentDocument = iframe.contentDocument;
        const root = contentDocument?.documentElement;
        const body = contentDocument?.body;
        if (!contentDocument || !root || !body) continue;
        for (const [property, value] of Object.entries(htmlStyles)) {
          root.style.setProperty(property, String(value), "important");
        }
        for (const [property, value] of Object.entries(bodyStyles)) {
          body.style.setProperty(property, String(value), "important");
        }
        body.style.setProperty(
          "font-family",
          EPUB_READER_FONT_FAMILY,
          "important"
        );
        body.style.setProperty(
          "font-size",
          `${clampFontSize(size)}%`,
          "important"
        );
        injectReaderThemeStyle(contentDocument, themeName, size);
      } catch {}
    }
  }

  function wait(milliseconds) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  }

  function waitForAnimationFrame() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  function rectIntersectsViewport(rect, viewportWidth, viewportHeight) {
    return Boolean(
      rect &&
        rect.width > 1 &&
        rect.height > 1 &&
        rect.right > 0 &&
        rect.left < viewportWidth &&
        rect.bottom > 0 &&
        rect.top < viewportHeight
    );
  }

  function contentHasVisiblePaint(contents) {
    try {
      const doc = contents?.document;
      const win = contents?.window || doc?.defaultView;
      const body = doc?.body;
      if (!doc || !win || !body) return false;
      const viewportWidth = Math.max(
        1,
        Math.floor(
          win.innerWidth ||
            doc.documentElement?.clientWidth ||
            body.clientWidth ||
            0
        )
      );
      const viewportHeight = Math.max(
        1,
        Math.floor(
          win.innerHeight ||
            doc.documentElement?.clientHeight ||
            body.clientHeight ||
            0
        )
      );

      const nodeFilter = win.NodeFilter || window.NodeFilter;
      const walker = doc.createTreeWalker(body, nodeFilter?.SHOW_TEXT || 4, {
        acceptNode(node) {
          if (!node.nodeValue?.trim()) return nodeFilter?.FILTER_REJECT || 2;
          const parent = node.parentElement;
          if (!parent) return nodeFilter?.FILTER_REJECT || 2;
          const tagName = parent.tagName?.toLowerCase?.();
          if (["script", "style", "noscript"].includes(tagName))
            return nodeFilter?.FILTER_REJECT || 2;
          const style = win.getComputedStyle?.(parent);
          if (
            style?.display === "none" ||
            style?.visibility === "hidden" ||
            style?.opacity === "0"
          ) {
            return nodeFilter?.FILTER_REJECT || 2;
          }
          return nodeFilter?.FILTER_ACCEPT || 1;
        },
      });

      let checked = 0;
      let node = walker.nextNode();
      while (node && checked < 300) {
        checked += 1;
        const range = doc.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rectIntersectsViewport(rect, viewportWidth, viewportHeight)) {
            range.detach?.();
            return true;
          }
        }
        range.detach?.();
        node = walker.nextNode();
      }
      return false;
    } catch {
      return false;
    }
  }

  function mainRenditionHasVisiblePage(rendition = renditionRef.current) {
    try {
      return (rendition?.getContents?.() || []).some((contents) =>
        contentHasVisiblePaint(contents)
      );
    } catch {
      return false;
    }
  }

  function logPreviewDebug(eventName, details = {}) {
    try {
      if (!import.meta.env?.DEV) return;
      const counters = previewDebugCountersRef.current;
      if (Object.prototype.hasOwnProperty.call(counters, eventName)) {
        counters[eventName] += 1;
      }
      console.debug("[EPUB preview]", eventName, {
        ...details,
        counters: { ...counters },
      });
    } catch {}
  }

  function captureStablePageSnapshot(rendition = renditionRef.current) {
    try {
      const contents = (rendition?.getContents?.() || []).find((item) => {
        const body = item?.document?.body;
        if (!body) return false;
        const visibleText = body.innerText || body.textContent || "";
        return visibleText.trim().length > 0;
      });
      const body = contents?.document?.body;
      if (!body) return null;
      const theme = themeByName(readerThemeRef.current);
      const bodyStyles = theme.styles?.body || {};
      return {
        html: body.innerHTML,
        background: bodyStyles.background || "transparent",
        color: bodyStyles.color || "inherit",
        fontFamily: EPUB_READER_FONT_FAMILY,
        fontSize: `${clampFontSize(fontSizeRef.current)}%`,
        lineHeight: bodyStyles["line-height"] || "1.78",
        margin: bodyStyles.margin || "0 auto",
        maxWidth: bodyStyles["max-width"] || "780px",
        padding:
          bodyStyles.padding ||
          "clamp(60px, 9vh, 92px) clamp(52px, 9vw, 128px)",
      };
    } catch {
      return null;
    }
  }

  function rememberStablePageSnapshot(rendition = renditionRef.current) {
    const snapshot = captureStablePageSnapshot(rendition);
    if (snapshot?.html) {
      stablePageSnapshotRef.current = snapshot;
      setStablePageSnapshot(snapshot);
    }
    return Boolean(snapshot?.html);
  }

  async function waitForMainVisiblePage(timeoutMs = 700) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      applyReaderTheme(
        renditionRef.current,
        readerThemeRef.current,
        fontSizeRef.current
      );
      applyReaderThemeToVisibleContents(
        renditionRef.current,
        readerThemeRef.current,
        fontSizeRef.current
      );
      await waitForAnimationFrame();
      if (mainRenditionHasVisiblePage()) {
        rememberStablePageSnapshot();
        return true;
      }
      await wait(50);
    }
    return false;
  }

  async function advancePastInitialBlankPages(rendition, maxSkips = 3) {
    if (!rendition) return false;
    for (let index = 0; index < maxSkips; index += 1) {
      const renderWait = waitForMainRender();
      try {
        const result = rendition.next?.();
        if (result?.then) await result.catch(() => null);
      } catch {}
      await renderWait;
      applyReaderTheme(rendition, readerThemeRef.current, fontSizeRef.current);
      applyReaderThemeToVisibleContents(
        rendition,
        readerThemeRef.current,
        fontSizeRef.current
      );
      syncAnnotations();
      if (await waitForMainVisiblePage(900)) return true;
    }
    return false;
  }

  function prefersReducedMotion() {
    return Boolean(
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    );
  }

  function clearTurnLayers() {
    const activeEntry = activeIncomingPreviewEntryRef.current;
    if (activeEntry?.container && previewHostRef.current) {
      Object.assign(activeEntry.container.style, {
        position: "absolute",
        left: "0",
        top: "0",
        inset: "auto",
        width: `${activeEntry.width || getPreviewSize().width}px`,
        height: `${activeEntry.height || getPreviewSize().height}px`,
        overflow: "hidden",
        pointerEvents: "none",
        opacity: "1",
        transform: "none",
        filter: "none",
      });
      try {
        previewHostRef.current.appendChild(activeEntry.container);
      } catch {}
    } else if (incomingLayerRef.current) {
      incomingLayerRef.current.innerHTML = "";
    }
    activeIncomingPreviewEntryRef.current = null;
    setTurnAnimation(null);
  }

  function resolveMainRenderWait(eventName = null) {
    const waiter = mainRenderWaitRef.current;
    if (!waiter) return;
    if (eventName === "rendered") waiter.rendered = true;
    if (eventName === "relocated") waiter.relocated = true;
    const finish = () => {
      window.clearTimeout(waiter.timer);
      window.clearTimeout(waiter.softTimer);
      mainRenderWaitRef.current = null;
      waiter.resolve({
        ready: Boolean(waiter.rendered && waiter.relocated),
        rendered: Boolean(waiter.rendered),
        relocated: Boolean(waiter.relocated),
      });
    };
    if (eventName && (!waiter.rendered || !waiter.relocated)) {
      window.clearTimeout(waiter.softTimer);
      waiter.softTimer = window.setTimeout(finish, 90);
      return;
    }
    finish();
  }

  function waitForMainRender() {
    return new Promise((resolve) => {
      window.clearTimeout(mainRenderWaitRef.current?.timer);
      window.clearTimeout(mainRenderWaitRef.current?.softTimer);
      const timer = window.setTimeout(() => {
        if (mainRenderWaitRef.current?.timer === timer) {
          const waiter = mainRenderWaitRef.current;
          window.clearTimeout(waiter?.softTimer);
          mainRenderWaitRef.current = null;
          resolve({
            ready: false,
            rendered: Boolean(waiter?.rendered),
            relocated: Boolean(waiter?.relocated),
            timedOut: true,
          });
        }
      }, PAGE_TURN_SETTLE_TIMEOUT_MS);
      mainRenderWaitRef.current = {
        resolve,
        timer,
        softTimer: null,
        rendered: false,
        relocated: false,
      };
    });
  }

  function directionName(direction) {
    if (direction === "prev" || direction === -1) return "prev";
    return "next";
  }

  function directionOffset(direction) {
    return directionName(direction) === "next" ? 1 : -1;
  }

  async function syncMainRendition(action, options = {}) {
    const {
      allowContentFallback = true,
      hideBefore = true,
      keepHidden = false,
      requireFullRender = false,
    } = options;
    if (hideBefore) {
      setMainLayerSuppressed(true);
      setMainPaintReady(false);
    }
    const renderWait = waitForMainRender();
    try {
      const result = action?.();
      if (result?.then) await result.catch(() => null);
    } catch {}
    const renderState = await renderWait;
    applyReaderTheme(
      renditionRef.current,
      readerThemeRef.current,
      fontSizeRef.current
    );
    applyReaderThemeToVisibleContents(
      renditionRef.current,
      readerThemeRef.current,
      fontSizeRef.current
    );
    syncAnnotations();
    const visibleReady = mainRenditionHasVisiblePage();
    const ready = requireFullRender
      ? Boolean(
          renderState?.ready &&
            (visibleReady || (await waitForMainVisiblePage()))
        )
      : renderState?.ready ||
        renderState?.relocated ||
        renderState?.rendered ||
        (allowContentFallback &&
          (visibleReady || (await waitForMainVisiblePage())));
    if (mainRenditionHasVisiblePage()) rememberStablePageSnapshot();
    if (!keepHidden && ready) {
      setMainLayerSuppressed(false);
      setMainPaintReady(true);
    }
    return ready;
  }

  function documentKey() {
    return (
      document?.readerDocumentId ||
      document?.backupReaderDocumentId ||
      document?.localDocumentId ||
      document?.title ||
      "epub"
    );
  }

  function getPreviewSize() {
    const element = containerRef.current;
    const rect = element?.getBoundingClientRect?.();
    return {
      width: Math.max(
        1,
        Math.floor(rect?.width || lastResizeRef.current.width || 0)
      ),
      height: Math.max(
        1,
        Math.floor(rect?.height || lastResizeRef.current.height || 0)
      ),
    };
  }

  function readerLayoutSignature(themeName = readerThemeRef.current) {
    const theme = themeByName(themeName);
    const body = theme.styles?.body || {};
    return [
      body.padding || "",
      body["line-height"] || "",
      body["max-width"] || "",
      EPUB_READER_FONT_FAMILY,
    ].join("~");
  }

  function currentBaseCfi() {
    return (
      currentLocationRef.current?.start?.cfi ||
      document?.progress?.locator?.cfi ||
      null
    );
  }

  function makeLayoutKey() {
    const size = getPreviewSize();
    if (size.width < 160 || size.height < 160) return null;
    return [
      documentKey(),
      readerThemeRef.current,
      clampFontSize(fontSizeRef.current),
      size.width,
      size.height,
      readerLayoutSignature(),
      "paginated",
      "none",
    ].join("|");
  }

  function previewKey(layoutKey, offset) {
    return `${layoutKey}::${offset}`;
  }

  function isPreparedEntryReady(entry) {
    return Boolean(
      entry &&
        entry.status === "ready" &&
        entry.contentsReady &&
        entry.themeApplied &&
        entry.annotationsReady &&
        entry.visibleReady &&
        entry.location
    );
  }

  function showToolCluster(cluster) {
    window.clearTimeout(toolRevealTimersRef.current[cluster]);
    toolRevealTimersRef.current[cluster] = window.setTimeout(() => {
      setVisibleToolCluster(cluster);
    }, TOOL_REVEAL_DELAY_MS);
  }

  function hideToolCluster(cluster) {
    window.clearTimeout(toolRevealTimersRef.current[cluster]);
    setVisibleToolCluster((current) => (current === cluster ? null : current));
  }

  function showTurnEdge(edge) {
    window.clearTimeout(turnEdgeRevealTimersRef.current[edge]);
    turnEdgeRevealTimersRef.current[edge] = window.setTimeout(() => {
      setVisibleTurnEdge(edge);
    }, TOOL_REVEAL_DELAY_MS);
  }

  function hideTurnEdge(edge) {
    window.clearTimeout(turnEdgeRevealTimersRef.current[edge]);
    setVisibleTurnEdge((current) => (current === edge ? null : current));
  }

  function releaseWheelGestureAfterQuiet() {
    window.clearTimeout(wheelGestureTimerRef.current);
    wheelGestureTimerRef.current = window.setTimeout(() => {
      wheelGestureLockedRef.current = false;
    }, WHEEL_GESTURE_RESET_MS);
  }

  function cleanupPreviewEntry(entry) {
    if (!entry) return;
    if (activeIncomingPreviewEntryRef.current === entry) {
      activeIncomingPreviewEntryRef.current = null;
    }
    if (entry.cleanupRequested && !entry.settled) return;
    if (entry.status === "pending" && entry.promise && !entry.settled) {
      entry.cancelled = true;
      entry.cleanupRequested = true;
      entry.status = "stale";
      return;
    }
    destroyPreviewEntryResources(entry);
  }

  function destroyPreviewEntryResources(entry) {
    if (!entry) return;
    for (const cleanup of entry.cleanups || []) {
      try {
        cleanup();
      } catch {}
    }
    entry.cleanups = [];
    try {
      entry.rendition?.destroy?.();
    } catch {}
    try {
      entry.book?.destroy?.();
    } catch {}
    try {
      entry.container?.remove?.();
    } catch {}
    for (const objectUrl of entry.objectUrls || []) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {}
      previewObjectUrlsRef.current.delete(objectUrl);
    }
    entry.status = "destroyed";
    entry.settled = true;
  }

  function clearPreviewCache(reason = "clear") {
    window.clearTimeout(previewBuildTimerRef.current);
    previewBuildGenerationRef.current += 1;
    const clearedCount = previewCacheRef.current.size;
    for (const entry of previewCacheRef.current.values()) {
      cleanupPreviewEntry(entry);
    }
    previewCacheRef.current.clear();
    previewLayoutKeyRef.current = null;
    previewWindowBaseCfiRef.current = null;
    activeIncomingPreviewEntryRef.current = null;
    if (incomingLayerRef.current) incomingLayerRef.current.innerHTML = "";
    for (const objectUrl of previewObjectUrlsRef.current) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {}
    }
    previewObjectUrlsRef.current.clear();
    if (clearedCount > 0) {
      logPreviewDebug("staleCleared", { reason, count: clearedCount });
    }
  }

  async function trackPreviewObjectUrls(task) {
    // Avoid monkey-patching URL.createObjectURL globally while the main
    // rendition may still be loading resources. epubjs/book cleanup owns the
    // preview blob URLs; this Set is kept for future scoped tracking only.
    return await task();
  }

  function createPreviewContainer(width, height) {
    const container = window.document.createElement("div");
    container.className = "epub-page-preview-cache-entry";
    Object.assign(container.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: `${width}px`,
      height: `${height}px`,
      overflow: "hidden",
      pointerEvents: "none",
      opacity: "1",
    });
    previewHostRef.current?.appendChild(container);
    return container;
  }

  function displayPreviewWithTimeout(rendition, target) {
    return Promise.race([
      rendition.display(target),
      wait(4000).then(() => {
        throw new Error("EPUB preview timed out.");
      }),
    ]);
  }

  async function waitForPreviewRenditionSettle(rendition, action) {
    const isSettled = await new Promise((resolve) => {
      let settled = false;
      let rendered = false;
      let relocated = false;
      let timer = null;
      const cleanup = () => {
        try {
          rendition.off?.("rendered", onRendered);
          rendition.off?.("relocated", onRelocated);
        } catch {}
      };
      const done = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        cleanup();
        resolve(rendered && relocated);
      };
      const maybeDone = () => {
        if (rendered && relocated) done();
      };
      const onRendered = () => {
        rendered = true;
        maybeDone();
      };
      const onRelocated = () => {
        relocated = true;
        maybeDone();
      };
      try {
        rendition.on?.("rendered", onRendered);
        rendition.on?.("relocated", onRelocated);
      } catch {}
      timer = window.setTimeout(done, PREVIEW_SETTLE_TIMEOUT_MS);
      const result = action?.();
      if (result?.then) result.then(() => null).catch(() => null);
    });
    await wait(30);
    return isSettled;
  }

  function createPreviewEntry(offset, layoutKey, baseCfi, generation) {
    const key = previewKey(layoutKey, offset);
    const existing = previewCacheRef.current.get(key);
    if (existing?.baseCfi === baseCfi) return existing;
    if (existing) {
      cleanupPreviewEntry(existing);
      previewCacheRef.current.delete(key);
      logPreviewDebug("staleCleared", {
        reason: "baseCfiChanged",
        offset,
      });
    }

    const { width, height } = getPreviewSize();
    const startedAt = Date.now();
    const entry = {
      offset,
      layoutKey,
      baseCfi,
      status: "pending",
      book: null,
      rendition: null,
      container: null,
      location: null,
      contentsReady: false,
      themeApplied: false,
      annotationsReady: false,
      visibleReady: false,
      promise: null,
      objectUrls: new Set(),
      cleanups: [],
      cancelled: false,
      cleanupRequested: false,
      settled: false,
    };
    previewCacheRef.current.set(key, entry);

    entry.promise = trackPreviewObjectUrls(async () => {
      if (
        generation !== previewBuildGenerationRef.current ||
        entry.cancelled ||
        !epubArrayBufferRef.current ||
        !previewHostRef.current
      ) {
        throw new Error("EPUB preview cancelled.");
      }

      const container = createPreviewContainer(width, height);
      const book = ePub(epubArrayBufferRef.current.slice(0), {
        openAs: "binary",
        replacements: "blobUrl",
      });
      const rendition = book.renderTo(container, {
        width: `${width}px`,
        height: `${height}px`,
        flow: "paginated",
        spread: "none",
        minSpreadWidth: 999999,
        allowScriptedContent: false,
      });
      entry.book = book;
      entry.rendition = rendition;
      entry.container = container;

      registerReaderThemes(rendition);
      applyReaderTheme(rendition, readerThemeRef.current, fontSizeRef.current);
      const handlePreviewRendered = (_section, contents) => {
        applyReaderThemeToContents(
          contents,
          readerThemeRef.current,
          fontSizeRef.current
        );
        entry.contentsReady = true;
        entry.themeApplied = true;
      };
      rendition.on?.("rendered", handlePreviewRendered);
      entry.cleanups.push(() =>
        rendition.off?.("rendered", handlePreviewRendered)
      );
      const initialReady = await waitForPreviewRenditionSettle(rendition, () =>
        displayPreviewWithTimeout(rendition, baseCfi)
      );
      if (!initialReady) {
        throw new Error("EPUB preview did not render before timeout.");
      }
      if (generation !== previewBuildGenerationRef.current) {
        throw new Error("EPUB preview cancelled.");
      }
      if (entry.cancelled) {
        throw new Error("EPUB preview cancelled.");
      }

      const steps = Math.abs(offset);
      for (let index = 0; index < steps; index += 1) {
        const stepReady = await waitForPreviewRenditionSettle(rendition, () =>
          offset > 0 ? rendition.next?.() : rendition.prev?.()
        );
        if (!stepReady) {
          throw new Error("EPUB preview target did not render before timeout.");
        }
        if (generation !== previewBuildGenerationRef.current) {
          throw new Error("EPUB preview cancelled.");
        }
        if (entry.cancelled) {
          throw new Error("EPUB preview cancelled.");
        }
      }
      entry.location = rendition.currentLocation?.() || null;
      entry.width = width;
      entry.height = height;
      applyReaderThemeToVisibleContents(
        rendition,
        readerThemeRef.current,
        fontSizeRef.current
      );
      applyReaderThemeToPreviewContainer(
        container,
        readerThemeRef.current,
        fontSizeRef.current
      );
      applyPreparedAnnotations(rendition);
      entry.contentsReady = true;
      entry.themeApplied = true;
      entry.annotationsReady = true;
      entry.visibleReady = mainRenditionHasVisiblePage(rendition);
      if (!entry.visibleReady) {
        throw new Error("EPUB preview rendered without visible content.");
      }
      if (entry.cancelled) {
        throw new Error("EPUB preview cancelled.");
      }
      entry.status = "ready";
      entry.settled = true;
      logPreviewDebug("buildReady", {
        offset,
        durationMs: Date.now() - startedAt,
      });
      return entry;
    }).catch((error) => {
      const wasCancelled = entry.cancelled || entry.cleanupRequested;
      entry.status = wasCancelled ? "destroyed" : "failed";
      entry.settled = true;
      destroyPreviewEntryResources(entry);
      previewCacheRef.current.delete(key);
      if (!wasCancelled) {
        logPreviewDebug("buildFailed", {
          offset,
          durationMs: Date.now() - startedAt,
          reason: error?.message || "unknown",
        });
      }
      throw error;
    });

    return entry;
  }

  function ensurePreviewLayout(layoutKey, reason = "layout") {
    if (!layoutKey) return false;
    if (previewLayoutKeyRef.current !== layoutKey) {
      clearPreviewCache(reason);
      previewLayoutKeyRef.current = layoutKey;
    }
    return true;
  }

  function shiftPreviewCacheWindow(direction, nextBaseCfi) {
    const layoutKey = previewLayoutKeyRef.current;
    if (!layoutKey || !nextBaseCfi) return;
    const delta = directionName(direction) === "next" ? -1 : 1;
    const nextCache = new Map();
    for (const [key, entry] of previewCacheRef.current.entries()) {
      if (entry.layoutKey !== layoutKey) {
        cleanupPreviewEntry(entry);
        logPreviewDebug("staleCleared", {
          reason: "layoutMismatch",
          key,
        });
        continue;
      }
      const nextOffset = entry.offset + delta;
      if (!PREVIEW_OFFSET_SET.has(nextOffset)) {
        cleanupPreviewEntry(entry);
        logPreviewDebug("staleCleared", {
          reason: "outsideShiftedWindow",
          offset: entry.offset,
          nextOffset,
        });
        continue;
      }
      entry.offset = nextOffset;
      entry.baseCfi = nextBaseCfi;
      const nextKey = previewKey(layoutKey, nextOffset);
      const collision = nextCache.get(nextKey);
      if (collision) cleanupPreviewEntry(collision);
      nextCache.set(nextKey, entry);
    }
    previewCacheRef.current = nextCache;
    previewWindowBaseCfiRef.current = nextBaseCfi;
  }

  function prunePreviewCacheWindow(layoutKey) {
    const activeKeys = new Set(
      PREVIEW_OFFSETS.map((offset) => previewKey(layoutKey, offset))
    );
    for (const [key, entry] of previewCacheRef.current.entries()) {
      if (activeKeys.has(key) && entry.layoutKey === layoutKey) continue;
      cleanupPreviewEntry(entry);
      previewCacheRef.current.delete(key);
      logPreviewDebug("staleCleared", {
        reason: "outsideWindow",
        offset: entry.offset,
      });
    }
  }

  async function rebuildPreviewCache(options = {}) {
    const baseCfi = options.baseCfi || currentBaseCfi();
    const layoutKey = makeLayoutKey();
    if (!layoutKey || !epubArrayBufferRef.current || !previewHostRef.current)
      return;
    if (!baseCfi) return;
    ensurePreviewLayout(layoutKey, options.reason || "layoutChanged");
    previewWindowBaseCfiRef.current = baseCfi;
    const generation = previewBuildGenerationRef.current;

    prunePreviewCacheWindow(layoutKey);

    const priorityEntries = PREVIEW_PRIORITY_OFFSETS.map((offset) =>
      createPreviewEntry(offset, layoutKey, baseCfi, generation)
    );
    await Promise.all(
      priorityEntries.map((entry) => entry.promise.catch(() => null))
    );

    for (const offset of PREVIEW_BACKGROUND_OFFSETS) {
      if (generation !== previewBuildGenerationRef.current) break;
      createPreviewEntry(offset, layoutKey, baseCfi, generation).promise.catch(
        () => null
      );
    }
  }

  function schedulePreviewRebuild(delay = PREVIEW_REBUILD_DEBOUNCE_MS) {
    window.clearTimeout(previewBuildTimerRef.current);
    previewBuildTimerRef.current = window.setTimeout(() => {
      rebuildPreviewCache();
    }, delay);
  }

  async function getPreviewForTurn(direction) {
    const offset = directionOffset(direction);
    const layoutKey = makeLayoutKey();
    const baseCfi = currentBaseCfi();
    if (
      !layoutKey ||
      !baseCfi ||
      !epubArrayBufferRef.current ||
      !previewHostRef.current
    ) {
      logPreviewDebug("miss", {
        direction: directionName(direction),
        offset,
        reason: "notReadyForPreview",
      });
      return null;
    }
    ensurePreviewLayout(layoutKey, "layoutChangedBeforeTurn");
    const generation = previewBuildGenerationRef.current;
    const key = previewKey(layoutKey, offset);
    const entry =
      previewCacheRef.current.get(key) ||
      createPreviewEntry(offset, layoutKey, baseCfi, generation);
    if (isPreparedEntryReady(entry)) {
      logPreviewDebug("hit", {
        direction: directionName(direction),
        offset,
        state: "ready",
      });
      return entry;
    }
    await Promise.race([
      entry.promise.catch(() => null),
      wait(PREVIEW_WAIT_MS),
    ]);
    if (isPreparedEntryReady(entry)) {
      logPreviewDebug("hit", {
        direction: directionName(direction),
        offset,
        state: "waited",
      });
      return entry;
    }
    logPreviewDebug("miss", {
      direction: directionName(direction),
      offset,
      reason: entry?.status || "timeout",
    });
    return null;
  }

  function attachIncomingPreview(entry) {
    if (
      !isPreparedEntryReady(entry) ||
      !entry?.container ||
      !incomingLayerRef.current
    )
      return false;
    incomingLayerRef.current.innerHTML = "";
    activeIncomingPreviewEntryRef.current = entry;
    applyReaderThemeToPreviewContainer(
      entry.container,
      readerThemeRef.current,
      fontSizeRef.current
    );
    Object.assign(entry.container.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      opacity: "1",
      pointerEvents: "none",
      transform: "none",
      filter: "none",
    });
    incomingLayerRef.current.appendChild(entry.container);
    return true;
  }

  function handleReaderPointerDown() {
    focusReaderShell();
  }

  async function requestPageTurn(direction, mode = "slide-stack") {
    const turnDirection = directionName(direction);
    const rendition = renditionRef.current;
    if (!rendition || turnInFlightRef.current) return;
    const now = Date.now();
    if (now - pageTurnAtRef.current < PAGE_TURN_COOLDOWN_MS) return;
    pageTurnAtRef.current = now;
    turnInFlightRef.current = true;
    const id = `${now}-${turnDirection}-${mode}`;
    let previewEntry = null;
    let mainReady = false;
    let hasPreview = false;
    try {
      previewEntry =
        mode === "slide-stack" ? await getPreviewForTurn(turnDirection) : null;
      if (mainRenditionHasVisiblePage()) rememberStablePageSnapshot();
      hasPreview = attachIncomingPreview(previewEntry);
      if (hasPreview) rememberStablePageSnapshot(previewEntry.rendition);
      if (!hasPreview && incomingLayerRef.current) {
        incomingLayerRef.current.innerHTML = "";
        logPreviewDebug("fallback", {
          direction: turnDirection,
          reason: "previewNotReady",
        });
      }
      const targetCfi = previewEntry?.location?.start?.cfi || null;
      const turnMainPage = () =>
        hasPreview && targetCfi
          ? rendition.display?.(targetCfi)
          : turnDirection === "next"
            ? rendition.next?.()
            : rendition.prev?.();
      const shouldHideMainBeforeSync =
        hasPreview || Boolean(stablePageSnapshotRef.current?.html);
      if (prefersReducedMotion()) {
        mainReady = await syncMainRendition(() => turnMainPage(), {
          allowContentFallback: true,
          hideBefore: shouldHideMainBeforeSync,
          requireFullRender: true,
        });
        return;
      }
      setTurnAnimation({
        id,
        direction: turnDirection,
        mode: hasPreview ? "slide-stack" : "push-fallback",
      });
      await wait(PAGE_TURN_ANIMATION_MS);
      mainReady = await syncMainRendition(() => turnMainPage(), {
        allowContentFallback: true,
        hideBefore: shouldHideMainBeforeSync,
        requireFullRender: true,
      });
    } finally {
      pageTurnTimerRef.current = window.setTimeout(async () => {
        if (!mainReady) {
          mainReady = await waitForMainVisiblePage(900);
          if (mainReady) setMainPaintReady(true);
        }
        if (!mainReady && incomingLayerRef.current?.children?.length) {
          setMainPaintReady(false);
          setTurnAnimation(null);
          turnInFlightRef.current = false;
          schedulePreviewRebuild();
          return;
        }
        if (!mainReady) {
          setMainPaintReady(false);
          setTurnAnimation(null);
          turnInFlightRef.current = false;
          schedulePreviewRebuild();
          return;
        }
        applyReaderTheme(
          renditionRef.current,
          readerThemeRef.current,
          fontSizeRef.current
        );
        applyReaderThemeToVisibleContents(
          renditionRef.current,
          readerThemeRef.current,
          fontSizeRef.current
        );
        await waitForAnimationFrame();
        await waitForAnimationFrame();
        if (!mainRenditionHasVisiblePage()) {
          setMainPaintReady(false);
          setTurnAnimation(null);
          turnInFlightRef.current = false;
          schedulePreviewRebuild();
          return;
        }
        rememberStablePageSnapshot();
        clearTurnLayers();
        shiftPreviewCacheWindow(turnDirection, currentBaseCfi());
        turnInFlightRef.current = false;
        schedulePreviewRebuild(0);
      }, 90);
    }
  }

  function handleReaderWheel(event) {
    const deltaX = Number(event.deltaX || 0);
    const deltaY = Number(event.deltaY || 0);
    if (
      Math.abs(deltaX) < HORIZONTAL_WHEEL_THRESHOLD ||
      Math.abs(deltaX) <= Math.abs(deltaY) * HORIZONTAL_WHEEL_DOMINANCE
    ) {
      return;
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    releaseWheelGestureAfterQuiet();
    if (wheelGestureLockedRef.current) return;
    wheelGestureLockedRef.current = true;
    requestPageTurn(deltaX > 0 ? "next" : "prev", "slide-stack");
  }

  function handleReaderKeyDown(event) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (event.repeat) return;
      requestPageTurn("next", "slide-stack");
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (event.repeat) return;
      requestPageTurn("prev", "slide-stack");
    }
  }

  function removeContentInteractions() {
    for (const cleanup of contentCleanupsRef.current) cleanup();
    contentCleanupsRef.current = [];
  }

  function wireContentInteractions(contents) {
    const contentDocument = contents?.document;
    const contentWindow = contents?.window;
    if (!contentDocument || contentDocument.__anythingllmEpubReaderWired)
      return;
    contentDocument.__anythingllmEpubReaderWired = true;
    try {
      contentDocument.documentElement.style.overscrollBehaviorX = "contain";
      contentDocument.body.style.overscrollBehaviorX = "contain";
    } catch {}
    const onWheel = (event) => handleReaderWheel(event);
    const onKeyDown = (event) => handleReaderKeyDown(event);
    contentDocument.addEventListener("wheel", onWheel, WHEEL_LISTENER_OPTIONS);
    contentWindow?.addEventListener?.("wheel", onWheel, WHEEL_LISTENER_OPTIONS);
    contentDocument.addEventListener("keydown", onKeyDown);
    contentCleanupsRef.current.push(() => {
      contentDocument.removeEventListener(
        "wheel",
        onWheel,
        WHEEL_LISTENER_OPTIONS
      );
      contentWindow?.removeEventListener?.(
        "wheel",
        onWheel,
        WHEEL_LISTENER_OPTIONS
      );
      contentDocument.removeEventListener("keydown", onKeyDown);
      delete contentDocument.__anythingllmEpubReaderWired;
    });
  }

  function displayWithTimeout(rendition, target) {
    return Promise.race([
      rendition.display(target),
      new Promise((_, reject) => {
        window.setTimeout(
          () => reject(new Error("EPUB 阅读器加载超时，请重试。")),
          10000
        );
      }),
    ]);
  }

  function annotationStyle(sourceKey) {
    if (sourceKey === flashSourceKey) {
      return {
        fill: "rgba(253, 224, 71, 0.58)",
        "fill-opacity": "0.58",
        "mix-blend-mode": "multiply",
      };
    }
    return {
      fill: "rgba(250, 204, 21, 0.3)",
      "fill-opacity": "0.3",
      "mix-blend-mode": "multiply",
    };
  }

  function removeAnnotation(source) {
    const cfiRange = source?.locator?.cfiRange;
    if (!cfiRange || !renditionRef.current?.annotations) return;
    try {
      renditionRef.current.annotations.remove(cfiRange, "highlight");
    } catch {}
  }

  function addAnnotation(source) {
    const cfiRange = source?.locator?.cfiRange;
    const sourceKey = source?.sourceKey;
    if (!cfiRange || !sourceKey || !renditionRef.current?.annotations) return;
    try {
      renditionRef.current.annotations.highlight(
        cfiRange,
        { sourceKey },
        () => {
          onFocusTextSource?.(sourceKey);
          jumpToSource(source, { flash: true });
        },
        "reader-epub-highlight",
        annotationStyle(sourceKey)
      );
      annotationKeysRef.current.set(sourceKey, cfiRange);
    } catch {}
  }

  function applyPreparedAnnotations(rendition) {
    if (!rendition?.annotations) return;
    for (const source of epubSourcesRef.current || []) {
      const cfiRange = source?.locator?.cfiRange;
      const sourceKey = source?.sourceKey;
      if (!cfiRange || !sourceKey) continue;
      try {
        rendition.annotations.remove(cfiRange, "highlight");
      } catch {}
      try {
        rendition.annotations.highlight(
          cfiRange,
          { sourceKey },
          null,
          "reader-epub-highlight",
          annotationStyle(sourceKey)
        );
      } catch {}
    }
  }

  function syncAnnotations() {
    const activeKeys = new Set(epubSources.map((source) => source.sourceKey));
    for (const [sourceKey, cfiRange] of annotationKeysRef.current.entries()) {
      if (activeKeys.has(sourceKey)) continue;
      try {
        renditionRef.current?.annotations?.remove(cfiRange, "highlight");
      } catch {}
      annotationKeysRef.current.delete(sourceKey);
    }
    for (const source of epubSources) {
      removeAnnotation(source);
      addAnnotation(source);
    }
  }

  function flashSource(sourceKey) {
    setFlashSourceKey(sourceKey);
    window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      setFlashSourceKey(null);
      flashTimerRef.current = window.setTimeout(() => {
        setFlashSourceKey(sourceKey);
        flashTimerRef.current = window.setTimeout(
          () => setFlashSourceKey(null),
          220
        );
      }, 160);
    }, 220);
  }

  async function jumpToSource(source, options = {}) {
    const target = source?.locator?.cfiRange || source?.locator?.cfi;
    if (!target || !renditionRef.current) return;
    try {
      await syncMainRendition(() => renditionRef.current?.display?.(target));
      rememberStablePageSnapshot();
      if (options.flash) flashSource(source.sourceKey);
    } catch {}
  }

  function reportProgress(location) {
    const start = location?.start || {};
    const percentage =
      typeof start.percentage === "number"
        ? start.percentage
        : typeof location?.percentage === "number"
          ? location.percentage
          : null;
    const displayed = start.displayed || location?.displayed || {};
    const displayedPercent =
      displayed.total > 0 ? displayed.page / displayed.total : null;
    const percent =
      percentage !== null
        ? percentage * 100
        : displayedPercent !== null
          ? displayedPercent * 100
          : Number(document?.progress?.percent || 0);
    onProgressChange?.({
      label: "阅读进度",
      percent,
      locator: {
        type: "epub-cfi",
        cfi: start.cfi || location?.cfi || null,
        href: start.href || location?.href || null,
      },
      scrollRatio: percent / 100,
    });
  }

  useEffect(() => {
    if (!url || !containerRef.current) return;
    let cancelled = false;
    let book = null;
    let rendition = null;
    let handleSelected = null;
    let handleRelocated = null;
    let handleRendered = null;
    setLoading(true);
    setMainPaintReady(false);
    setMainLayerSuppressed(false);
    stablePageSnapshotRef.current = null;
    setStablePageSnapshot(null);
    setError(null);
    removeContentInteractions();

    async function prepareEpub() {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("EPUB 文件读取失败。");
        const arrayBuffer = await response.arrayBuffer();
        if (cancelled) return;
        epubArrayBufferRef.current = arrayBuffer;
        book = ePub(arrayBuffer, {
          openAs: "binary",
          replacements: "blobUrl",
        });
        bookRef.current = book;
        const initialRect = containerRef.current?.getBoundingClientRect?.();
        if (initialRect?.width && initialRect?.height) {
          lastResizeRef.current = {
            width: Math.floor(initialRect.width),
            height: Math.floor(initialRect.height),
          };
        }
        rendition = book.renderTo(containerRef.current, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          spread: "none",
          minSpreadWidth: 999999,
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;

        registerReaderThemes(rendition);
        applyReaderTheme(
          rendition,
          readerThemeRef.current,
          fontSizeRef.current
        );

        handleSelected = (cfiRange, contents) => {
          const selectedText = contents?.window
            ?.getSelection?.()
            ?.toString()
            ?.trim();
          if (!selectedText) return;
          const hash = textHash(selectedText);
          const location = currentLocationRef.current;
          const chapter =
            tocRef.current.find(
              (item) => item.href && item.href === location?.start?.href
            )?.label || "EPUB 选区";
          const payload = {
            source: document.source,
            documentTitle: document.title,
            documentType: "epub",
            readerDocumentId: document.readerDocumentId,
            localDocumentId: document.localDocumentId,
            backupReaderDocumentId: document.backupReaderDocumentId,
            selectedText,
            textHash: hash,
            locator: {
              type: "epub-cfi",
              cfiRange,
              cfi: location?.start?.cfi || null,
              href: location?.start?.href || null,
            },
            locatorLabel: chapter,
          };
          payload.sourceKey = readerTextSourceKey(payload);
          setSelectionDraft({ payload, contents });
        };

        handleRelocated = (location) => {
          currentLocationRef.current = location;
          reportProgress(location);
          resolveMainRenderWait("relocated");
          schedulePreviewRebuild();
        };

        handleRendered = (_section, contents) => {
          const hasPendingMainRender = Boolean(mainRenderWaitRef.current);
          applyReaderTheme(
            rendition,
            readerThemeRef.current,
            fontSizeRef.current
          );
          applyReaderThemeToContents(
            contents,
            readerThemeRef.current,
            fontSizeRef.current
          );
          wireContentInteractions(contents);
          syncAnnotations();
          resolveMainRenderWait("rendered");
          if (mainRenditionHasVisiblePage(rendition)) {
            rememberStablePageSnapshot(rendition);
            if (!hasPendingMainRender) setMainPaintReady(true);
          }
        };

        rendition.on("selected", handleSelected);
        rendition.on("relocated", handleRelocated);
        rendition.on("rendered", handleRendered);

        book.loaded.navigation
          .then((navigation) => {
            if (!cancelled) setNavigationToc(navigation?.toc || []);
          })
          .catch(() => {
            if (!cancelled) setNavigationToc([]);
          });
        book.ready
          .then(() => book.locations?.generate?.(1000))
          .catch(() => null);

        const thumbnailKey =
          document.readerDocumentId ||
          document.backupReaderDocumentId ||
          document.localDocumentId ||
          document.title;
        if (
          onThumbnailReady &&
          thumbnailDocumentIdRef.current !== thumbnailKey &&
          !document.thumbnailDataUrl
        ) {
          thumbnailDocumentIdRef.current = thumbnailKey;
          thumbnailFromEpubBook(book)
            .then((thumbnail) => thumbnail && onThumbnailReady(thumbnail))
            .catch(() => null);
        }

        const target =
          document?.progress?.locator?.cfiRange ||
          document?.progress?.locator?.cfi ||
          undefined;
        setMainPaintReady(false);
        const initialRenderWait = waitForMainRender();
        await displayWithTimeout(rendition, target);
        await initialRenderWait;
        applyReaderTheme(
          rendition,
          readerThemeRef.current,
          fontSizeRef.current
        );
        applyReaderThemeToVisibleContents(
          rendition,
          readerThemeRef.current,
          fontSizeRef.current
        );
        syncAnnotations();
        if (mainRenditionHasVisiblePage(rendition)) {
          rememberStablePageSnapshot(rendition);
        }
        let initialReady = await waitForMainVisiblePage(1400);
        if (!initialReady && !target) {
          initialReady = await advancePastInitialBlankPages(rendition, 3);
        }
        if (initialReady) setMainPaintReady(true);
        if (initialReady) {
          rebuildPreviewCache({ reason: "initialDisplay" });
        }
      } catch (error) {
        if (!cancelled) setError(error?.message || "EPUB 阅读器打开失败。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    prepareEpub();

    return () => {
      cancelled = true;
      window.clearTimeout(flashTimerRef.current);
      try {
        if (rendition && handleSelected)
          rendition.off("selected", handleSelected);
        if (rendition && handleRelocated)
          rendition.off("relocated", handleRelocated);
        if (rendition && handleRendered)
          rendition.off("rendered", handleRendered);
      } catch {}
      removeContentInteractions();
      clearPreviewCache("unmount");
      try {
        rendition?.destroy?.();
      } catch {}
      try {
        book?.destroy?.();
      } catch {}
      renditionRef.current = null;
      bookRef.current = null;
      epubArrayBufferRef.current = null;
      annotationKeysRef.current.clear();
    };
  }, [url, document?.readerDocumentId, document?.localDocumentId]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    const currentCfi =
      currentLocationRef.current?.start?.cfi ||
      document?.progress?.locator?.cfi ||
      null;
    clearPreviewCache("themeChanged");
    applyReaderTheme(rendition, readerTheme, fontSize);
    applyReaderThemeToVisibleContents(rendition, readerTheme, fontSize);
    rememberStablePageSnapshot(rendition);
    if (currentCfi) {
      window.setTimeout(() => {
        syncMainRendition(() => renditionRef.current?.display?.(currentCfi), {
          hideBefore: false,
          requireFullRender: true,
        })
          .then(() => schedulePreviewRebuild())
          .catch(() => schedulePreviewRebuild());
      }, 80);
    } else {
      setMainPaintReady(true);
    }
  }, [readerTheme]);

  useEffect(() => {
    const element = readerShellRef.current;
    if (!element) return;
    const onWheel = (event) => handleReaderWheel(event);
    element.addEventListener("wheel", onWheel, WHEEL_LISTENER_OPTIONS);
    return () =>
      element.removeEventListener("wheel", onWheel, WHEEL_LISTENER_OPTIONS);
  });

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !window.ResizeObserver) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const rendition = renditionRef.current;
      if (!entry || !rendition) return;
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (width < 160 || height < 160) return;
      if (
        Math.abs(width - lastResizeRef.current.width) < 4 &&
        Math.abs(height - lastResizeRef.current.height) < 4
      ) {
        return;
      }
      lastResizeRef.current = { width, height };
      const currentCfi =
        currentLocationRef.current?.start?.cfi ||
        document?.progress?.locator?.cfi ||
        null;
      window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        try {
          renditionRef.current?.resize?.(width, height);
          if (currentCfi) {
            window.setTimeout(() => {
              clearPreviewCache("resize");
              syncMainRendition(
                () => renditionRef.current?.display?.(currentCfi),
                { hideBefore: false, requireFullRender: true }
              )
                .then(() => schedulePreviewRebuild())
                .catch(() => schedulePreviewRebuild());
            }, 90);
          }
        } catch {}
      }, 140);
    });
    observer.observe(element);
    return () => {
      window.clearTimeout(resizeTimerRef.current);
      observer.disconnect();
    };
  }, [url, document?.progress?.locator?.cfi]);

  useEffect(() => {
    syncAnnotations();
  }, [epubSources, flashSourceKey]);

  useEffect(() => {
    for (const entry of previewCacheRef.current.values()) {
      if (!entry.rendition || entry.status === "destroyed") continue;
      applyPreparedAnnotations(entry.rendition);
      entry.annotationsReady = true;
    }
    schedulePreviewRebuild(120);
  }, [epubSources]);

  useEffect(() => {
    const jump = (event) => {
      const source = event.detail || {};
      if (source?.locator?.type !== "epub-cfi") return;
      if (!isEpubSourceForDocument(source, document)) return;
      jumpToSource(source, { flash: true });
      setSelectionDraft({ payload: source, contents: null });
    };
    window.addEventListener("anythingllm-document-reader-jump", jump);
    return () =>
      window.removeEventListener("anythingllm-document-reader-jump", jump);
  }, [document, epubSources]);

  async function changeFontSize(nextSize) {
    const size = clampFontSize(nextSize);
    const currentCfi =
      currentLocationRef.current?.start?.cfi ||
      document?.progress?.locator?.cfi;
    fontSizeRef.current = size;
    setFontSize(size);
    writeEpubPreferences({ fontSize: size });
    try {
      clearPreviewCache("fontSizeChanged");
      applyReaderTheme(renditionRef.current, readerThemeRef.current, size);
      applyReaderThemeToVisibleContents(
        renditionRef.current,
        readerThemeRef.current,
        size
      );
      rememberStablePageSnapshot(renditionRef.current);
      if (currentCfi) {
        window.setTimeout(() => {
          syncMainRendition(() => renditionRef.current?.display?.(currentCfi), {
            hideBefore: false,
            requireFullRender: true,
          })
            .then(() => schedulePreviewRebuild())
            .catch(() => schedulePreviewRebuild());
        }, 80);
      } else {
        setMainPaintReady(true);
      }
    } catch {}
  }

  function changeReaderTheme(themeName) {
    const nextTheme = EPUB_READER_THEMES[themeName] ? themeName : "paper";
    readerThemeRef.current = nextTheme;
    setReaderTheme(nextTheme);
    writeEpubPreferences({ readerTheme: nextTheme });
  }

  async function selectToc(href) {
    if (!href) return;
    setTocOpen(false);
    await syncMainRendition(() => renditionRef.current?.display?.(href), {
      hideBefore: false,
      requireFullRender: true,
    });
    rememberStablePageSnapshot();
    schedulePreviewRebuild(120);
  }

  function saveCurrentBookmark() {
    if (currentLocationRef.current) reportProgress(currentLocationRef.current);
    setBookmarkSavedAt(Date.now());
    window.setTimeout(() => setBookmarkSavedAt(null), 1200);
  }

  function citeDraft() {
    if (!selectionDraft?.payload) return;
    const citedSource = onCite?.(selectionDraft.payload);
    if (citedSource) addAnnotation(citedSource);
    clearEpubSelection(selectionDraft.contents);
    setSelectionDraft(null);
  }

  function cancelDraft() {
    if (selectionDraft?.payload?.sourceKey)
      onRemoveTextSource?.(selectionDraft.payload.sourceKey);
    clearEpubSelection(selectionDraft?.contents);
    setSelectionDraft(null);
  }

  useEffect(() => {
    return () => {
      window.clearTimeout(wheelGestureTimerRef.current);
      window.clearTimeout(pageTurnTimerRef.current);
      window.clearTimeout(toolRevealTimersRef.current.left);
      window.clearTimeout(toolRevealTimersRef.current.right);
      window.clearTimeout(turnEdgeRevealTimersRef.current.left);
      window.clearTimeout(turnEdgeRevealTimersRef.current.right);
    };
  }, []);

  const leftToolsVisible = visibleToolCluster === "left" || tocOpen;
  const rightToolsVisible = visibleToolCluster === "right" || settingsOpen;
  const activeTurn = turnAnimation;
  const activeTurnStyle = { "--epub-slide-distance": "100%" };
  const stableSnapshot = stablePageSnapshot || stablePageSnapshotRef.current;
  const mainLayerVisible =
    !mainLayerSuppressed &&
    (mainPaintReady ||
      (Boolean(activeTurn) &&
        mainRenditionHasVisiblePage(renditionRef.current)));

  return (
    <div
      className={`relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl ${activeTheme.shellClassName}`}
    >
      <div
        className={`relative z-30 flex h-12 shrink-0 items-center justify-between px-4 backdrop-blur-xl ${activeTheme.toolbarClassName}`}
      >
        <div
          className="relative z-10 flex h-full w-32 items-center"
          onMouseEnter={() => showToolCluster("left")}
          onMouseLeave={() => hideToolCluster("left")}
          onFocusCapture={() => setVisibleToolCluster("left")}
          onBlurCapture={() => hideToolCluster("left")}
        >
          <div
            className={`motion-hover flex items-center gap-2 ${
              leftToolsVisible
                ? "translate-y-0 opacity-100"
                : "pointer-events-none -translate-y-1 opacity-0"
            }`}
          >
            <button
              type="button"
              onClick={() => setTocOpen((open) => !open)}
              className={`flex h-8 w-8 items-center justify-center rounded-full transition ${activeTheme.controlClassName}`}
              aria-label="打开目录"
              title="目录"
            >
              <ListBullets size={17} weight="bold" />
            </button>
            <button
              type="button"
              disabled
              className={`flex h-8 w-8 items-center justify-center rounded-full opacity-65 ${activeTheme.mutedControlClassName}`}
              aria-label="搜索"
              title="搜索将在后续版本启用"
            >
              <MagnifyingGlass size={17} weight="bold" />
            </button>
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-28 top-0 flex h-12 items-center justify-center">
          <p className="m-0 max-w-full truncate text-center text-sm font-bold">
            {document?.title || "EPUB 阅读器"}
          </p>
        </div>

        <div
          className="relative z-10 flex h-full w-40 items-center justify-end"
          onMouseEnter={() => showToolCluster("right")}
          onMouseLeave={() => hideToolCluster("right")}
          onFocusCapture={() => setVisibleToolCluster("right")}
          onBlurCapture={() => hideToolCluster("right")}
        >
          <div
            className={`motion-hover flex items-center gap-2 ${
              rightToolsVisible
                ? "translate-y-0 opacity-100"
                : "pointer-events-none -translate-y-1 opacity-0"
            }`}
          >
            <button
              type="button"
              onClick={() => setSettingsOpen((open) => !open)}
              className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-bold transition ${activeTheme.controlClassName}`}
              aria-label="主题与设置"
              title="主题与设置"
            >
              <TextAa size={15} weight="bold" />
              大小
            </button>
            <button
              type="button"
              onClick={saveCurrentBookmark}
              className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
                bookmarkSavedAt
                  ? `border ${activeTheme.activeClassName}`
                  : activeTheme.controlClassName
              }`}
              aria-label="保存当前位置书签"
              title={bookmarkSavedAt ? "已保存当前位置" : "保存当前位置"}
            >
              <BookmarkSimple
                size={18}
                weight={bookmarkSavedAt ? "fill" : "bold"}
              />
            </button>
          </div>
        </div>
      </div>

      {tocOpen && (
        <div
          className={`absolute left-4 top-14 z-40 flex max-h-[min(420px,70%)] w-72 flex-col overflow-hidden rounded-2xl border backdrop-blur-xl ${activeTheme.popoverClassName}`}
          style={{ boxShadow: activeTheme.popoverShadowStyle }}
        >
          <div
            className={`shrink-0 border-b px-4 py-3 text-xs font-bold ${activeTheme.tocHeaderClassName} ${activeTheme.tocDividerClassName}`}
          >
            目录
          </div>
          {toc.length ? (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {toc.map((item, index) => (
                <button
                  key={`${item.href || index}`}
                  type="button"
                  onClick={() => selectToc(item.href)}
                  className={`block w-full truncate px-4 py-2.5 text-left text-sm font-medium transition ${activeTheme.tocItemClassName}`}
                  title={item.label || `章节 ${index + 1}`}
                >
                  {item.label || `章节 ${index + 1}`}
                </button>
              ))}
            </div>
          ) : (
            <div className="px-4 py-5 text-sm font-medium opacity-60">
              无目录
            </div>
          )}
        </div>
      )}

      {settingsOpen && (
        <div
          className={`absolute right-4 top-14 z-40 w-72 rounded-[24px] border p-4 backdrop-blur-2xl ${activeTheme.popoverClassName}`}
          style={{ boxShadow: activeTheme.popoverShadowStyle }}
        >
          <p className="m-0 mb-4 text-center text-xs font-bold opacity-65">
            主题与设置
          </p>
          <div
            className={`mb-4 grid grid-cols-[1fr_auto_1fr] overflow-hidden rounded-full ${activeTheme.segmentedClassName}`}
          >
            <button
              type="button"
              onClick={() => changeFontSize(fontSize - 1)}
              className="h-11 text-sm font-bold transition hover:bg-white/20"
              aria-label="缩小字体"
            >
              小
            </button>
            <div className={`my-2 w-px ${activeTheme.dividerClassName}`} />
            <button
              type="button"
              onClick={() => changeFontSize(fontSize + 1)}
              className="h-11 text-base font-bold transition hover:bg-white/20"
              aria-label="放大字体"
            >
              大
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(EPUB_READER_THEMES).map(([name, theme]) => (
              <button
                key={name}
                type="button"
                onClick={() => changeReaderTheme(name)}
                className={`flex h-20 flex-col items-center justify-center rounded-2xl border text-xl font-bold transition ${
                  name === readerTheme
                    ? activeTheme.activeClassName
                    : theme.inactiveClassName
                }`}
                aria-label={`切换到${theme.label}主题`}
              >
                大小
                <span className="mt-1 text-[11px] font-semibold opacity-65">
                  {theme.label}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => changeFontSize(fontSize - 1)}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition ${activeTheme.controlClassName}`}
              aria-label="缩小字体 1%"
              title="缩小字体 1%"
            >
              <Minus size={14} />
            </button>
            <input
              type="range"
              min="80"
              max="180"
              step="1"
              value={fontSize}
              onChange={(event) => changeFontSize(event.target.value)}
              className="min-w-0 flex-1"
              style={{ accentColor: activeTheme.sliderAccent }}
              aria-label="EPUB 字体大小"
            />
            <button
              type="button"
              onClick={() => changeFontSize(fontSize + 1)}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition ${activeTheme.controlClassName}`}
              aria-label="放大字体 1%"
              title="放大字体 1%"
            >
              <Plus size={14} />
            </button>
            <span className="w-10 text-right text-xs font-bold opacity-65">
              {fontSize}%
            </span>
          </div>
        </div>
      )}

      <div
        ref={readerShellRef}
        tabIndex={0}
        onPointerDown={handleReaderPointerDown}
        onWheel={handleReaderWheel}
        onKeyDown={handleReaderKeyDown}
        className={`relative min-h-0 flex-1 overflow-hidden outline-none ${activeTheme.surfaceClassName}`}
        style={{
          overscrollBehaviorX: "contain",
          touchAction: "pan-y",
        }}
        aria-label="EPUB 阅读区域"
      >
        <div
          className="absolute inset-y-0 left-0 z-20 flex w-24 items-center justify-start pl-3"
          onMouseEnter={() => showTurnEdge("left")}
          onMouseLeave={() => hideTurnEdge("left")}
        >
          <button
            type="button"
            className={`motion-hover flex h-14 w-9 items-center justify-center rounded-full bg-transparent outline-none transition ${
              visibleTurnEdge === "left"
                ? "pointer-events-auto opacity-75 hover:opacity-100"
                : "pointer-events-none opacity-0 focus:pointer-events-auto focus:opacity-100"
            } ${activeTheme.turnButtonStateClassName} focus-visible:shadow-[0_10px_24px_rgba(15,23,42,0.16)] active:shadow-[0_10px_24px_rgba(15,23,42,0.16)]`}
            onClick={() => requestPageTurn("prev", "slide-stack")}
            onFocus={() => setVisibleTurnEdge("left")}
            onBlur={() => hideTurnEdge("left")}
            style={{ transitionDuration: "200ms" }}
            aria-label="上一页"
            title="上一页"
          >
            <CaretLeft size={30} weight="bold" />
          </button>
        </div>
        <div
          className="absolute inset-y-0 right-0 z-20 flex w-24 items-center justify-end pr-3"
          onMouseEnter={() => showTurnEdge("right")}
          onMouseLeave={() => hideTurnEdge("right")}
        >
          <button
            type="button"
            className={`motion-hover flex h-14 w-9 items-center justify-center rounded-full bg-transparent outline-none transition ${
              visibleTurnEdge === "right"
                ? "pointer-events-auto opacity-75 hover:opacity-100"
                : "pointer-events-none opacity-0 focus:pointer-events-auto focus:opacity-100"
            } ${activeTheme.turnButtonStateClassName} focus-visible:shadow-[0_10px_24px_rgba(15,23,42,0.16)] active:shadow-[0_10px_24px_rgba(15,23,42,0.16)]`}
            onClick={() => requestPageTurn("next", "slide-stack")}
            onFocus={() => setVisibleTurnEdge("right")}
            onBlur={() => hideTurnEdge("right")}
            style={{ transitionDuration: "200ms" }}
            aria-label="下一页"
            title="下一页"
          >
            <CaretRight size={30} weight="bold" />
          </button>
        </div>
        <div
          className={`epub-reader-transition-stage absolute inset-0 z-0 overflow-hidden ${activeTheme.pageClassName}`}
          style={{
            boxShadow: activeTheme.shadowStyle,
            overscrollBehaviorX: "contain",
            ...activeTurnStyle,
          }}
        >
          <div
            className={`pointer-events-none absolute inset-0 z-0 overflow-hidden ${activeTheme.pageClassName}`}
            aria-hidden="true"
          >
            {stableSnapshot?.html && (
              <div
                className="h-full w-full overflow-hidden"
                style={{
                  background: stableSnapshot.background,
                  color: stableSnapshot.color,
                }}
              >
                <div
                  className="min-h-full"
                  style={{
                    boxSizing: "border-box",
                    color: stableSnapshot.color,
                    background: stableSnapshot.background,
                    fontFamily: stableSnapshot.fontFamily,
                    fontSize: stableSnapshot.fontSize,
                    lineHeight: stableSnapshot.lineHeight,
                    margin: stableSnapshot.margin,
                    maxWidth: stableSnapshot.maxWidth,
                    padding: stableSnapshot.padding,
                  }}
                  dangerouslySetInnerHTML={{ __html: stableSnapshot.html }}
                />
              </div>
            )}
          </div>
          <div
            ref={incomingLayerRef}
            className={`epub-page-transition-layer epub-page-incoming pointer-events-none absolute inset-0 z-[5] overflow-hidden ${activeTheme.pageClassName}`}
            data-turn-mode={activeTurn?.mode || undefined}
            data-turn-direction={activeTurn?.direction || undefined}
            data-turn-phase={activeTurn?.phase || undefined}
          />
          <div
            ref={outgoingLayerRef}
            className={`epub-page-transition-layer epub-page-outgoing motion-hover relative z-10 h-full w-full ${
              mainLayerVisible ? "opacity-100" : "opacity-0"
            } ${activeTheme.pageClassName}`}
            data-turn-mode={activeTurn?.mode || undefined}
            data-turn-direction={activeTurn?.direction || undefined}
            data-turn-phase={activeTurn?.phase || undefined}
            style={{
              "--epub-slide-shadow": activeTheme.slideShadowColor,
              pointerEvents: mainLayerVisible ? "auto" : "none",
            }}
          >
            <div ref={containerRef} className="h-full w-full" />
          </div>
        </div>
        <div
          ref={previewHostRef}
          className="pointer-events-none absolute inset-0 -z-10 overflow-hidden opacity-0"
          aria-hidden="true"
        />
      </div>
      <style>{`
        .epub-page-transition-layer {
          will-change: transform, filter, opacity;
          transform: translateZ(0);
        }
        .epub-page-transition-layer[data-turn-mode] {
          pointer-events: none;
        }
        .epub-page-incoming[data-turn-mode="slide-stack"],
        .epub-page-outgoing[data-turn-mode="slide-stack"] {
          animation-duration: ${PAGE_TURN_ANIMATION_MS}ms;
          animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
          animation-fill-mode: forwards;
        }
        .epub-page-incoming[data-turn-mode="slide-stack"][data-turn-direction="next"] {
          animation-name: anythingllm-epub-incoming-next;
        }
        .epub-page-incoming[data-turn-mode="slide-stack"][data-turn-direction="prev"] {
          animation-name: anythingllm-epub-incoming-prev;
        }
        .epub-page-outgoing[data-turn-mode="slide-stack"] {
          animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
          animation-fill-mode: forwards;
        }
        .epub-page-outgoing[data-turn-mode="slide-stack"][data-turn-direction="next"] {
          animation-name: anythingllm-epub-outgoing-next;
        }
        .epub-page-outgoing[data-turn-mode="slide-stack"][data-turn-direction="prev"] {
          animation-name: anythingllm-epub-outgoing-prev;
        }
        .epub-page-outgoing[data-turn-mode="slide-stack"]::after {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          opacity: 0;
          animation: anythingllm-epub-edge-shadow ${PAGE_TURN_ANIMATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        .epub-page-outgoing[data-turn-mode="slide-stack"][data-turn-direction="next"]::after {
          background: linear-gradient(90deg, transparent 68%, var(--epub-slide-shadow));
        }
        .epub-page-outgoing[data-turn-mode="slide-stack"][data-turn-direction="prev"]::after {
          background: linear-gradient(270deg, transparent 68%, var(--epub-slide-shadow));
        }
        .epub-page-outgoing[data-turn-mode="push-fallback"][data-turn-direction="next"] {
          animation: anythingllm-epub-fallback-next ${PAGE_TURN_ANIMATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        .epub-page-outgoing[data-turn-mode="push-fallback"][data-turn-direction="prev"] {
          animation: anythingllm-epub-fallback-prev ${PAGE_TURN_ANIMATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        @keyframes anythingllm-epub-incoming-next {
          0% { transform: translateX(var(--epub-slide-distance, 100%)) scale(0.992); filter: brightness(0.94); }
          100% { transform: translateX(0) scale(1); filter: brightness(1); }
        }
        @keyframes anythingllm-epub-incoming-prev {
          0% { transform: translateX(calc(-1 * var(--epub-slide-distance, 100%))) scale(0.992); filter: brightness(0.94); }
          100% { transform: translateX(0) scale(1); filter: brightness(1); }
        }
        @keyframes anythingllm-epub-outgoing-next {
          0% { transform: translateX(0); opacity: 1; }
          100% { transform: translateX(calc(-1 * var(--epub-slide-distance, 100%))); opacity: 1; }
        }
        @keyframes anythingllm-epub-outgoing-prev {
          0% { transform: translateX(0); opacity: 1; }
          100% { transform: translateX(var(--epub-slide-distance, 100%)); opacity: 1; }
        }
        @keyframes anythingllm-epub-edge-shadow {
          0% { opacity: 0; }
          35% { opacity: 1; }
          100% { opacity: 0.82; }
        }
        @keyframes anythingllm-epub-fallback-next {
          0% { transform: translateX(0); opacity: 1; }
          65% { transform: translateX(-24px); opacity: 0.96; }
          100% { transform: translateX(0); opacity: 1; }
        }
        @keyframes anythingllm-epub-fallback-prev {
          0% { transform: translateX(0); opacity: 1; }
          65% { transform: translateX(24px); opacity: 0.96; }
          100% { transform: translateX(0); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .epub-page-transition-layer {
            animation: none !important;
            transition: none !important;
          }
        }
      `}</style>
      {loading && (
        <div
          className={`absolute inset-12 z-20 flex items-center justify-center text-sm font-semibold backdrop-blur-sm ${activeTheme.loadingClassName}`}
        >
          正在准备 EPUB 阅读器...
        </div>
      )}
      {error && (
        <div
          className={`absolute inset-12 z-20 flex items-center justify-center px-6 text-center text-sm font-semibold text-rose-500 ${activeTheme.popoverClassName}`}
        >
          {error}
        </div>
      )}
      <div className="absolute right-5 top-20 z-30 flex flex-col gap-2">
        {epubSources.map((source) => (
          <button
            key={source.sourceKey}
            type="button"
            onClick={() => {
              onFocusTextSource?.(source.sourceKey);
              jumpToSource(source, { flash: true });
            }}
            className={`flex h-6 min-w-[24px] items-center justify-center rounded-full border border-white bg-emerald-500 px-1.5 text-[11px] font-bold text-white shadow-[0_8px_18px_rgba(16,185,129,0.28)] ${
              flashSourceKey === source.sourceKey
                ? "animate-pulse ring-4 ring-yellow-200"
                : ""
            }`}
            style={{ boxShadow: activeTheme.sourceShadowStyle }}
            title={`定位 TXT 引用 ${source.citationNo}`}
            aria-label={`定位 TXT 引用 ${source.citationNo}`}
          >
            {source.citationNo}
          </button>
        ))}
      </div>
      {selectionDraft && (
        <div className="absolute right-5 top-20 z-40 flex flex-col overflow-hidden rounded-full border border-white/70 bg-white/88 shadow-[0_14px_34px_rgba(15,23,42,0.18)] backdrop-blur-xl">
          <button
            type="button"
            onClick={citeDraft}
            className="flex h-10 w-10 items-center justify-center text-slate-700 hover:bg-sky-50 hover:text-sky-600"
            title="加入伴读引用"
            aria-label="加入伴读引用"
          >
            <Check size={18} />
          </button>
          <div className="mx-auto h-px w-5 bg-slate-200" />
          <button
            type="button"
            onClick={() => {
              clearEpubSelection(selectionDraft.contents);
              setSelectionDraft(null);
            }}
            className="flex h-10 w-10 items-center justify-center text-slate-700 hover:bg-amber-50 hover:text-amber-600"
            title="保留标记"
            aria-label="保留标记"
          >
            <BookmarkSimple size={18} />
          </button>
          <div className="mx-auto h-px w-5 bg-slate-200" />
          <button
            type="button"
            onClick={cancelDraft}
            className="flex h-10 w-10 items-center justify-center text-slate-700 hover:bg-rose-50 hover:text-rose-600"
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
