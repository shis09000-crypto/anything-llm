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

const PAGE_TURN_ANIMATION_MS = 260;
const PAGE_TURN_FAST_ANIMATION_MS = 80;
const PAGE_TURN_CATCHUP_LIMIT = 96;
const PAGE_TURN_CATCHUP_THRESHOLD = 4;
const PAGE_TURN_CATCHUP_INPUT_QUIET_MS = 90;
const PAGE_TURN_HANDOFF_STABILITY_MS = 520;
const PAGE_TURN_FONT_READY_TIMEOUT_MS = 700;
const PAGE_TURN_WHEEL_BURST_LIMIT = 3;
const PAGE_TURN_SETTLE_TIMEOUT_MS = 1200;
const EPUB_VISIBLE_TURN_PREVIEW_ENABLED = false;
const EPUB_BACKGROUND_PREVIEW_CACHE_ENABLED = false;
const HORIZONTAL_WHEEL_THRESHOLD = 48;
const HORIZONTAL_WHEEL_DOMINANCE = 1.35;
const WHEEL_GESTURE_RESET_MS = 220;
const PREVIEW_WAIT_MS = 150;
const PREVIEW_REBUILD_DEBOUNCE_MS = 260;
const CHAPTER_PREVIEW_REBUILD_DELAY_MS = 700;
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
const EPUB_READER_FONT_TOKENS = ["songti sc", "noto serif sc", "simsun"];
const EPUB_READER_THEME_STYLE_ID = "anythingllm-epub-reader-theme";
const EPUB_READER_FRAME_GUTTER = "clamp(56px, 7.5vw, 104px)";
const EPUB_READER_PRESENTATION_MODES = {
  NORMALIZED: "normalized",
  AUTHOR: "author",
};
const EPUB_READER_PRESENTATION_MODE = EPUB_READER_PRESENTATION_MODES.NORMALIZED;
const EPUB_DEBUG_EXPENSIVE_PAINT_EVENTS = new Set([
  "visibleTextStyleChange",
  "authorCssInfluence",
  "turnTraceComplete",
  "turnTraceAbandoned",
]);
const EPUB_DEBUG_EXPENSIVE_TURN_EVENTS = new Set([
  "stable-layout",
  "finalize-complete",
  "turn-abandoned",
]);
const PAGE_TURN_WATCHDOG_DELAYS_MS = [90, 320, 900, 1500];
const PAGE_TURN_STABLE_LAYOUT_SAMPLE_LIMIT = 32;
const CHAPTER_CONTENT_VISIBLE_SAMPLE_LIMIT = 3;
const CHAPTER_CONTENT_TEXT_NODE_CHECK_LIMIT = 48;
const STABLE_SNAPSHOT_MAX_HTML_LENGTH = 250_000;
const STABLE_SNAPSHOT_MIRROR_STYLE_PROPERTIES = [
  "box-sizing",
  "display",
  "position",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "overflow",
  "overflow-x",
  "overflow-y",
  "column-count",
  "-webkit-column-count",
  "column-gap",
  "-webkit-column-gap",
  "column-width",
  "-webkit-column-width",
  "column-fill",
  "-webkit-column-fill",
  "writing-mode",
  "direction",
  "text-align",
  "text-indent",
  "transform",
  "transform-origin",
];
const EPUB_READER_BODY_LAYOUT_MANAGED_PROPERTIES = new Set([
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "width",
  "max-width",
  "min-width",
  "column-gap",
  "-webkit-column-gap",
  "column-width",
  "-webkit-column-width",
  "column-fill",
  "-webkit-column-fill",
  "column-axis",
  "-webkit-column-axis",
]);

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
        margin: "0",
        "max-width": "none",
        width: "auto",
        "column-gap": "0px",
        "-webkit-column-gap": "0px",
        padding: "clamp(60px, 9vh, 92px) 0",
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
        margin: "0",
        "max-width": "none",
        width: "auto",
        "column-gap": "0px",
        "-webkit-column-gap": "0px",
        padding: "clamp(60px, 9vh, 92px) 0",
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
        margin: "0",
        "max-width": "none",
        width: "auto",
        "column-gap": "0px",
        "-webkit-column-gap": "0px",
        padding: "clamp(60px, 9vh, 92px) 0",
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
  const turnCoverLayerRef = useRef(null);
  const turnCoverGenerationRef = useRef(0);
  const contentCleanupsRef = useRef([]);
  const bookRef = useRef(null);
  const renditionRef = useRef(null);
  const epubArrayBufferRef = useRef(null);
  const currentLocationRef = useRef(null);
  const previewCacheRef = useRef(new Map());
  const previewLayoutKeyRef = useRef(null);
  const previewWindowBaseCfiRef = useRef(null);
  const previewBuildTimerRef = useRef(null);
  const previewBuildIdleCallbackRef = useRef(null);
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
  const turnInFlightRef = useRef(false);
  const pendingPageTurnDeltaRef = useRef(0);
  const targetTurnDeltaRef = useRef(0);
  const pageTurnDrainActiveRef = useRef(false);
  const fastTurnBurstRef = useRef(false);
  const fastTurnTraceRef = useRef([]);
  const fastTurnInputQuietTimerRef = useRef(null);
  const fastTurnLastInputAtRef = useRef(0);
  const fastTurnCatchupActiveRef = useRef(false);
  const fastTurnProbeInFlightRef = useRef(false);
  const fastTurnProbeRef = useRef(null);
  const wheelTurnDeltaRef = useRef(0);
  const wheelGestureTimerRef = useRef(null);
  const toolRevealTimersRef = useRef({ left: null, right: null });
  const turnEdgeRevealTimersRef = useRef({ left: null, right: null });
  const pageTurnTimerRef = useRef(null);
  const pageTurnWatchdogTimersRef = useRef([]);
  const activePageTurnIdRef = useRef(null);
  const epubPaintTurnSeqRef = useRef(0);
  const epubPaintActiveTurnRef = useRef(null);
  const epubPaintTraceRef = useRef([]);
  const epubChapterTraceRef = useRef([]);
  const epubPaintLoggingRef = useRef(false);
  const postRevealPaintTimersRef = useRef([]);
  const mainRenderWaitRef = useRef(null);
  const chapterJumpSeqRef = useRef(0);
  const chapterJumpInFlightRef = useRef(false);
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
  const mainPaintReadyRef = useRef(false);
  const [stablePageSnapshot, setStablePageSnapshot] = useState(null);
  const stablePageSnapshotRef = useRef(null);
  const [error, setError] = useState(null);
  const url = document?.objectUrl;
  const activeTheme = themeByName(readerTheme);

  useEffect(() => {
    readerThemeRef.current = readerTheme;
  }, [readerTheme]);

  useEffect(() => {
    mainPaintReadyRef.current = mainPaintReady;
  }, [mainPaintReady]);

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

  function registerReaderThemes() {
    // epubjs theme overrides are applied after a view is displayed. Reader
    // styling is injected through the spine hook instead so page turns do not
    // repaint visible content with a second font/layout pass.
  }

  function currentEpubPaintTurn() {
    return (
      epubPaintActiveTurnRef.current || {
        id: activePageTurnIdRef.current,
        sequence: epubPaintTurnSeqRef.current,
      }
    );
  }

  function debugEpubPaint(eventName, details = {}) {
    try {
      if (!import.meta.env?.DEV) return;
      if (epubPaintLoggingRef.current) return;
      epubPaintLoggingRef.current = true;
      const turn = currentEpubPaintTurn();
      const outgoing = outgoingLayerRef.current;
      const incoming = incomingLayerRef.current;
      const captureExpensiveSnapshot =
        details.captureSnapshot ||
        EPUB_DEBUG_EXPENSIVE_PAINT_EVENTS.has(eventName);
      const entry = {
        at: Math.round(performance.now()),
        event: eventName,
        turnId: turn?.id || null,
        sequence: turn?.sequence || null,
        details,
        mainVisible: captureExpensiveSnapshot
          ? mainRenditionHasVisiblePage()
          : null,
        mainPaintReady,
        mainLayerSuppressed,
        incomingChildren: incoming?.children?.length || 0,
        outgoingOpacity: outgoing
          ? window.getComputedStyle(outgoing).opacity
          : null,
        layout: captureExpensiveSnapshot
          ? mainRenditionVisibleLayoutSnapshot()
          : null,
        visibleTextStyle: captureExpensiveSnapshot
          ? mainVisibleTextStyleSnapshot()
          : null,
      };
      epubPaintTraceRef.current = [...epubPaintTraceRef.current, entry].slice(
        -160
      );
      console.debug("[EPUB paint]", eventName, entry);
    } catch {
    } finally {
      epubPaintLoggingRef.current = false;
    }
  }

  function debugEpubChapter(eventName, details = {}) {
    try {
      if (!import.meta.env?.DEV) return;
      const entry = {
        at: Math.round(performance.now()),
        event: eventName,
        details,
        mainPaintReady,
        mainLayerSuppressed,
        turnInFlight: turnInFlightRef.current,
        activeTurnId: activePageTurnIdRef.current,
      };
      epubChapterTraceRef.current = [
        ...epubChapterTraceRef.current,
        entry,
      ].slice(-120);
      console.debug("[EPUB chapter]", eventName, entry);
    } catch {}
  }

  function debugFastTurn(eventName, details = {}) {
    try {
      if (!import.meta.env?.DEV) return;
      const entry = {
        at: Math.round(performance.now()),
        event: eventName,
        details,
        pendingDelta: pendingPageTurnDeltaRef.current,
        targetDelta: targetTurnDeltaRef.current,
        catchupActive: fastTurnCatchupActiveRef.current,
        probeInFlight: fastTurnProbeInFlightRef.current,
        drainActive: pageTurnDrainActiveRef.current,
        turnInFlight: turnInFlightRef.current,
        activeTurnId: activePageTurnIdRef.current,
      };
      fastTurnTraceRef.current = [...fastTurnTraceRef.current, entry].slice(
        -200
      );
      console.debug("[EPUB fast turn]", eventName, entry);
    } catch {}
  }

  function startEpubPaintTrace({ id, direction, mode }) {
    epubPaintActiveTurnRef.current = {
      id,
      direction,
      mode,
      sequence: epubPaintTurnSeqRef.current + 1,
    };
    epubPaintTurnSeqRef.current += 1;
    epubPaintTraceRef.current = [];
    debugEpubPaint("turnTraceStart", { id, direction, mode });
  }

  function normalizeRenditionContents(contentsOrView) {
    return contentsOrView?.contents || contentsOrView || null;
  }

  function readerThemeSignature(themeName, size) {
    return [
      themeName,
      clampFontSize(size),
      EPUB_READER_FONT_FAMILY,
      EPUB_READER_FRAME_GUTTER,
      EPUB_READER_PRESENTATION_MODE,
    ].join("|");
  }

  function fontFamilyHasReaderFont(fontFamily = "") {
    const normalized = String(fontFamily).toLowerCase();
    return EPUB_READER_FONT_TOKENS.some((fontName) =>
      normalized.includes(fontName)
    );
  }

  function readerBodyContentStyles(themeName) {
    const theme = themeByName(themeName);
    const bodyStyles = theme.styles?.body || {};
    return Object.fromEntries(
      Object.entries(bodyStyles).filter(([property]) => {
        const normalized = property.toLowerCase();
        return (
          !EPUB_READER_BODY_LAYOUT_MANAGED_PROPERTIES.has(normalized) &&
          !["font-family", "font-size", "color", "background"].includes(
            normalized
          )
        );
      })
    );
  }

  function readerHtmlContentStyles(themeName) {
    const theme = themeByName(themeName);
    const htmlStyles = theme.styles?.html || {};
    return Object.fromEntries(
      Object.entries(htmlStyles).filter(([property]) => {
        const normalized = property.toLowerCase();
        return !["color", "background"].includes(normalized);
      })
    );
  }

  function readerThemeVariableMap(themeName, size) {
    const theme = themeByName(themeName);
    const bodyStyles = theme.styles?.body || {};
    const linkStyles = theme.styles?.a || {};
    const lineHeight = bodyStyles["line-height"] || "1.78";
    return {
      "--anythingllm-epub-font-family": EPUB_READER_FONT_FAMILY,
      "--anythingllm-epub-font-size": `${clampFontSize(size)}%`,
      "--anythingllm-epub-color": bodyStyles.color || "inherit",
      "--anythingllm-epub-background": bodyStyles.background || "transparent",
      "--anythingllm-epub-link-color":
        linkStyles.color || bodyStyles.color || "inherit",
      "--anythingllm-epub-line-height": lineHeight,
      "--anythingllm-epub-paragraph-gap": "0.72em",
      "--anythingllm-epub-paragraph-indent": "0",
      "--anythingllm-epub-list-indent": "1.45em",
      "--anythingllm-epub-heading-gap-before": "1.15em",
      "--anythingllm-epub-heading-gap-after": "0.62em",
      "--anythingllm-epub-block-gap": "0.9em",
      "--anythingllm-epub-table-border-color": "currentColor",
    };
  }

  function readerFrameVariableValue(property, fallback = "") {
    try {
      const stage = containerRef.current?.closest?.(
        ".epub-reader-transition-stage"
      );
      const value = stage
        ? window.getComputedStyle(stage).getPropertyValue(property).trim()
        : "";
      return value || fallback;
    } catch {
      return fallback;
    }
  }

  function applyReaderThemeVariables(contentDocument, themeName, size) {
    let wroteVariables = false;
    const root = contentDocument?.documentElement;
    const variables = readerThemeVariableMap(themeName, size);
    for (const [property, value] of Object.entries(variables)) {
      wroteVariables =
        setStylePropertyIfChanged(
          root,
          property,
          readerFrameVariableValue(property, value)
        ) || wroteVariables;
    }
    return wroteVariables;
  }

  function readerSnapshotStyleText(scopeSelector) {
    return `
      ${scopeSelector},
      ${scopeSelector} *:not(#${EPUB_READER_THEME_STYLE_ID}) {
        font-family: var(--anythingllm-epub-font-family) !important;
        color: var(--anythingllm-epub-color) !important;
      }
      ${scopeSelector} {
        line-height: var(--anythingllm-epub-line-height) !important;
        text-rendering: optimizeLegibility !important;
        -webkit-font-smoothing: antialiased !important;
      }
      ${scopeSelector} p,
      ${scopeSelector} li,
      ${scopeSelector} dd,
      ${scopeSelector} dt {
        margin-block: var(--anythingllm-epub-paragraph-gap) !important;
        line-height: var(--anythingllm-epub-line-height) !important;
      }
      ${scopeSelector} p {
        text-indent: var(--anythingllm-epub-paragraph-indent) !important;
        text-align: justify !important;
      }
      ${scopeSelector} ul,
      ${scopeSelector} ol {
        margin-block: var(--anythingllm-epub-block-gap) !important;
        padding-inline-start: var(--anythingllm-epub-list-indent) !important;
      }
      ${scopeSelector} h1,
      ${scopeSelector} h2,
      ${scopeSelector} h3,
      ${scopeSelector} h4,
      ${scopeSelector} h5,
      ${scopeSelector} h6 {
        margin-block-start: var(--anythingllm-epub-heading-gap-before) !important;
        margin-block-end: var(--anythingllm-epub-heading-gap-after) !important;
        line-height: 1.35 !important;
        page-break-after: avoid !important;
        break-after: avoid !important;
      }
      ${scopeSelector} h1 { font-size: 1.55em !important; font-weight: 650 !important; }
      ${scopeSelector} h2 { font-size: 1.35em !important; font-weight: 650 !important; }
      ${scopeSelector} h3 { font-size: 1.18em !important; font-weight: 620 !important; }
      ${scopeSelector} h4,
      ${scopeSelector} h5,
      ${scopeSelector} h6 { font-size: 1.06em !important; font-weight: 620 !important; }
      ${scopeSelector} blockquote {
        margin-block: var(--anythingllm-epub-block-gap) !important;
        margin-inline: var(--anythingllm-epub-list-indent) !important;
        padding-inline-start: 0.9em !important;
        border-inline-start: 0.18em solid var(--anythingllm-epub-table-border-color) !important;
      }
      ${scopeSelector} img,
      ${scopeSelector} svg,
      ${scopeSelector} video,
      ${scopeSelector} canvas {
        max-width: 100% !important;
        height: auto !important;
        object-fit: contain !important;
      }
      ${scopeSelector} table {
        max-width: 100% !important;
        border-collapse: collapse !important;
        table-layout: auto !important;
      }
      ${scopeSelector} th,
      ${scopeSelector} td {
        border-color: var(--anythingllm-epub-table-border-color) !important;
        vertical-align: top !important;
      }
      ${scopeSelector} pre,
      ${scopeSelector} code,
      ${scopeSelector} kbd,
      ${scopeSelector} samp {
        white-space: pre-wrap !important;
        word-break: break-word !important;
      }
      ${scopeSelector} a {
        color: var(--anythingllm-epub-link-color) !important;
      }
    `;
  }

  function markReaderThemeReady(contentDocument, themeName, size) {
    try {
      const root = contentDocument?.documentElement;
      if (!root) return;
      root.dataset.anythingllmEpubThemeReady = "true";
      root.dataset.anythingllmEpubThemeSignature = readerThemeSignature(
        themeName,
        size
      );
    } catch {}
  }

  function readerThemeHead(contentDocument) {
    return (
      contentDocument?.head ||
      contentDocument?.querySelector?.("head") ||
      contentDocument?.documentElement ||
      null
    );
  }

  function setStylePropertyIfChanged(element, property, value) {
    try {
      if (!element || value === undefined || value === null) return false;
      const nextValue = String(value);
      if (element.style?.getPropertyValue(property) === nextValue) {
        return false;
      }
      element.style?.setProperty(property, nextValue, "important");
      return true;
    } catch {
      return false;
    }
  }

  function ensureReaderThemeStyle(
    contentDocument,
    themeName,
    size,
    details = {}
  ) {
    if (!contentDocument) return false;
    try {
      const signature = readerThemeSignature(themeName, size);
      const styleText = readerThemeStyleText(themeName);
      const head = readerThemeHead(contentDocument);
      let styleElement = contentDocument.getElementById(
        EPUB_READER_THEME_STYLE_ID
      );
      let wroteStyle = false;
      if (!styleElement) {
        styleElement = contentDocument.createElement("style");
        styleElement.id = EPUB_READER_THEME_STYLE_ID;
        styleElement.setAttribute("id", EPUB_READER_THEME_STYLE_ID);
        styleElement.setAttribute("data-anythingllm-epub-theme-signature", "");
        head?.appendChild(styleElement);
        wroteStyle = true;
      }
      if (styleElement.textContent !== styleText) {
        styleElement.textContent = styleText;
        wroteStyle = true;
      }
      const previousStyleSignature = styleElement.getAttribute(
        "data-anythingllm-epub-theme-signature"
      );
      const wroteStyleSignature = previousStyleSignature !== signature;
      if (wroteStyleSignature) {
        styleElement.setAttribute(
          "data-anythingllm-epub-theme-signature",
          signature
        );
      }

      const root = contentDocument.documentElement;
      const htmlStyles = readerHtmlContentStyles(themeName);
      const bodyStyles = readerBodyContentStyles(themeName);
      let wroteInline = applyReaderThemeVariables(
        contentDocument,
        themeName,
        size
      );
      for (const [property, value] of Object.entries(htmlStyles)) {
        wroteInline =
          setStylePropertyIfChanged(root, property, value) || wroteInline;
      }
      for (const [property, value] of Object.entries(bodyStyles)) {
        wroteInline =
          setStylePropertyIfChanged(contentDocument.body, property, value) ||
          wroteInline;
      }

      const previousReady = root?.dataset?.anythingllmEpubThemeReady === "true";
      const previousSignature =
        root?.dataset?.anythingllmEpubThemeSignature || null;
      markReaderThemeReady(contentDocument, themeName, size);
      const wroteReadyMarker =
        !previousReady || previousSignature !== signature;

      if (wroteStyle || wroteInline || wroteReadyMarker) {
        debugEpubPaint("themeStyleWrite", {
          ...details,
          wroteStyle,
          wroteStyleSignature,
          wroteInline,
          wroteReadyMarker,
          signature,
        });
      } else {
        debugEpubPaint("themeStyleSkip", {
          ...details,
          signature,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  function contentHasReaderTheme(
    contentsOrView,
    themeName = readerThemeRef.current,
    size = fontSizeRef.current,
    options = {}
  ) {
    try {
      const { inspectVisibleText = false } = options;
      const contents = normalizeRenditionContents(contentsOrView);
      const doc = contents?.document;
      const root = doc?.documentElement;
      const body = doc?.body;
      const win = contents?.window || doc?.defaultView;
      const styleElement = doc?.getElementById(EPUB_READER_THEME_STYLE_ID);
      if (
        !doc ||
        !root ||
        !body ||
        !styleElement?.textContent ||
        root.dataset.anythingllmEpubThemeReady !== "true" ||
        root.dataset.anythingllmEpubThemeSignature !==
          readerThemeSignature(themeName, size)
      ) {
        return false;
      }
      const bodyFontFamily =
        win?.getComputedStyle?.(body)?.fontFamily ||
        body.style?.fontFamily ||
        "";
      const bodyHasReaderFont = fontFamilyHasReaderFont(bodyFontFamily);
      if (!inspectVisibleText) return bodyHasReaderFont;
      const textStyleSnapshot = contentVisibleTextStyleSnapshot(contents);
      if (
        bodyHasReaderFont &&
        textStyleSnapshot?.samples?.length &&
        !textStyleSnapshot.hasReaderFont
      ) {
        debugFontConflict({
          bodyFontFamily,
          visibleTextStyle: textStyleSnapshot,
        });
      }
      if (
        textStyleSnapshot?.samples?.length &&
        (!textStyleSnapshot.hasReaderColor ||
          !textStyleSnapshot.hasReaderLineHeight)
      ) {
        debugEpubPaint("authorCssInfluence", {
          visibleTextStyle: textStyleSnapshot,
        });
      }
      return textStyleSnapshot?.samples?.length
        ? Boolean(textStyleSnapshot.hasReaderFont)
        : bodyHasReaderFont;
    } catch {
      return false;
    }
  }

  function registerReaderContentThemeHook(rendition) {
    if (!rendition?.hooks?.content?.register) return null;
    const applyThemeBeforeRender = (contentsOrView) => {
      const contents = normalizeRenditionContents(contentsOrView);
      ensureReaderThemeStyle(
        contents?.document,
        readerThemeRef.current,
        fontSizeRef.current,
        { source: "renditionContentHook" }
      );
    };
    try {
      rendition.hooks.content.register(applyThemeBeforeRender);
      return () => {
        try {
          rendition.hooks.content.deregister?.(applyThemeBeforeRender);
        } catch {}
      };
    } catch {
      return null;
    }
  }

  function registerReaderBookThemeHook(book) {
    if (!book?.spine?.hooks?.content?.register) return null;
    const applyThemeToSectionDocument = (contentDocument) => {
      ensureReaderThemeStyle(
        contentDocument,
        readerThemeRef.current,
        fontSizeRef.current,
        { source: "bookSpineHook" }
      );
    };
    try {
      book.spine.hooks.content.register(applyThemeToSectionDocument);
      return () => {
        try {
          book.spine.hooks.content.deregister?.(applyThemeToSectionDocument);
        } catch {}
      };
    } catch {
      return null;
    }
  }

  function applyReaderTheme(
    rendition,
    themeName = readerThemeRef.current,
    size = fontSizeRef.current
  ) {
    applyReaderThemeToVisibleContents(rendition, themeName, size, {
      source: "applyReaderTheme",
    });
  }

  function cssDeclarations(styles = {}) {
    return Object.entries(styles)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([property, value]) => `${property}: ${String(value)} !important;`)
      .join("\n");
  }

  function readerThemeStyleText(themeName) {
    const htmlStyles = readerHtmlContentStyles(themeName);
    const bodyStyles = readerBodyContentStyles(themeName);
    const baseReaderCss = `
      html {
        ${cssDeclarations(htmlStyles)}
        background: var(--anythingllm-epub-background) !important;
        color: var(--anythingllm-epub-color) !important;
      }
      body {
        ${cssDeclarations(bodyStyles)}
        color: var(--anythingllm-epub-color) !important;
        background: var(--anythingllm-epub-background) !important;
        font-family: var(--anythingllm-epub-font-family) !important;
        font-size: var(--anythingllm-epub-font-size) !important;
        line-height: var(--anythingllm-epub-line-height) !important;
      }
      html body,
      html body :where(
        p, li, dd, dt, blockquote, h1, h2, h3, h4, h5, h6,
        span, a, strong, em, b, i, u, small, sup, sub,
        div, section, article, aside, figcaption,
        table, thead, tbody, tfoot, tr, th, td,
        pre, code, kbd, samp
      ) {
        color: var(--anythingllm-epub-color) !important;
        font-family: var(--anythingllm-epub-font-family) !important;
      }
      html body a {
        color: var(--anythingllm-epub-link-color) !important;
      }
    `;
    if (EPUB_READER_PRESENTATION_MODE === EPUB_READER_PRESENTATION_MODES.AUTHOR)
      return baseReaderCss;

    return `
      ${baseReaderCss}
      html body {
        text-rendering: optimizeLegibility !important;
        -webkit-font-smoothing: antialiased !important;
      }
      html body p,
      html body li,
      html body dd,
      html body dt {
        margin-block: var(--anythingllm-epub-paragraph-gap) !important;
        line-height: var(--anythingllm-epub-line-height) !important;
      }
      html body p {
        text-indent: var(--anythingllm-epub-paragraph-indent) !important;
        text-align: justify !important;
      }
      html body ul,
      html body ol {
        margin-block: var(--anythingllm-epub-block-gap) !important;
        padding-inline-start: var(--anythingllm-epub-list-indent) !important;
      }
      html body h1,
      html body h2,
      html body h3,
      html body h4,
      html body h5,
      html body h6 {
        margin-block-start: var(--anythingllm-epub-heading-gap-before) !important;
        margin-block-end: var(--anythingllm-epub-heading-gap-after) !important;
        line-height: 1.35 !important;
        page-break-after: avoid !important;
        break-after: avoid !important;
      }
      html body h1 { font-size: 1.55em !important; font-weight: 650 !important; }
      html body h2 { font-size: 1.35em !important; font-weight: 650 !important; }
      html body h3 { font-size: 1.18em !important; font-weight: 620 !important; }
      html body h4,
      html body h5,
      html body h6 { font-size: 1.06em !important; font-weight: 620 !important; }
      html body blockquote {
        margin-block: var(--anythingllm-epub-block-gap) !important;
        margin-inline: var(--anythingllm-epub-list-indent) !important;
        padding-inline-start: 0.9em !important;
        border-inline-start: 0.18em solid var(--anythingllm-epub-table-border-color) !important;
      }
      html body img,
      html body svg,
      html body video,
      html body canvas {
        max-width: 100% !important;
        height: auto !important;
        object-fit: contain !important;
      }
      html body table {
        max-width: 100% !important;
        border-collapse: collapse !important;
        table-layout: auto !important;
      }
      html body th,
      html body td {
        border-color: var(--anythingllm-epub-table-border-color) !important;
        vertical-align: top !important;
      }
      html body pre,
      html body code,
      html body kbd,
      html body samp {
        white-space: pre-wrap !important;
        word-break: break-word !important;
      }
    `;
  }

  function applyReaderThemeToContents(
    contentsOrView,
    themeName = readerThemeRef.current,
    size = fontSizeRef.current,
    details = {}
  ) {
    const contents = normalizeRenditionContents(contentsOrView);
    if (!contents) return false;
    if (contentHasReaderTheme(contents, themeName, size)) {
      debugEpubPaint("themeContentReady", details);
      return true;
    }
    ensureReaderThemeStyle(contents.document, themeName, size, {
      source: "applyReaderThemeToContents",
      ...details,
    });
    return contentHasReaderTheme(contents, themeName, size);
  }

  function applyReaderThemeToVisibleContents(
    rendition = renditionRef.current,
    themeName = readerThemeRef.current,
    size = fontSizeRef.current,
    details = {}
  ) {
    let anyApplied = false;
    try {
      for (const contents of rendition?.getContents?.() || []) {
        anyApplied =
          applyReaderThemeToContents(contents, themeName, size, details) ||
          anyApplied;
      }
    } catch {}
    return anyApplied;
  }

  function applyReaderThemeToPreviewContainer(
    container,
    themeName = readerThemeRef.current,
    size = fontSizeRef.current
  ) {
    if (!container) return;
    for (const iframe of container.querySelectorAll("iframe")) {
      try {
        const contentDocument = iframe.contentDocument;
        if (!contentDocument?.documentElement || !contentDocument?.body)
          continue;
        ensureReaderThemeStyle(contentDocument, themeName, size, {
          source: "previewContainer",
        });
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

  function contentVisibleTextStyleSnapshot(contentsOrView, options = {}) {
    const { sampleLimit = 8 } = options;
    try {
      const contents = normalizeRenditionContents(contentsOrView);
      const doc = contents?.document;
      const win = contents?.window || doc?.defaultView;
      const body = doc?.body;
      if (!doc || !win || !body) return null;
      const bodyStyle = win.getComputedStyle?.(body);
      const rootStyle = win.getComputedStyle?.(doc.documentElement);
      const expectedTextColor = bodyStyle?.color || "";
      const expectedLineHeight = bodyStyle?.lineHeight || "";
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
          if (["script", "style", "noscript"].includes(tagName)) {
            return nodeFilter?.FILTER_REJECT || 2;
          }
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
      const samples = [];
      let checked = 0;
      let node = walker.nextNode();
      while (node && checked < 300 && samples.length < sampleLimit) {
        checked += 1;
        const range = doc.createRange();
        range.selectNodeContents(node);
        const hasVisibleRect = Array.from(range.getClientRects()).some((rect) =>
          rectIntersectsViewport(rect, viewportWidth, viewportHeight)
        );
        range.detach?.();
        if (hasVisibleRect) {
          const parent = node.parentElement;
          const style = win.getComputedStyle?.(parent);
          samples.push({
            text: node.nodeValue.trim().slice(0, 32),
            tagName: parent?.tagName?.toLowerCase?.() || null,
            className:
              typeof parent?.className === "string" ? parent.className : null,
            fontFamily: style?.fontFamily || "",
            color: style?.color || "",
            lineHeight: style?.lineHeight || "",
          });
        }
        node = walker.nextNode();
      }
      const textFontFamilies = Array.from(
        new Set(samples.map((sample) => sample.fontFamily).filter(Boolean))
      );
      const textColors = Array.from(
        new Set(samples.map((sample) => sample.color).filter(Boolean))
      );
      const textLineHeights = Array.from(
        new Set(samples.map((sample) => sample.lineHeight).filter(Boolean))
      );
      const hasReaderFont =
        samples.length > 0
          ? samples.every((sample) =>
              fontFamilyHasReaderFont(sample.fontFamily)
            )
          : fontFamilyHasReaderFont(bodyStyle?.fontFamily);
      const hasReaderColor =
        samples.length > 0
          ? samples.every(
              (sample) =>
                !sample.color ||
                !expectedTextColor ||
                sample.color === expectedTextColor ||
                sample.tagName === "a"
            )
          : true;
      const hasReaderLineHeight =
        samples.length > 0
          ? samples.every(
              (sample) =>
                !sample.lineHeight ||
                !expectedLineHeight ||
                sample.lineHeight === expectedLineHeight ||
                sample.tagName?.match?.(/^h[1-6]$/)
            )
          : true;
      return {
        bodyFontFamily: bodyStyle?.fontFamily || "",
        bodyColor: bodyStyle?.color || "",
        bodyLineHeight: bodyStyle?.lineHeight || "",
        bodyPadding: bodyStyle?.padding || "",
        bodyColumnGap: bodyStyle?.columnGap || "",
        bodyColumnWidth: bodyStyle?.columnWidth || "",
        rootColumnGap: rootStyle?.columnGap || "",
        rootColumnWidth: rootStyle?.columnWidth || "",
        textFontFamilies,
        textColors,
        textLineHeights,
        primaryTextFontFamily: textFontFamilies[0] || "",
        primaryTextColor: textColors[0] || "",
        primaryTextLineHeight: textLineHeights[0] || "",
        hasReaderFont,
        hasReaderColor,
        hasReaderLineHeight,
        samples,
        signature: [
          bodyStyle?.padding || "",
          bodyStyle?.columnGap || "",
          bodyStyle?.columnWidth || "",
          textFontFamilies.join("|"),
          textColors.join("|"),
          textLineHeights.join("|"),
          samples.map((sample) => sample.text).join("|"),
        ].join("~"),
      };
    } catch {
      return null;
    }
  }

  function mainVisibleTextStyleSnapshot(rendition = renditionRef.current) {
    try {
      for (const contents of rendition?.getContents?.() || []) {
        const snapshot = contentVisibleTextStyleSnapshot(contents);
        if (snapshot?.samples?.length) return snapshot;
      }
    } catch {}
    return null;
  }

  function debugFontConflict(details = {}) {
    try {
      if (!import.meta.env?.DEV || epubPaintLoggingRef.current) return;
      const turn = currentEpubPaintTurn();
      const entry = {
        at: Math.round(performance.now()),
        event: "fontConflict",
        turnId: turn?.id || null,
        sequence: turn?.sequence || null,
        details,
      };
      epubPaintTraceRef.current = [...epubPaintTraceRef.current, entry].slice(
        -160
      );
      console.debug("[EPUB paint]", "fontConflict", entry);
    } catch {}
  }

  function contentVisibleLayoutSnapshot(contentsOrView, options = {}) {
    const { requireThemeReady = true } = options;
    try {
      const contents = normalizeRenditionContents(contentsOrView);
      const doc = contents?.document;
      const win = contents?.window || doc?.defaultView;
      const body = doc?.body;
      if (!doc || !win || !body) return null;
      if (
        requireThemeReady &&
        !contentHasReaderTheme(
          contents,
          readerThemeRef.current,
          fontSizeRef.current
        )
      ) {
        return null;
      }
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
      if (viewportWidth < 160 || viewportHeight < 160) return null;
      const frameElement = win.frameElement;
      const stageElement = frameElement?.closest?.(
        ".epub-reader-transition-stage"
      );
      const frameRect = frameElement?.getBoundingClientRect?.();
      const stageRect = stageElement?.getBoundingClientRect?.();
      const clipLeft =
        frameRect && stageRect && stageRect.width > 0
          ? Math.max(0, stageRect.left - frameRect.left)
          : 0;
      const clipRight =
        frameRect && stageRect && stageRect.width > 0
          ? Math.min(viewportWidth, clipLeft + stageRect.width)
          : viewportWidth;
      const clipTop =
        frameRect && stageRect && stageRect.height > 0
          ? Math.max(0, stageRect.top - frameRect.top)
          : 0;
      const clipBottom =
        frameRect && stageRect && stageRect.height > 0
          ? Math.min(viewportHeight, clipTop + stageRect.height)
          : viewportHeight;
      if (clipRight - clipLeft < 120 || clipBottom - clipTop < 120) {
        return null;
      }

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
      const rects = [];
      const textSamples = [];
      let visibleArea = 0;
      let minLeft = Number.POSITIVE_INFINITY;
      let maxRight = Number.NEGATIVE_INFINITY;
      let minTop = Number.POSITIVE_INFINITY;
      let maxBottom = Number.NEGATIVE_INFINITY;
      let node = walker.nextNode();
      while (
        node &&
        checked < 300 &&
        rects.length < PAGE_TURN_STABLE_LAYOUT_SAMPLE_LIMIT
      ) {
        checked += 1;
        const range = doc.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (
            rectIntersectsViewport(
              rect,
              Math.max(viewportWidth, clipRight),
              Math.max(viewportHeight, clipBottom)
            )
          ) {
            const clippedLeft = Math.max(clipLeft, rect.left);
            const clippedRight = Math.min(clipRight, rect.right);
            const clippedTop = Math.max(clipTop, rect.top);
            const clippedBottom = Math.min(clipBottom, rect.bottom);
            const clippedWidth = Math.max(0, clippedRight - clippedLeft);
            const clippedHeight = Math.max(0, clippedBottom - clippedTop);
            if (clippedWidth <= 1 || clippedHeight <= 1) continue;
            visibleArea += clippedWidth * clippedHeight;
            minLeft = Math.min(minLeft, clippedLeft);
            maxRight = Math.max(maxRight, clippedRight);
            minTop = Math.min(minTop, clippedTop);
            maxBottom = Math.max(maxBottom, clippedBottom);
            rects.push({
              left: Math.round(clippedLeft),
              right: Math.round(clippedRight),
              top: Math.round(clippedTop),
              bottom: Math.round(clippedBottom),
              width: Math.round(clippedWidth),
              height: Math.round(clippedHeight),
            });
            if (textSamples.length < 6) {
              textSamples.push(node.nodeValue.trim().slice(0, 24));
            }
            break;
          }
        }
        range.detach?.();
        node = walker.nextNode();
      }
      if (!rects.length || visibleArea < 120) return null;
      const clusterWidth = maxRight - minLeft;
      const clusterHeight = maxBottom - minTop;
      if (clusterWidth < 24 || clusterHeight < 12) return null;
      const visibleTextStyle = contentVisibleTextStyleSnapshot(contents);
      return {
        viewportWidth,
        viewportHeight,
        themeReady: contentHasReaderTheme(
          contents,
          readerThemeRef.current,
          fontSizeRef.current
        ),
        themeSignature:
          doc.documentElement?.dataset?.anythingllmEpubThemeSignature || null,
        fontFamily: win.getComputedStyle?.(body)?.fontFamily || null,
        visibleTextStyle,
        clipLeft: Math.round(clipLeft),
        clipRight: Math.round(clipRight),
        clipTop: Math.round(clipTop),
        clipBottom: Math.round(clipBottom),
        visibleArea: Math.round(visibleArea),
        minLeft: Math.round(minLeft),
        maxRight: Math.round(maxRight),
        minTop: Math.round(minTop),
        maxBottom: Math.round(maxBottom),
        rects,
        text: textSamples.join("|"),
        signature: [
          Math.round(minLeft / 4),
          Math.round(maxRight / 4),
          Math.round(minTop / 4),
          Math.round(maxBottom / 4),
          Math.round(visibleArea / 80),
          textSamples.join("|"),
        ].join("~"),
      };
    } catch {
      return null;
    }
  }

  function mainRenditionVisibleLayoutSnapshot(
    rendition = renditionRef.current,
    options = {}
  ) {
    try {
      for (const contents of rendition?.getContents?.() || []) {
        const snapshot = contentVisibleLayoutSnapshot(contents, options);
        if (snapshot) return snapshot;
      }
    } catch {}
    return null;
  }

  function mainRenditionHasVisiblePage(
    rendition = renditionRef.current,
    options = {}
  ) {
    try {
      return Boolean(mainRenditionVisibleLayoutSnapshot(rendition, options));
    } catch {
      return false;
    }
  }

  function contentHasReaderThemeMarker(
    contentsOrView,
    themeName = readerThemeRef.current,
    size = fontSizeRef.current
  ) {
    try {
      const contents = normalizeRenditionContents(contentsOrView);
      const doc = contents?.document;
      const root = doc?.documentElement;
      const styleElement = doc?.getElementById(EPUB_READER_THEME_STYLE_ID);
      return Boolean(
        doc &&
          root &&
          styleElement?.textContent &&
          root.dataset.anythingllmEpubThemeReady === "true" &&
          root.dataset.anythingllmEpubThemeSignature ===
            readerThemeSignature(themeName, size)
      );
    } catch {
      return false;
    }
  }

  function contentChapterContentSnapshot(contentsOrView) {
    try {
      const contents = normalizeRenditionContents(contentsOrView);
      const doc = contents?.document;
      const win = contents?.window || doc?.defaultView;
      const body = doc?.body;
      if (!doc || !win || !body) return null;
      const themeReady = contentHasReaderThemeMarker(contents);
      const bodyStyle = win.getComputedStyle?.(body);
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
      if (viewportWidth < 120 || viewportHeight < 120) {
        return {
          themeReady,
          hasVisibleText: false,
          textSampleLength: 0,
          viewportWidth,
          viewportHeight,
        };
      }

      const nodeFilter = win.NodeFilter || window.NodeFilter;
      const walker = doc.createTreeWalker(body, nodeFilter?.SHOW_TEXT || 4, {
        acceptNode(node) {
          const text = node.nodeValue?.trim();
          if (!text) return nodeFilter?.FILTER_REJECT || 2;
          const parent = node.parentElement;
          if (!parent) return nodeFilter?.FILTER_REJECT || 2;
          const tagName = parent.tagName?.toLowerCase?.();
          if (["script", "style", "noscript"].includes(tagName)) {
            return nodeFilter?.FILTER_REJECT || 2;
          }
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

      const samples = [];
      let checked = 0;
      let textSampleLength = 0;
      let node = walker.nextNode();
      while (
        node &&
        checked < CHAPTER_CONTENT_TEXT_NODE_CHECK_LIMIT &&
        samples.length < CHAPTER_CONTENT_VISIBLE_SAMPLE_LIMIT
      ) {
        checked += 1;
        const text = node.nodeValue?.trim() || "";
        textSampleLength += text.length;
        const range = doc.createRange();
        range.selectNodeContents(node);
        const visibleRect = Array.from(range.getClientRects()).find((rect) =>
          rectIntersectsViewport(rect, viewportWidth, viewportHeight)
        );
        range.detach?.();
        if (visibleRect) {
          const parent = node.parentElement;
          const style = win.getComputedStyle?.(parent);
          samples.push({
            text: text.slice(0, 32),
            tagName: parent?.tagName?.toLowerCase?.() || null,
            fontFamily: style?.fontFamily || "",
            color: style?.color || "",
            lineHeight: style?.lineHeight || "",
            rect: {
              left: Math.round(visibleRect.left),
              top: Math.round(visibleRect.top),
              width: Math.round(visibleRect.width),
              height: Math.round(visibleRect.height),
            },
          });
        }
        node = walker.nextNode();
      }

      const hasVisibleText = samples.length > 0;
      const hasReaderFont = hasVisibleText
        ? samples.every((sample) => fontFamilyHasReaderFont(sample.fontFamily))
        : fontFamilyHasReaderFont(bodyStyle?.fontFamily);
      return {
        themeReady,
        hasVisibleText,
        hasReaderFont,
        checked,
        textSampleLength,
        viewportWidth,
        viewportHeight,
        bodyPadding: bodyStyle?.padding || "",
        bodyColumnGap: bodyStyle?.columnGap || "",
        bodyColumnWidth: bodyStyle?.columnWidth || "",
        bodyFontFamily: bodyStyle?.fontFamily || "",
        samples,
        signature: [
          themeReady ? "theme" : "no-theme",
          hasVisibleText ? "visible" : "hidden",
          bodyStyle?.padding || "",
          bodyStyle?.columnGap || "",
          bodyStyle?.columnWidth || "",
          samples.map((sample) => sample.text).join("|"),
        ].join("~"),
      };
    } catch {
      return null;
    }
  }

  function mainRenditionChapterContentSnapshot(
    rendition = renditionRef.current
  ) {
    try {
      for (const contents of rendition?.getContents?.() || []) {
        const snapshot = contentChapterContentSnapshot(contents);
        if (snapshot?.themeReady && snapshot?.hasVisibleText) return snapshot;
      }
    } catch {}
    return null;
  }

  function mainRenditionHasChapterContent(rendition = renditionRef.current) {
    return Boolean(mainRenditionChapterContentSnapshot(rendition));
  }

  function epubDebugSnapshot(label = "snapshot") {
    try {
      const stage = containerRef.current?.closest?.(
        ".epub-reader-transition-stage"
      );
      const outgoing = outgoingLayerRef.current;
      const incoming = incomingLayerRef.current;
      const iframe = stage?.querySelector?.("iframe");
      const doc = iframe?.contentDocument;
      const body = doc?.body;
      const root = doc?.documentElement;
      const win = iframe?.contentWindow || doc?.defaultView;
      const bodyStyle = body && win ? win.getComputedStyle(body) : null;
      const rootStyle = root && win ? win.getComputedStyle(root) : null;
      const outgoingStyle = outgoing ? window.getComputedStyle(outgoing) : null;
      const layout = mainRenditionVisibleLayoutSnapshot();
      return {
        label,
        location: currentLocationRef.current?.start || null,
        mainPaintReady,
        mainLayerSuppressed,
        turnInFlight: turnInFlightRef.current,
        activeTurnId: activePageTurnIdRef.current,
        readerPresentationMode: EPUB_READER_PRESENTATION_MODE,
        turnAnimation,
        stageRect: stage?.getBoundingClientRect?.()?.toJSON?.() || null,
        iframeRect: iframe?.getBoundingClientRect?.()?.toJSON?.() || null,
        iframeWindow: win
          ? {
              innerWidth: win.innerWidth,
              innerHeight: win.innerHeight,
            }
          : null,
        rootMetrics: root
          ? {
              clientWidth: root.clientWidth,
              scrollWidth: root.scrollWidth,
              offsetWidth: root.offsetWidth,
              columnWidth: rootStyle?.columnWidth || null,
              columnGap: rootStyle?.columnGap || null,
              themeReady:
                root.dataset?.anythingllmEpubThemeReady === "true" || false,
              themeSignature:
                root.dataset?.anythingllmEpubThemeSignature || null,
            }
          : null,
        bodyMetrics: body
          ? {
              clientWidth: body.clientWidth,
              scrollWidth: body.scrollWidth,
              offsetWidth: body.offsetWidth,
              margin: bodyStyle?.margin || null,
              maxWidth: bodyStyle?.maxWidth || null,
              width: bodyStyle?.width || null,
              padding: bodyStyle?.padding || null,
              columnWidth: bodyStyle?.columnWidth || null,
              columnGap: bodyStyle?.columnGap || null,
              fontFamily: bodyStyle?.fontFamily || null,
              themeStylePresent: Boolean(
                doc?.getElementById(EPUB_READER_THEME_STYLE_ID)
              ),
            }
          : null,
        textStart:
          (body?.innerText || body?.textContent || "").trim().slice(0, 120) ||
          "",
        visibleTextStyle: contentVisibleTextStyleSnapshot({
          document: doc,
          window: win,
        }),
        layout,
        themeReady: contentHasReaderTheme(
          { document: doc, window: win },
          readerThemeRef.current,
          fontSizeRef.current
        ),
        outgoing: outgoing
          ? {
              className: outgoing.className,
              dataTurnMode: outgoing.getAttribute("data-turn-mode"),
              opacity: outgoingStyle?.opacity || null,
              transform: outgoingStyle?.transform || null,
              pointerEvents: outgoingStyle?.pointerEvents || null,
            }
          : null,
        incoming: incoming
          ? {
              dataTurnMode: incoming.getAttribute("data-turn-mode"),
              children: incoming.children?.length || 0,
            }
          : null,
      };
    } catch (error) {
      return { label, error: error?.message || String(error) };
    }
  }

  function debugEpubTurn(eventName, details = {}) {
    try {
      if (!import.meta.env?.DEV) return;
      const outgoing = outgoingLayerRef.current;
      const incoming = incomingLayerRef.current;
      const captureExpensiveSnapshot =
        details.captureSnapshot ||
        EPUB_DEBUG_EXPENSIVE_TURN_EVENTS.has(eventName);
      console.debug("[EPUB turn]", eventName, {
        ...details,
        layout: captureExpensiveSnapshot
          ? mainRenditionVisibleLayoutSnapshot()
          : null,
        mainVisible: captureExpensiveSnapshot
          ? mainRenditionHasVisiblePage()
          : null,
        hasStableSnapshot: Boolean(stablePageSnapshotRef.current?.html),
        outgoingClassName: outgoing?.className || null,
        outgoingOpacity: outgoing
          ? window.getComputedStyle(outgoing).opacity
          : null,
        incomingChildren: incoming?.children?.length || 0,
        activeTurnId: activePageTurnIdRef.current,
      });
    } catch {}
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

  function escapeHtmlAttribute(value = "") {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function stableSnapshotSafeAttributes(element, skipAttributes = new Set()) {
    try {
      return Array.from(element?.attributes || [])
        .filter((attribute) => {
          const name = attribute.name?.toLowerCase?.() || "";
          if (!name || skipAttributes.has(name)) return false;
          if (name.startsWith("on")) return false;
          if (name === "srcdoc") return false;
          return true;
        })
        .map(
          (attribute) =>
            `${attribute.name}="${escapeHtmlAttribute(attribute.value)}"`
        )
        .join(" ");
    } catch {
      return "";
    }
  }

  function sanitizeStableSnapshotClone(element) {
    try {
      element
        ?.querySelectorAll?.(
          "script, style, link[rel='stylesheet'], iframe, object, embed"
        )
        ?.forEach((node) => node.remove());
      element?.querySelectorAll?.("*")?.forEach((node) => {
        for (const attribute of Array.from(node.attributes || [])) {
          const name = attribute.name?.toLowerCase?.() || "";
          if (name.startsWith("on") || name === "srcdoc") {
            node.removeAttribute(attribute.name);
          }
        }
      });
    } catch {}
  }

  function computedStyleDeclarations(style, properties = []) {
    try {
      if (!style) return "";
      return properties
        .map((property) => {
          const value = style.getPropertyValue?.(property);
          return value ? `${property}: ${value} !important;` : "";
        })
        .filter(Boolean)
        .join("\n");
    } catch {
      return "";
    }
  }

  function stableSnapshotScrollOffset(doc, win, body) {
    try {
      const root = doc?.documentElement;
      return {
        left: Math.max(
          0,
          Math.round(
            Number(win?.scrollX || 0) ||
              Number(root?.scrollLeft || 0) ||
              Number(body?.scrollLeft || 0) ||
              0
          )
        ),
        top: Math.max(
          0,
          Math.round(
            Number(win?.scrollY || 0) ||
              Number(root?.scrollTop || 0) ||
              Number(body?.scrollTop || 0) ||
              0
          )
        ),
      };
    } catch {
      return { left: 0, top: 0 };
    }
  }

  function captureStablePageSnapshot(rendition = renditionRef.current) {
    try {
      const contents = (rendition?.getContents?.() || []).find((item) => {
        const body = item?.document?.body;
        if (!body) return false;
        if (
          !contentHasReaderTheme(
            item,
            readerThemeRef.current,
            fontSizeRef.current
          )
        ) {
          return false;
        }
        const visibleText = body.innerText || body.textContent || "";
        return visibleText.trim().length > 0;
      });
      const body = contents?.document?.body;
      if (!body) return null;
      const doc = contents.document;
      const win = contents?.window || contents?.document?.defaultView;
      const root = doc?.documentElement;
      if (!doc || !win || !root) return null;
      const bodyStyle = win?.getComputedStyle?.(body);
      const rootStyle = win?.getComputedStyle?.(root);
      const theme = themeByName(readerThemeRef.current);
      const bodyStyles = theme.styles?.body || {};
      const bodyClone = body.cloneNode(true);
      sanitizeStableSnapshotClone(bodyClone);
      const bodyInnerHtml = bodyClone.innerHTML;
      if (bodyInnerHtml.length > STABLE_SNAPSHOT_MAX_HTML_LENGTH) {
        debugEpubPaint("stableSnapshotSkipped", {
          reason: "htmlTooLarge",
          htmlLength: bodyInnerHtml.length,
          maxHtmlLength: STABLE_SNAPSHOT_MAX_HTML_LENGTH,
        });
        return null;
      }
      const viewportWidth = Math.max(
        1,
        Math.floor(win.innerWidth || root.clientWidth || body.clientWidth || 0)
      );
      const viewportHeight = Math.max(
        1,
        Math.floor(
          win.innerHeight || root.clientHeight || body.clientHeight || 0
        )
      );
      const scrollOffset = stableSnapshotScrollOffset(doc, win, body);
      const rootAttributes = stableSnapshotSafeAttributes(
        root,
        new Set(["style", "class"])
      );
      const bodyAttributes = stableSnapshotSafeAttributes(
        body,
        new Set(["style", "class"])
      );
      const rootClassName = [
        "anythingllm-epub-stable-snapshot-html",
        root.className || "",
      ]
        .filter(Boolean)
        .join(" ");
      const bodyClassName = [
        "anythingllm-epub-stable-snapshot-body",
        body.className || "",
      ]
        .filter(Boolean)
        .join(" ");
      const rootLayoutCss = computedStyleDeclarations(
        rootStyle,
        STABLE_SNAPSHOT_MIRROR_STYLE_PROPERTIES
      );
      const bodyLayoutCss = computedStyleDeclarations(
        bodyStyle,
        STABLE_SNAPSHOT_MIRROR_STYLE_PROPERTIES
      );
      const rootAttributeText = rootAttributes ? ` ${rootAttributes}` : "";
      const bodyAttributeText = bodyAttributes ? ` ${bodyAttributes}` : "";
      const contentStyleText = `
        ${readerSnapshotStyleText(".anythingllm-epub-stable-snapshot-body")}
        .anythingllm-epub-stable-snapshot-document {
          width: ${viewportWidth}px;
          height: ${viewportHeight}px;
          overflow: hidden;
          background: var(--anythingllm-epub-background);
          color: var(--anythingllm-epub-color);
          font-family: var(--anythingllm-epub-font-family);
          font-size: var(--anythingllm-epub-font-size);
          line-height: var(--anythingllm-epub-line-height);
          box-sizing: border-box;
        }
        .anythingllm-epub-stable-snapshot-html {
          ${rootLayoutCss}
          width: ${viewportWidth}px;
          height: ${viewportHeight}px;
          overflow: visible;
          background: var(--anythingllm-epub-background) !important;
          color: var(--anythingllm-epub-color) !important;
        }
        .anythingllm-epub-stable-snapshot-scroll {
          transform: translate(${-scrollOffset.left}px, ${-scrollOffset.top}px);
          transform-origin: 0 0;
          width: max-content;
          min-width: ${viewportWidth}px;
        }
        .anythingllm-epub-stable-snapshot-body {
          ${bodyLayoutCss}
          color: var(--anythingllm-epub-color) !important;
          background: var(--anythingllm-epub-background) !important;
          font-family: var(--anythingllm-epub-font-family) !important;
          font-size: var(--anythingllm-epub-font-size) !important;
          line-height: var(--anythingllm-epub-line-height) !important;
        }
      `;
      const html = `
        <style>${contentStyleText}</style>
        <div class="anythingllm-epub-stable-snapshot-document">
          <div class="${escapeHtmlAttribute(rootClassName)}"${rootAttributeText}>
            <div class="anythingllm-epub-stable-snapshot-scroll">
              <div class="${escapeHtmlAttribute(bodyClassName)}"${bodyAttributeText}>${bodyInnerHtml}</div>
            </div>
          </div>
        </div>
      `;
      return {
        html,
        background: bodyStyles.background || "transparent",
        color: bodyStyles.color || "inherit",
        fontFamily: EPUB_READER_FONT_FAMILY,
        fontSize: `${clampFontSize(fontSizeRef.current)}%`,
        lineHeight: "var(--anythingllm-epub-line-height)",
        margin: bodyStyle?.margin || bodyStyles.margin || "0",
        maxWidth: bodyStyle?.maxWidth || bodyStyles["max-width"] || "none",
        padding: bodyStyle?.padding || bodyStyles.padding || "20px 0",
        contentStyleText: "",
        viewportWidth,
        viewportHeight,
        scrollLeft: scrollOffset.left,
        scrollTop: scrollOffset.top,
        themeSignature: readerThemeSignature(
          readerThemeRef.current,
          fontSizeRef.current
        ),
      };
    } catch {
      return null;
    }
  }

  function rememberStablePageSnapshot(
    rendition = renditionRef.current,
    reason = "rememberStablePageSnapshot"
  ) {
    const snapshot = captureStablePageSnapshot(rendition);
    if (snapshot?.html) {
      stablePageSnapshotRef.current = snapshot;
      setStablePageSnapshot(snapshot);
      debugEpubPaint("stableSnapshotSwap", {
        reason,
        themeSignature: snapshot.themeSignature,
        htmlLength: snapshot.html.length,
        viewportWidth: snapshot.viewportWidth,
        viewportHeight: snapshot.viewportHeight,
        scrollLeft: snapshot.scrollLeft,
        scrollTop: snapshot.scrollTop,
      });
    }
    return Boolean(snapshot?.html);
  }

  function stableSnapshotLayerMarkup(snapshot) {
    if (!snapshot?.html) return "";
    return `${
      snapshot.contentStyleText
        ? `<style>${snapshot.contentStyleText}</style>`
        : ""
    }${snapshot.html}`;
  }

  function hasVisibleTurnCover() {
    const layer = turnCoverLayerRef.current;
    return Boolean(layer && (layer.children?.length || 0) > 0);
  }

  function clearVisibleTurnCover(reason = "clear", expectedGeneration = null) {
    const layer = turnCoverLayerRef.current;
    if (!layer) return;
    if (
      expectedGeneration !== null &&
      turnCoverGenerationRef.current !== expectedGeneration
    ) {
      debugEpubPaint("turnCoverClearSkipped", {
        reason,
        expectedGeneration,
        currentGeneration: turnCoverGenerationRef.current,
      });
      return;
    }
    const children = layer.children?.length || 0;
    layer.innerHTML = "";
    layer.style.opacity = "";
    layer.style.visibility = "";
    layer.style.animation = "";
    layer.style.transform = "";
    layer.style.filter = "";
    debugEpubPaint("turnCoverCleared", {
      reason,
      children,
      generation: turnCoverGenerationRef.current,
    });
  }

  function clearVisibleTurnCoverAfterPaint(reason = "clear", frameCount = 2) {
    const generation = turnCoverGenerationRef.current;
    let remainingFrames = Math.max(1, Number(frameCount) || 1);
    const clearAfterFrame = () => {
      remainingFrames -= 1;
      if (remainingFrames <= 0) {
        clearVisibleTurnCover(reason, generation);
        return;
      }
      window.requestAnimationFrame(clearAfterFrame);
    };
    window.requestAnimationFrame(clearAfterFrame);
  }

  function prepareVisibleTurnCover(reason = "turn-cover") {
    const layer = turnCoverLayerRef.current;
    if (!layer) {
      debugEpubPaint("turnCoverMissing", { reason, missingLayer: true });
      return false;
    }
    const snapshot = captureStablePageSnapshot(renditionRef.current);
    if (!snapshot?.html) {
      debugEpubPaint("turnCoverMissing", {
        reason,
        missingSnapshot: true,
      });
      return false;
    }
    try {
      turnCoverGenerationRef.current += 1;
      layer.innerHTML = stableSnapshotLayerMarkup(snapshot);
      layer.style.opacity = "1";
      layer.style.visibility = "visible";
      layer.style.animation = "none";
      layer.style.transform = "none";
      layer.style.filter = "none";
      const rect = layer.getBoundingClientRect?.();
      const visible = Boolean(
        (layer.children?.length || 0) > 0 &&
          rect &&
          rect.width > 0 &&
          rect.height > 0
      );
      if (!visible) {
        clearVisibleTurnCover("prepare-empty");
        debugEpubPaint("turnCoverMissing", {
          reason,
          emptyAfterPrepare: true,
        });
        return false;
      }
      debugEpubPaint("turnCoverPrepared", {
        reason,
        htmlLength: snapshot.html.length,
        viewportWidth: snapshot.viewportWidth,
        viewportHeight: snapshot.viewportHeight,
        scrollLeft: snapshot.scrollLeft,
        scrollTop: snapshot.scrollTop,
        generation: turnCoverGenerationRef.current,
      });
      return true;
    } catch (error) {
      clearVisibleTurnCover("prepare-error");
      debugEpubPaint("turnCoverMissing", {
        reason,
        error: error?.message || String(error),
      });
      return false;
    }
  }

  function revealMainLayer(reason = "visible", details = {}) {
    debugEpubPaint("mainReveal", { reason, ...details });
    setMainLayerSuppressed(false);
    mainPaintReadyRef.current = true;
    setMainPaintReady(true);
    debugEpubTurn("reveal", { reason, ...details });
    if (!details.skipPostRevealSamples) {
      schedulePostRevealPaintSamples(reason);
    }
  }

  function schedulePostRevealPaintSamples(reason) {
    try {
      if (!import.meta.env?.DEV) return;
      for (const timer of postRevealPaintTimersRef.current) {
        window.clearTimeout(timer);
      }
      let previousStyleSignature = null;
      postRevealPaintTimersRef.current = [50, 200, 500].map((delayMs) =>
        window.setTimeout(() => {
          const visibleTextStyle = mainVisibleTextStyleSnapshot();
          if (
            previousStyleSignature &&
            visibleTextStyle?.signature &&
            visibleTextStyle.signature !== previousStyleSignature
          ) {
            debugEpubPaint("visibleTextStyleChange", {
              reason,
              delayMs,
              previousStyleSignature,
              nextStyleSignature: visibleTextStyle.signature,
              visibleTextStyle,
            });
          }
          previousStyleSignature = visibleTextStyle?.signature || null;
          debugEpubPaint("postRevealPaintSample", {
            reason,
            delayMs,
            visibleTextStyle,
          });
        }, delayMs)
      );
    } catch {}
  }

  function recoverVisibleMainLayer(reason = "recover", options = {}) {
    const { clearLayers = true } = options;
    if (!mainRenditionHasVisiblePage()) {
      debugEpubTurn("recover-miss", { reason });
      return false;
    }
    rememberStablePageSnapshot(renditionRef.current, reason);
    revealMainLayer(reason);
    clearVisibleTurnCoverAfterPaint(`recover:${reason}`);
    if (clearLayers) clearTurnLayers();
    return true;
  }

  async function waitForMainVisiblePage(timeoutMs = 700, options = {}) {
    const { updateStableSnapshot = true } = options;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await waitForAnimationFrame();
      if (mainRenditionHasVisiblePage()) {
        if (updateStableSnapshot) {
          rememberStablePageSnapshot(
            renditionRef.current,
            "waitForMainVisiblePage"
          );
        }
        return true;
      }
      await wait(50);
    }
    return false;
  }

  async function waitForMainChapterContent(timeoutMs = 900) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await waitForAnimationFrame();
      const snapshot = mainRenditionChapterContentSnapshot();
      if (snapshot) {
        debugEpubChapter("chapterContentReady", {
          waitedMs: Date.now() - startedAt,
          snapshot,
        });
        return snapshot;
      }
      await wait(40);
    }
    debugEpubChapter("chapterContentTimeout", { timeoutMs });
    return null;
  }

  function stableLayoutSnapshotsMatch(previous, next) {
    if (!previous || !next) return false;
    if (previous.signature === next.signature) return true;
    if (previous.text !== next.text) return false;
    return (
      Math.abs(previous.minLeft - next.minLeft) <= 4 &&
      Math.abs(previous.maxRight - next.maxRight) <= 4 &&
      Math.abs(previous.minTop - next.minTop) <= 4 &&
      Math.abs(previous.maxBottom - next.maxBottom) <= 4 &&
      Math.abs(previous.visibleArea - next.visibleArea) <= 160
    );
  }

  async function waitForStableMainLayout(timeoutMs = 700, options = {}) {
    const { updateStableSnapshot = true } = options;
    const startedAt = Date.now();
    let previous = null;
    let stableFrames = 0;
    while (Date.now() - startedAt < timeoutMs) {
      await waitForAnimationFrame();
      const snapshot = mainRenditionVisibleLayoutSnapshot();
      if (snapshot) {
        stableFrames = stableLayoutSnapshotsMatch(previous, snapshot)
          ? stableFrames + 1
          : 1;
        previous = snapshot;
        if (stableFrames >= 2) {
          if (updateStableSnapshot) {
            rememberStablePageSnapshot(
              renditionRef.current,
              "waitForStableMainLayout"
            );
          }
          debugEpubTurn("stable-layout", {
            signature: snapshot.signature,
            visibleArea: snapshot.visibleArea,
          });
          return true;
        }
      } else {
        previous = null;
        stableFrames = 0;
      }
      await wait(40);
    }
    debugEpubTurn("stable-layout-timeout", { timeoutMs });
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

  function clearPageTurnRecoveryTimers() {
    window.clearTimeout(pageTurnTimerRef.current);
    pageTurnTimerRef.current = null;
    for (const timer of pageTurnWatchdogTimersRef.current) {
      window.clearTimeout(timer);
    }
    pageTurnWatchdogTimersRef.current = [];
  }

  function resetTurnLayerDomState() {
    const layers = [incomingLayerRef.current, outgoingLayerRef.current].filter(
      Boolean
    );
    debugEpubPaint("turnLayerDomReset", { layerCount: layers.length });
    for (const layer of layers) {
      try {
        layer.removeAttribute("data-turn-mode");
        layer.removeAttribute("data-turn-direction");
        layer.removeAttribute("data-turn-phase");
        layer.style.animation = "none";
        layer.style.transform = "none";
        layer.style.filter = "none";
        layer.getBoundingClientRect?.();
        window.requestAnimationFrame(() => {
          layer.style.animation = "";
          layer.style.transform = "";
          layer.style.filter = "";
        });
      } catch {}
    }
  }

  function hasIncomingHandoffCover() {
    return Boolean(
      incomingLayerRef.current &&
        (incomingLayerRef.current.children?.length || 0) > 0
    );
  }

  function raiseIncomingHandoffCover(reason = "handoff") {
    const layer = incomingLayerRef.current;
    if (!hasIncomingHandoffCover()) return false;
    try {
      layer.style.zIndex = "15";
      layer.style.opacity = "1";
      layer.style.visibility = "visible";
      layer.style.transform = "none";
      layer.style.filter = "none";
      layer.style.animation = "none";
      debugEpubPaint("incomingHandoffCover", {
        reason,
        children: layer.children?.length || 0,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function waitForPostRevealMainStability(reason = "handoff") {
    const ready =
      (await waitForStableMainLayout(PAGE_TURN_HANDOFF_STABILITY_MS, {
        updateStableSnapshot: false,
      })) || mainRenditionHasVisiblePage();
    await waitForAnimationFrame();
    await waitForAnimationFrame();
    debugEpubTurn("post-reveal-stability", {
      reason,
      ready,
    });
    return ready;
  }

  async function waitForMainContentFontsReady(reason = "turn") {
    try {
      const fontReadyPromises = (renditionRef.current?.getContents?.() || [])
        .map((contents) => contents?.document?.fonts?.ready)
        .filter(Boolean);
      if (!fontReadyPromises.length) {
        debugEpubTurn("font-ready-skip", { reason });
        return true;
      }
      const result = await Promise.race([
        Promise.allSettled(fontReadyPromises).then(() => "ready"),
        wait(PAGE_TURN_FONT_READY_TIMEOUT_MS).then(() => "timeout"),
      ]);
      debugEpubTurn("font-ready", {
        reason,
        result,
        count: fontReadyPromises.length,
      });
      return result === "ready";
    } catch {
      return false;
    }
  }

  function clearTurnLayers() {
    const activeEntry = activeIncomingPreviewEntryRef.current;
    if (activeEntry?.container && previewHostRef.current) {
      debugEpubPaint("incomingDetachToCache", {
        offset: activeEntry.offset,
        status: activeEntry.status,
      });
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
      debugEpubPaint("incomingClear", {
        children: incomingLayerRef.current.children?.length || 0,
      });
      incomingLayerRef.current.innerHTML = "";
    }
    activeIncomingPreviewEntryRef.current = null;
    if (incomingLayerRef.current) {
      incomingLayerRef.current.style.zIndex = "";
      incomingLayerRef.current.style.opacity = "";
      incomingLayerRef.current.style.visibility = "";
      incomingLayerRef.current.style.animation = "";
      incomingLayerRef.current.style.transform = "";
      incomingLayerRef.current.style.filter = "";
    }
    setTurnAnimation(null);
  }

  async function finalizeTurnToMainLayer(reason, options = {}) {
    const {
      id = null,
      direction = null,
      updatePreview = true,
      deferPreviewRebuild = false,
    } = options;
    if (id && activePageTurnIdRef.current !== id) return false;
    if (!mainRenditionHasVisiblePage()) {
      debugEpubTurn("finalize-miss", { reason, id, direction });
      return false;
    }

    resetTurnLayerDomState();
    await waitForAnimationFrame();

    if (id && activePageTurnIdRef.current !== id) return false;
    if (!mainRenditionHasVisiblePage()) {
      debugEpubTurn("finalize-hidden-after-reset", { reason, id, direction });
      return false;
    }

    await waitForMainContentFontsReady(reason);
    if (id && activePageTurnIdRef.current !== id) return false;

    const hasHandoffCover = raiseIncomingHandoffCover(reason);
    if (!hasHandoffCover) {
      const stableBeforeReveal = await waitForStableMainLayout(
        PAGE_TURN_HANDOFF_STABILITY_MS,
        { updateStableSnapshot: false }
      );
      if (id && activePageTurnIdRef.current !== id) return false;
      if (!stableBeforeReveal && !mainRenditionHasVisiblePage()) {
        debugEpubTurn("finalize-unstable-before-reveal", {
          reason,
          id,
          direction,
        });
        return false;
      }
    }

    revealMainLayer(reason);
    if (hasHandoffCover) {
      await waitForPostRevealMainStability(reason);
    } else {
      await waitForAnimationFrame();
      await waitForAnimationFrame();
    }
    if (id && activePageTurnIdRef.current !== id) return false;
    if (mainRenditionHasVisiblePage()) {
      clearVisibleTurnCover(`finalize:${reason}`);
    } else {
      debugEpubPaint("turnCoverRetained", {
        reason,
        id,
        direction,
        mainVisibleAfterReveal: false,
      });
    }
    clearTurnLayers();
    if (updatePreview && direction) {
      shiftPreviewCacheWindow(direction, currentBaseCfi());
    }
    turnInFlightRef.current = false;
    activePageTurnIdRef.current = null;
    clearPageTurnRecoveryTimers();
    if (!deferPreviewRebuild) {
      schedulePreviewRebuild(updatePreview ? 0 : undefined);
    }
    debugEpubTurn("finalize-complete", { reason, id, direction });
    debugEpubPaint("turnTraceComplete", { reason, id, direction });
    epubPaintActiveTurnRef.current = null;
    return true;
  }

  function abandonTurnToStableSnapshot(reason, options = {}) {
    const { id = null, deferPreviewRebuild = false } = options;
    if (id && activePageTurnIdRef.current !== id) return;
    const stableReady = rememberStablePageSnapshot(
      renditionRef.current,
      reason
    );
    const mainVisible = mainRenditionHasVisiblePage();
    if (stableReady) {
      setMainLayerSuppressed(true);
      mainPaintReadyRef.current = false;
      setMainPaintReady(false);
    } else if (mainVisible) {
      revealMainLayer(`abandon:${reason}`, {
        skipPostRevealSamples: true,
      });
    } else {
      setMainLayerSuppressed(true);
      mainPaintReadyRef.current = false;
      setMainPaintReady(false);
    }
    clearTurnLayers();
    resetTurnLayerDomState();
    if (hasVisibleTurnCover()) {
      if (stableReady || mainVisible) {
        clearVisibleTurnCoverAfterPaint(`abandon:${reason}`);
      } else {
        debugEpubPaint("turnCoverRetained", {
          reason,
          id,
          stableReady,
          mainVisible,
        });
      }
    }
    turnInFlightRef.current = false;
    activePageTurnIdRef.current = null;
    clearPageTurnRecoveryTimers();
    if (!deferPreviewRebuild) schedulePreviewRebuild();
    debugEpubTurn("turn-abandoned", { reason, id });
    debugEpubPaint("turnTraceAbandoned", { reason, id });
    epubPaintActiveTurnRef.current = null;
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
    if (eventName && waiter.strict && (!waiter.rendered || !waiter.relocated)) {
      return;
    }
    if (eventName && (!waiter.rendered || !waiter.relocated)) {
      window.clearTimeout(waiter.softTimer);
      waiter.softTimer = window.setTimeout(finish, 90);
      return;
    }
    finish();
  }

  function waitForMainRender(options = {}) {
    const { strict = false, timeoutMs = PAGE_TURN_SETTLE_TIMEOUT_MS } = options;
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
      }, timeoutMs);
      mainRenderWaitRef.current = {
        resolve,
        timer,
        softTimer: null,
        rendered: false,
        relocated: false,
        strict,
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
      skipStableSnapshot = false,
      strictRenderWait = false,
      visibilityMode = "page",
      skipPostRevealSamples = false,
    } = options;
    const useChapterVisibility = visibilityMode === "chapter";
    if (hideBefore) {
      const coverReady = prepareVisibleTurnCover(
        `syncMainRendition:${visibilityMode}`
      );
      if (coverReady) {
        setMainLayerSuppressed(true);
        mainPaintReadyRef.current = false;
        setMainPaintReady(false);
      } else if (!mainPaintReadyRef.current) {
        debugEpubPaint("mainHiddenWithoutCover", {
          reason: "syncMainRendition",
          visibilityMode,
        });
      }
    }
    const renderWait = waitForMainRender({
      strict: strictRenderWait,
      timeoutMs: strictRenderWait ? 900 : PAGE_TURN_SETTLE_TIMEOUT_MS,
    });
    try {
      const result = action?.();
      if (result?.then) await result.catch(() => null);
    } catch {}
    const renderState = await renderWait;
    syncAnnotations();
    const visibleReady = useChapterVisibility
      ? mainRenditionHasChapterContent()
      : mainRenditionHasVisiblePage();
    const fallbackVisibleReady =
      visibleReady ||
      (allowContentFallback &&
        (useChapterVisibility
          ? Boolean(await waitForMainChapterContent(700))
          : await waitForMainVisiblePage(700, {
              updateStableSnapshot: !keepHidden && !skipStableSnapshot,
            })));
    const ready = requireFullRender
      ? Boolean(
          fallbackVisibleReady &&
            (renderState?.ready ||
              renderState?.relocated ||
              renderState?.rendered ||
              allowContentFallback)
        )
      : renderState?.ready ||
        renderState?.relocated ||
        renderState?.rendered ||
        fallbackVisibleReady;
    if (!keepHidden && !skipStableSnapshot && mainRenditionHasVisiblePage()) {
      rememberStablePageSnapshot(renditionRef.current, "syncMainRendition");
    }
    if (!keepHidden && ready) {
      revealMainLayer("syncMainRendition", {
        renderState,
        skipPostRevealSamples,
      });
      clearVisibleTurnCoverAfterPaint("syncMainRendition");
    }
    debugEpubTurn("syncMainRendition", {
      ready,
      renderState,
      requireFullRender,
      allowContentFallback,
      fallbackVisibleReady,
      keepHidden,
      skipStableSnapshot,
      strictRenderWait,
      visibilityMode,
    });
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
      body.margin || "",
      body["max-width"] || "",
      body.width || "",
      body["column-gap"] || "",
      EPUB_READER_FONT_FAMILY,
      EPUB_READER_FRAME_GUTTER,
      EPUB_READER_PRESENTATION_MODE,
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
      "gap:0",
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
      wheelTurnDeltaRef.current = 0;
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
    if (previewBuildIdleCallbackRef.current && window.cancelIdleCallback) {
      window.cancelIdleCallback(previewBuildIdleCallbackRef.current);
      previewBuildIdleCallbackRef.current = null;
    }
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
      const cleanupBookThemeHook = registerReaderBookThemeHook(book);
      if (cleanupBookThemeHook) entry.cleanups.push(cleanupBookThemeHook);
      const rendition = book.renderTo(container, {
        width: `${width}px`,
        height: `${height}px`,
        flow: "paginated",
        spread: "none",
        gap: 0,
        minSpreadWidth: 999999,
        allowScriptedContent: false,
      });
      entry.book = book;
      entry.rendition = rendition;
      entry.container = container;

      registerReaderThemes(rendition);
      const cleanupThemeHook = registerReaderContentThemeHook(rendition);
      if (cleanupThemeHook) entry.cleanups.push(cleanupThemeHook);
      applyReaderTheme(rendition, readerThemeRef.current, fontSizeRef.current);
      const handlePreviewRendered = (_section, view) => {
        const contents = normalizeRenditionContents(view);
        applyReaderThemeToContents(
          contents,
          readerThemeRef.current,
          fontSizeRef.current
        );
        entry.contentsReady = true;
        entry.themeApplied = contentHasReaderTheme(
          contents,
          readerThemeRef.current,
          fontSizeRef.current
        );
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
      entry.annotationsReady = true;
      entry.themeApplied = applyReaderThemeToVisibleContents(
        rendition,
        readerThemeRef.current,
        fontSizeRef.current
      );
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
    if (!EPUB_BACKGROUND_PREVIEW_CACHE_ENABLED) return;
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

  function schedulePreviewRebuild(
    delay = PREVIEW_REBUILD_DEBOUNCE_MS,
    options = {}
  ) {
    if (!EPUB_BACKGROUND_PREVIEW_CACHE_ENABLED) {
      window.clearTimeout(previewBuildTimerRef.current);
      return;
    }
    window.clearTimeout(previewBuildTimerRef.current);
    if (previewBuildIdleCallbackRef.current && window.cancelIdleCallback) {
      window.cancelIdleCallback(previewBuildIdleCallbackRef.current);
      previewBuildIdleCallbackRef.current = null;
    }
    previewBuildTimerRef.current = window.setTimeout(() => {
      const runRebuild = () => {
        previewBuildIdleCallbackRef.current = null;
        rebuildPreviewCache();
      };
      if (options.idle && window.requestIdleCallback) {
        previewBuildIdleCallbackRef.current = window.requestIdleCallback(
          runRebuild,
          { timeout: options.idleTimeoutMs || 1400 }
        );
        return;
      }
      runRebuild();
    }, delay);
  }

  async function getPreviewForTurn(direction) {
    if (!EPUB_VISIBLE_TURN_PREVIEW_ENABLED) {
      logPreviewDebug("miss", {
        direction: directionName(direction),
        offset: directionOffset(direction),
        reason: "visiblePreviewDisabled",
      });
      return null;
    }
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
    debugEpubPaint("incomingAttach", {
      offset: entry.offset,
      status: entry.status,
      hasTheme: entry.themeApplied,
    });
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

  function setPageTurnDelta(nextDelta) {
    const normalized = Math.trunc(Number(nextDelta) || 0);
    pendingPageTurnDeltaRef.current = normalized;
    targetTurnDeltaRef.current = normalized;
  }

  function shouldUseCatchupTurn() {
    return Math.abs(targetTurnDeltaRef.current) >= PAGE_TURN_CATCHUP_THRESHOLD;
  }

  function clearFastTurnInputQuietTimer() {
    window.clearTimeout(fastTurnInputQuietTimerRef.current);
    fastTurnInputQuietTimerRef.current = null;
  }

  function cleanupFastTurnProbe(reason = "cleanup") {
    const probe = fastTurnProbeRef.current;
    fastTurnProbeRef.current = null;
    if (!probe) return;
    debugFastTurn("probeCleanup", {
      reason,
      baseCfi: probe.baseCfi,
      positionDelta: probe.positionDelta,
    });
    for (const cleanup of probe.cleanups || []) {
      try {
        cleanup();
      } catch {}
    }
    try {
      probe.rendition?.destroy?.();
    } catch {}
    try {
      probe.book?.destroy?.();
    } catch {}
    try {
      probe.container?.remove?.();
    } catch {}
  }

  async function createFastTurnProbe(baseCfi, layoutKey) {
    if (!baseCfi || !layoutKey || !epubArrayBufferRef.current) return null;
    const { width, height } = getPreviewSize();
    if (width < 160 || height < 160) return null;
    const container = createPreviewContainer(width, height);
    Object.assign(container.style, {
      opacity: "0",
      visibility: "hidden",
      pointerEvents: "none",
      zIndex: "-1",
      transform: "none",
      filter: "none",
    });
    const book = ePub(epubArrayBufferRef.current.slice(0), {
      openAs: "binary",
      replacements: "blobUrl",
    });
    const cleanups = [];
    const cleanupBookThemeHook = registerReaderBookThemeHook(book);
    if (cleanupBookThemeHook) cleanups.push(cleanupBookThemeHook);
    const rendition = book.renderTo(container, {
      width: `${width}px`,
      height: `${height}px`,
      flow: "paginated",
      spread: "none",
      gap: 0,
      minSpreadWidth: 999999,
      allowScriptedContent: false,
    });
    const cleanupThemeHook = registerReaderContentThemeHook(rendition);
    if (cleanupThemeHook) cleanups.push(cleanupThemeHook);
    registerReaderThemes(rendition);
    applyReaderTheme(rendition, readerThemeRef.current, fontSizeRef.current);
    const handleRendered = (_section, view) => {
      applyReaderThemeToContents(
        normalizeRenditionContents(view),
        readerThemeRef.current,
        fontSizeRef.current
      );
    };
    rendition.on?.("rendered", handleRendered);
    cleanups.push(() => rendition.off?.("rendered", handleRendered));
    const ready = await waitForPreviewRenditionSettle(rendition, () =>
      displayPreviewWithTimeout(rendition, baseCfi)
    );
    if (!ready) {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {}
      }
      try {
        rendition.destroy?.();
      } catch {}
      try {
        book.destroy?.();
      } catch {}
      try {
        container.remove?.();
      } catch {}
      return null;
    }
    applyReaderThemeToVisibleContents(
      rendition,
      readerThemeRef.current,
      fontSizeRef.current
    );
    const location = rendition.currentLocation?.() || null;
    return {
      baseCfi,
      layoutKey,
      book,
      rendition,
      container,
      cleanups,
      location,
      positionDelta: 0,
      direction: null,
    };
  }

  async function ensureFastTurnProbe(baseCfi, desiredDelta) {
    const layoutKey = makeLayoutKey();
    if (!layoutKey || !baseCfi || !desiredDelta) return null;
    const desiredDirection = Math.sign(desiredDelta);
    const existing = fastTurnProbeRef.current;
    const shouldRebuild =
      !existing ||
      existing.baseCfi !== baseCfi ||
      existing.layoutKey !== layoutKey ||
      (existing.direction && existing.direction !== desiredDirection) ||
      Math.abs(existing.positionDelta) > Math.abs(desiredDelta);
    if (shouldRebuild) cleanupFastTurnProbe("rebuild");
    if (!fastTurnProbeRef.current) {
      fastTurnProbeRef.current = await createFastTurnProbe(baseCfi, layoutKey);
      if (fastTurnProbeRef.current) {
        fastTurnProbeRef.current.direction = desiredDirection;
        debugFastTurn("catchupStart", {
          baseCfi,
          desiredDelta,
          layoutKey,
        });
      }
    }
    return fastTurnProbeRef.current;
  }

  async function resolveFastTurnTarget(baseCfi, desiredDelta) {
    const desiredDirection = Math.sign(desiredDelta);
    const targetSteps = Math.abs(desiredDelta);
    const probe = await ensureFastTurnProbe(baseCfi, desiredDelta);
    if (!probe || !desiredDirection || !targetSteps) return null;
    let boundaryHit = false;

    while (Math.abs(probe.positionDelta) < targetSteps) {
      const beforeCfi = probe.location?.start?.cfi || null;
      const ready = await waitForPreviewRenditionSettle(probe.rendition, () =>
        desiredDirection > 0
          ? probe.rendition.next?.()
          : probe.rendition.prev?.()
      );
      if (!ready) {
        debugFastTurn("probeStepFailed", {
          desiredDelta,
          positionDelta: probe.positionDelta,
        });
        return null;
      }
      applyReaderThemeToVisibleContents(
        probe.rendition,
        readerThemeRef.current,
        fontSizeRef.current
      );
      probe.location = probe.rendition.currentLocation?.() || probe.location;
      const afterCfi = probe.location?.start?.cfi || null;
      if (!afterCfi || afterCfi === beforeCfi) {
        boundaryHit = true;
        debugFastTurn("boundaryHit", {
          desiredDelta,
          positionDelta: probe.positionDelta,
          beforeCfi,
          afterCfi,
        });
        break;
      }
      probe.positionDelta += desiredDirection;
      debugFastTurn("probeStep", {
        desiredDelta,
        positionDelta: probe.positionDelta,
        cfi: afterCfi,
      });
      await wait(0);
    }

    const targetCfi = probe.location?.start?.cfi || null;
    if (!targetCfi || probe.positionDelta === 0) return null;
    debugFastTurn("probeTargetCfi", {
      desiredDelta,
      movedDelta: probe.positionDelta,
      boundaryHit,
      targetCfi,
    });
    return {
      cfi: targetCfi,
      movedDelta: probe.positionDelta,
      boundaryHit,
      direction: desiredDirection > 0 ? "next" : "prev",
    };
  }

  function scheduleFastCatchupCommit(reason = "input") {
    if (!fastTurnCatchupActiveRef.current) return;
    clearFastTurnInputQuietTimer();
    fastTurnInputQuietTimerRef.current = window.setTimeout(() => {
      runFastCatchupCommit(reason);
    }, PAGE_TURN_CATCHUP_INPUT_QUIET_MS);
  }

  function deactivateFastCatchup(reason = "idle") {
    clearFastTurnInputQuietTimer();
    fastTurnCatchupActiveRef.current = false;
    fastTurnProbeInFlightRef.current = false;
    cleanupFastTurnProbe(reason);
  }

  async function runFastCatchupCommit(reason = "quiet") {
    if (!fastTurnCatchupActiveRef.current) return;
    const quietFor = performance.now() - fastTurnLastInputAtRef.current;
    if (quietFor < PAGE_TURN_CATCHUP_INPUT_QUIET_MS) {
      scheduleFastCatchupCommit(reason);
      return;
    }
    if (turnInFlightRef.current || pageTurnDrainActiveRef.current) {
      scheduleFastCatchupCommit("waitingForMainTurn");
      return;
    }
    const desiredDelta = targetTurnDeltaRef.current;
    if (!desiredDelta) {
      deactivateFastCatchup("empty");
      schedulePreviewRebuild(0);
      debugFastTurn("catchupIdle", { reason });
      return;
    }
    const baseCfi = currentBaseCfi();
    if (!baseCfi) {
      debugFastTurn("fallbackSequential", {
        reason: "missingBaseCfi",
        desiredDelta,
      });
      deactivateFastCatchup("missingBaseCfi");
      fastTurnBurstRef.current = true;
      drainPageTurnQueue("slide-stack");
      return;
    }

    fastTurnProbeInFlightRef.current = true;
    const startedAt = performance.now();
    const target = await resolveFastTurnTarget(baseCfi, desiredDelta);
    fastTurnProbeInFlightRef.current = false;
    if (!fastTurnCatchupActiveRef.current) return;
    if (targetTurnDeltaRef.current !== desiredDelta) {
      scheduleFastCatchupCommit("targetChanged");
      return;
    }
    if (!target?.cfi || !target.movedDelta) {
      debugFastTurn("fallbackSequential", {
        reason: "probeFailed",
        desiredDelta,
      });
      deactivateFastCatchup("probeFailed");
      fastTurnBurstRef.current = true;
      drainPageTurnQueue("slide-stack");
      return;
    }

    const id = `${Date.now()}-catchup-${target.direction}`;
    turnInFlightRef.current = true;
    activePageTurnIdRef.current = id;
    clearPageTurnRecoveryTimers();
    startEpubPaintTrace({
      id,
      direction: target.direction,
      mode: "fast-catchup",
    });
    debugFastTurn("catchupCommit", {
      id,
      reason,
      desiredDelta,
      movedDelta: target.movedDelta,
      remainingDelta: targetTurnDeltaRef.current - target.movedDelta,
      targetCfi: target.cfi,
      probeMs: Math.round(performance.now() - startedAt),
    });

    let mainReady = false;
    let finalized = false;
    try {
      mainReady = await syncMainRendition(
        () => renditionRef.current?.display?.(target.cfi),
        {
          allowContentFallback: true,
          hideBefore: true,
          keepHidden: true,
          requireFullRender: true,
          skipStableSnapshot: true,
          strictRenderWait: true,
          skipPostRevealSamples: true,
        }
      );
      finalized =
        mainReady &&
        (await finalizeTurnToMainLayer("fastCatchupCommit", {
          id,
          direction: target.direction,
          updatePreview: false,
          deferPreviewRebuild: true,
        }));
      if (!finalized) {
        abandonTurnToStableSnapshot("fastCatchupCommitFailed", {
          id,
          deferPreviewRebuild: true,
        });
      }
    } catch {
      abandonTurnToStableSnapshot("fastCatchupCommitError", {
        id,
        deferPreviewRebuild: true,
      });
    }

    cleanupFastTurnProbe("committed");
    if (!finalized) {
      debugFastTurn("fallbackSequential", {
        reason: "commitFailed",
        desiredDelta,
      });
      fastTurnCatchupActiveRef.current = false;
      fastTurnBurstRef.current = true;
      drainPageTurnQueue("slide-stack");
      return;
    }
    const remainingDelta = targetTurnDeltaRef.current - target.movedDelta;
    const boundedRemainingDelta =
      target.boundaryHit &&
      remainingDelta &&
      Math.sign(remainingDelta) === Math.sign(target.movedDelta)
        ? 0
        : remainingDelta;
    setPageTurnDelta(boundedRemainingDelta);
    if (targetTurnDeltaRef.current) {
      if (shouldUseCatchupTurn()) {
        scheduleFastCatchupCommit("remainingDelta");
      } else {
        fastTurnCatchupActiveRef.current = false;
        fastTurnBurstRef.current = true;
        drainPageTurnQueue("slide-stack");
      }
    } else {
      fastTurnCatchupActiveRef.current = false;
      fastTurnBurstRef.current = false;
      schedulePreviewRebuild(0);
      debugFastTurn("catchupIdle", { reason: "committed" });
    }
  }

  function schedulePageTurnRecoveryWatchdogs({
    id,
    direction,
    getMainReady,
    markMainReady,
    deferPreviewRebuild = false,
    onComplete = null,
  }) {
    clearPageTurnRecoveryTimers();
    const finalDelay =
      PAGE_TURN_WATCHDOG_DELAYS_MS[PAGE_TURN_WATCHDOG_DELAYS_MS.length - 1];

    const runWatchdog = async (delayMs, finalize = false) => {
      if (activePageTurnIdRef.current !== id) return;

      let ready = Boolean(getMainReady?.());
      debugEpubTurn("watchdog-start", {
        id,
        direction,
        delayMs,
        finalize,
        ready,
      });

      if (!ready) {
        ready = await waitForStableMainLayout(delayMs >= 900 ? 900 : 220, {
          updateStableSnapshot: false,
        });
      } else {
        ready =
          (await waitForStableMainLayout(delayMs >= 900 ? 700 : 180, {
            updateStableSnapshot: false,
          })) || mainRenditionHasVisiblePage();
      }

      if (!ready) {
        debugEpubTurn("watchdog-hidden", {
          id,
          direction,
          delayMs,
          finalize,
        });
        if (finalize) {
          abandonTurnToStableSnapshot(`watchdog:${delayMs}:hidden`, {
            id,
            deferPreviewRebuild,
          });
          onComplete?.(false);
        }
        return;
      }

      markMainReady?.();

      const finalized = await finalizeTurnToMainLayer(
        `watchdog:${delayMs}:settled`,
        {
          id,
          direction,
          updatePreview: true,
          deferPreviewRebuild,
        }
      );
      if (!finalized) {
        if (finalize) {
          abandonTurnToStableSnapshot(`watchdog:${delayMs}:finalize-miss`, {
            id,
            deferPreviewRebuild,
          });
          onComplete?.(false);
        }
        return;
      }

      debugEpubTurn("watchdog-complete", {
        id,
        direction,
        delayMs,
        finalize,
      });
      onComplete?.(true);
    };

    const [firstDelay, ...remainingDelays] = PAGE_TURN_WATCHDOG_DELAYS_MS;
    pageTurnTimerRef.current = window.setTimeout(
      () => runWatchdog(firstDelay, firstDelay === finalDelay),
      firstDelay
    );
    pageTurnWatchdogTimersRef.current = remainingDelays.map((delayMs) =>
      window.setTimeout(
        () => runWatchdog(delayMs, delayMs === finalDelay),
        delayMs
      )
    );
  }

  function handleReaderPointerDown() {
    focusReaderShell();
  }

  function queuedPageTurnCount() {
    return Math.abs(targetTurnDeltaRef.current);
  }

  function enqueuePageTurn(direction, options = {}) {
    const { source = "unknown", count = 1, mode = "slide-stack" } = options;
    const turnDirection = directionName(direction);
    const sign = turnDirection === "next" ? 1 : -1;
    let accepted = 0;
    let cancelled = 0;
    let dropped = 0;
    let nextDelta = targetTurnDeltaRef.current;
    const requestedCount = Math.max(1, Math.floor(Number(count) || 1));

    for (let index = 0; index < requestedCount; index += 1) {
      if (nextDelta && Math.sign(nextDelta) !== sign) {
        nextDelta += sign;
        cancelled += 1;
        continue;
      }
      if (Math.abs(nextDelta) >= PAGE_TURN_CATCHUP_LIMIT) {
        dropped += 1;
        continue;
      }
      nextDelta += sign;
      accepted += 1;
    }

    setPageTurnDelta(nextDelta);
    fastTurnLastInputAtRef.current = performance.now();
    if (
      accepted > 0 &&
      (pageTurnDrainActiveRef.current ||
        Math.abs(nextDelta) > 1 ||
        requestedCount > 1)
    ) {
      fastTurnBurstRef.current = true;
    }
    debugFastTurn("enqueue", {
      source,
      mode,
      direction: turnDirection,
      requestedCount,
      accepted,
      cancelled,
      dropped,
      queueLength: queuedPageTurnCount(),
    });
    if (Math.abs(nextDelta) >= PAGE_TURN_CATCHUP_THRESHOLD) {
      fastTurnCatchupActiveRef.current = true;
      fastTurnBurstRef.current = true;
      scheduleFastCatchupCommit(source);
      debugFastTurn("catchupQueued", {
        source,
        direction: turnDirection,
        targetDelta: nextDelta,
      });
      return accepted;
    }
    if (fastTurnCatchupActiveRef.current) {
      scheduleFastCatchupCommit(source);
      return accepted;
    }
    drainPageTurnQueue(mode);
    return accepted;
  }

  function dequeuePageTurn() {
    const delta = targetTurnDeltaRef.current;
    if (!delta) return null;
    if (delta > 0) {
      setPageTurnDelta(delta - 1);
      return "next";
    }
    setPageTurnDelta(delta + 1);
    return "prev";
  }

  async function drainPageTurnQueue(mode = "slide-stack") {
    if (fastTurnCatchupActiveRef.current && targetTurnDeltaRef.current) {
      scheduleFastCatchupCommit("drainPaused");
      debugFastTurn("drain-paused-for-catchup", { mode });
      return;
    }
    if (pageTurnDrainActiveRef.current) return;
    pageTurnDrainActiveRef.current = true;
    debugFastTurn("drain-start", { mode });
    try {
      while (targetTurnDeltaRef.current && renditionRef.current) {
        if (fastTurnCatchupActiveRef.current) {
          debugFastTurn("drain-paused-for-catchup", { mode });
          break;
        }
        const turnDirection = dequeuePageTurn();
        if (!turnDirection) break;
        const queueAfterDequeue = queuedPageTurnCount();
        const fastMode = fastTurnBurstRef.current || queueAfterDequeue > 0;
        const startedAt = performance.now();
        debugFastTurn("dequeue", {
          direction: turnDirection,
          queueAfterDequeue,
          fastMode,
        });
        const completed = await performQueuedPageTurn(turnDirection, {
          mode,
          fastMode,
        });
        debugFastTurn("page-complete", {
          direction: turnDirection,
          completed,
          fastMode,
          durationMs: Math.round(performance.now() - startedAt),
          remainingQueue: queuedPageTurnCount(),
        });
        if (!completed) {
          setPageTurnDelta(0);
          break;
        }
        if (
          fastTurnCatchupActiveRef.current ||
          Math.abs(targetTurnDeltaRef.current) >= PAGE_TURN_CATCHUP_THRESHOLD
        ) {
          fastTurnCatchupActiveRef.current = true;
          scheduleFastCatchupCommit("drainThreshold");
          debugFastTurn("drain-threshold-catchup", {
            mode,
            targetDelta: targetTurnDeltaRef.current,
          });
          break;
        }
        if (queuedPageTurnCount()) await wait(fastMode ? 8 : 20);
      }
    } finally {
      pageTurnDrainActiveRef.current = false;
      if (targetTurnDeltaRef.current) {
        if (fastTurnCatchupActiveRef.current) {
          scheduleFastCatchupCommit("drainFinally");
        } else {
          window.setTimeout(() => drainPageTurnQueue(mode), 0);
        }
      } else {
        fastTurnBurstRef.current = false;
        schedulePreviewRebuild(0);
        debugFastTurn("drain-idle", { mode });
      }
    }
  }

  function requestPageTurn(direction, mode = "slide-stack", options = {}) {
    return enqueuePageTurn(direction, { mode, ...options });
  }

  async function performQueuedPageTurn(direction, options = {}) {
    const { mode = "slide-stack", fastMode = false } = options;
    const turnDirection = directionName(direction);
    const rendition = renditionRef.current;
    if (!rendition || turnInFlightRef.current) return false;
    const now = Date.now();
    turnInFlightRef.current = true;
    const id = `${now}-${turnDirection}-${mode}-${fastMode ? "fast" : "normal"}`;
    activePageTurnIdRef.current = id;
    clearPageTurnRecoveryTimers();
    startEpubPaintTrace({ id, direction: turnDirection, mode });
    debugEpubTurn("turn-start", {
      id,
      direction: turnDirection,
      mode,
      fastMode,
    });
    let previewEntry = null;
    let mainReady = false;
    let hasPreview = false;
    return new Promise((resolve) => {
      let settled = false;
      const complete = (value) => {
        if (settled) return;
        settled = true;
        resolve(Boolean(value));
      };

      const runTurn = async () => {
        try {
          const fastFinalize = async (reason) => {
            if (!fastMode || !mainReady) return false;
            return finalizeTurnToMainLayer(reason, {
              id,
              direction: turnDirection,
              updatePreview: true,
              deferPreviewRebuild: true,
            });
          };

          previewEntry =
            EPUB_VISIBLE_TURN_PREVIEW_ENABLED &&
            !fastMode &&
            mode === "slide-stack"
              ? await getPreviewForTurn(turnDirection)
              : null;
          if (
            mainRenditionHasVisiblePage() &&
            (!fastMode || !EPUB_VISIBLE_TURN_PREVIEW_ENABLED)
          ) {
            rememberStablePageSnapshot(renditionRef.current, "turn-start-main");
          }
          hasPreview = attachIncomingPreview(previewEntry);
          if (!hasPreview && incomingLayerRef.current) {
            incomingLayerRef.current.innerHTML = "";
            logPreviewDebug("fallback", {
              direction: turnDirection,
              reason: "previewNotReady",
            });
            debugEpubTurn("preview-fallback", {
              id,
              direction: turnDirection,
              reason: "previewNotReady",
            });
          }
          debugEpubTurn("preview-state", {
            id,
            direction: turnDirection,
            hasPreview,
            previewStatus: previewEntry?.status || null,
            fastMode,
          });
          const targetCfi = previewEntry?.location?.start?.cfi || null;
          const turnMainPage = () =>
            hasPreview && targetCfi
              ? rendition.display?.(targetCfi)
              : turnDirection === "next"
                ? rendition.next?.()
                : rendition.prev?.();
          const shouldHideMainBeforeSync = true;
          if (prefersReducedMotion()) {
            mainReady = await syncMainRendition(() => turnMainPage(), {
              allowContentFallback: true,
              hideBefore: shouldHideMainBeforeSync,
              keepHidden: true,
              requireFullRender: true,
              skipStableSnapshot: fastMode,
              strictRenderWait: true,
              skipPostRevealSamples: fastMode,
            });
            if (
              mainReady &&
              (await waitForStableMainLayout(700, {
                updateStableSnapshot: false,
              }))
            ) {
              const finalized = await finalizeTurnToMainLayer(
                "reducedMotionTurn",
                {
                  id,
                  direction: turnDirection,
                  updatePreview: true,
                  deferPreviewRebuild: true,
                }
              );
              complete(finalized);
            }
            return;
          }
          if (hasPreview) {
            setTurnAnimation({
              id,
              direction: turnDirection,
              mode: "slide-stack",
            });
            await wait(
              fastMode ? PAGE_TURN_FAST_ANIMATION_MS : PAGE_TURN_ANIMATION_MS
            );
          } else {
            setTurnAnimation(null);
            debugEpubTurn("main-only-turn", {
              id,
              direction: turnDirection,
              fastMode,
            });
          }
          mainReady = await syncMainRendition(() => turnMainPage(), {
            allowContentFallback: true,
            hideBefore: shouldHideMainBeforeSync,
            keepHidden: true,
            requireFullRender: true,
            skipStableSnapshot: fastMode,
            strictRenderWait: true,
            skipPostRevealSamples: fastMode,
          });
          if (await fastFinalize("fastQueuedTurn")) {
            complete(true);
          }
        } finally {
          if (activePageTurnIdRef.current === id && !settled) {
            schedulePageTurnRecoveryWatchdogs({
              id,
              direction: turnDirection,
              getMainReady: () => mainReady,
              markMainReady: () => {
                mainReady = true;
              },
              deferPreviewRebuild: true,
              onComplete: complete,
            });
          } else if (!settled) {
            complete(false);
          }
        }
      };

      runTurn().catch(() => {
        if (activePageTurnIdRef.current === id) {
          abandonTurnToStableSnapshot("turn-error", {
            id,
            deferPreviewRebuild: true,
          });
        }
        complete(false);
      });
    });
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
    const previousDelta = wheelTurnDeltaRef.current;
    const nextDelta =
      previousDelta && Math.sign(previousDelta) !== Math.sign(deltaX)
        ? deltaX
        : previousDelta + deltaX;
    const turnCount = Math.min(
      PAGE_TURN_WHEEL_BURST_LIMIT,
      Math.floor(Math.abs(nextDelta) / HORIZONTAL_WHEEL_THRESHOLD)
    );
    if (!turnCount) {
      wheelTurnDeltaRef.current = nextDelta;
      return;
    }
    const consumedDelta =
      Math.sign(nextDelta) * turnCount * HORIZONTAL_WHEEL_THRESHOLD;
    wheelTurnDeltaRef.current = nextDelta - consumedDelta;
    requestPageTurn(deltaX > 0 ? "next" : "prev", "slide-stack", {
      source: "wheel",
      count: turnCount,
    });
  }

  function handleReaderKeyDown(event) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      requestPageTurn("next", "slide-stack", {
        source: event.repeat ? "key-repeat" : "key",
      });
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      requestPageTurn("prev", "slide-stack", {
        source: event.repeat ? "key-repeat" : "key",
      });
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
      recoverVisibleMainLayer("jumpToSource");
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
    let cleanupBookThemeHook = null;
    let cleanupThemeHook = null;
    setLoading(true);
    mainPaintReadyRef.current = false;
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
        cleanupBookThemeHook = registerReaderBookThemeHook(book);
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
          gap: 0,
          minSpreadWidth: 999999,
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;

        registerReaderThemes(rendition);
        cleanupThemeHook = registerReaderContentThemeHook(rendition);
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
          if (chapterJumpInFlightRef.current) {
            schedulePreviewRebuild(CHAPTER_PREVIEW_REBUILD_DELAY_MS, {
              idle: true,
            });
          } else {
            schedulePreviewRebuild();
          }
        };

        handleRendered = (_section, view) => {
          const contents = normalizeRenditionContents(view);
          const hasPendingMainRender = Boolean(mainRenderWaitRef.current);
          const themeReady = contentHasReaderThemeMarker(contents);
          const canRepairThemeBeforeVisible =
            !themeReady &&
            (hasPendingMainRender ||
              Boolean(activePageTurnIdRef.current) ||
              !mainPaintReadyRef.current);
          if (themeReady) {
            debugEpubPaint("themeContentReady", { source: "mainRendered" });
          } else if (canRepairThemeBeforeVisible) {
            ensureReaderThemeStyle(
              contents?.document,
              readerThemeRef.current,
              fontSizeRef.current,
              { source: "mainRendered" }
            );
          } else {
            debugEpubPaint("visibleThemeRepairSkipped", {
              source: "mainRendered",
              hasPendingMainRender,
              activeTurnId: activePageTurnIdRef.current,
              mainPaintReady: mainPaintReadyRef.current,
            });
          }
          wireContentInteractions(contents);
          syncAnnotations();
          resolveMainRenderWait("rendered");
          if (
            !hasPendingMainRender &&
            !chapterJumpInFlightRef.current &&
            !activePageTurnIdRef.current &&
            !mainPaintReadyRef.current &&
            mainRenditionHasVisiblePage(rendition)
          ) {
            rememberStablePageSnapshot(rendition, "rendered");
            revealMainLayer("rendered");
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
        mainPaintReadyRef.current = false;
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
        if (initialReady) revealMainLayer("initialDisplay");
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
      activePageTurnIdRef.current = null;
      chapterJumpInFlightRef.current = false;
      setPageTurnDelta(0);
      pageTurnDrainActiveRef.current = false;
      fastTurnBurstRef.current = false;
      fastTurnCatchupActiveRef.current = false;
      fastTurnProbeInFlightRef.current = false;
      wheelTurnDeltaRef.current = 0;
      clearFastTurnInputQuietTimer();
      cleanupFastTurnProbe("unmount");
      clearPageTurnRecoveryTimers();
      clearVisibleTurnCover("unmount");
      try {
        if (rendition && handleSelected)
          rendition.off("selected", handleSelected);
        if (rendition && handleRelocated)
          rendition.off("relocated", handleRelocated);
        if (rendition && handleRendered)
          rendition.off("rendered", handleRendered);
      } catch {}
      cleanupThemeHook?.();
      cleanupBookThemeHook?.();
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
          .then(() => {
            recoverVisibleMainLayer("themeChanged");
            schedulePreviewRebuild();
          })
          .catch(() => schedulePreviewRebuild());
      }, 80);
    } else {
      revealMainLayer("themeChangedNoCurrentCfi");
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
                .then(() => {
                  recoverVisibleMainLayer("resize");
                  schedulePreviewRebuild();
                })
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
            .then(() => {
              recoverVisibleMainLayer("fontSizeChanged");
              schedulePreviewRebuild();
            })
            .catch(() => schedulePreviewRebuild());
        }, 80);
      } else {
        revealMainLayer("fontSizeChangedNoCurrentCfi");
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
    const chapterJumpId = chapterJumpSeqRef.current + 1;
    chapterJumpSeqRef.current = chapterJumpId;
    const startedAt = performance.now();
    epubChapterTraceRef.current = [];
    chapterJumpInFlightRef.current = true;
    debugEpubChapter("chapterJumpStart", { id: chapterJumpId, href });
    setTocOpen(false);
    try {
      const ready = await syncMainRendition(
        () => renditionRef.current?.display?.(href),
        {
          hideBefore: false,
          keepHidden: true,
          requireFullRender: true,
          skipStableSnapshot: true,
          visibilityMode: "chapter",
        }
      );
      if (chapterJumpSeqRef.current !== chapterJumpId) return;
      const chapterSnapshot =
        mainRenditionChapterContentSnapshot() ||
        (await waitForMainChapterContent(900));
      if (chapterJumpSeqRef.current !== chapterJumpId) return;
      debugEpubChapter("chapterJumpReady", {
        id: chapterJumpId,
        href,
        ready,
        elapsedMs: Math.round(performance.now() - startedAt),
        snapshot: chapterSnapshot,
        skippedStableSnapshot: true,
      });
      if (chapterSnapshot) {
        revealMainLayer("selectToc", {
          mode: "chapter",
          skipPostRevealSamples: true,
        });
        debugEpubChapter("chapterMainReveal", {
          id: chapterJumpId,
          href,
          elapsedMs: Math.round(performance.now() - startedAt),
          ready,
        });
      } else {
        debugEpubChapter("chapterJumpNoVisibleContent", {
          id: chapterJumpId,
          href,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      }
      schedulePreviewRebuild(CHAPTER_PREVIEW_REBUILD_DELAY_MS, {
        idle: true,
      });
      debugEpubChapter("chapterPreviewRebuildScheduled", {
        id: chapterJumpId,
        href,
        delayMs: CHAPTER_PREVIEW_REBUILD_DELAY_MS,
        idle: true,
      });
    } finally {
      if (chapterJumpSeqRef.current === chapterJumpId) {
        chapterJumpInFlightRef.current = false;
        debugEpubChapter("chapterJumpComplete", {
          id: chapterJumpId,
          href,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      }
    }
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
    window.__anythingllmEpubDebug = {
      snapshot: epubDebugSnapshot,
      visible: () => mainRenditionHasVisiblePage(),
      stable: (timeoutMs = 700) => waitForStableMainLayout(timeoutMs),
      lastTurnTrace: () => epubPaintTraceRef.current,
      lastChapterTrace: () => epubChapterTraceRef.current,
      lastFastTurnTrace: () => fastTurnTraceRef.current,
      queuedTurns: () => ({
        pendingDelta: pendingPageTurnDeltaRef.current,
        targetDelta: targetTurnDeltaRef.current,
        queueLength: queuedPageTurnCount(),
        catchupActive: fastTurnCatchupActiveRef.current,
        probeInFlight: fastTurnProbeInFlightRef.current,
        drainActive: pageTurnDrainActiveRef.current,
        turnInFlight: turnInFlightRef.current,
      }),
    };
    return () => {
      if (window.__anythingllmEpubDebug?.snapshot === epubDebugSnapshot) {
        delete window.__anythingllmEpubDebug;
      }
    };
  });

  useEffect(() => {
    return () => {
      window.clearTimeout(wheelGestureTimerRef.current);
      activePageTurnIdRef.current = null;
      chapterJumpInFlightRef.current = false;
      setPageTurnDelta(0);
      pageTurnDrainActiveRef.current = false;
      fastTurnBurstRef.current = false;
      fastTurnCatchupActiveRef.current = false;
      fastTurnProbeInFlightRef.current = false;
      wheelTurnDeltaRef.current = 0;
      clearFastTurnInputQuietTimer();
      cleanupFastTurnProbe("unmount");
      clearPageTurnRecoveryTimers();
      clearVisibleTurnCover("unmount");
      for (const timer of postRevealPaintTimersRef.current) {
        window.clearTimeout(timer);
      }
      postRevealPaintTimersRef.current = [];
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
  const mainLayerVisible = !mainLayerSuppressed && mainPaintReady;
  const readerFrameVariables = readerThemeVariableMap(readerTheme, fontSize);

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
            onClick={() =>
              requestPageTurn("prev", "slide-stack", { source: "click" })
            }
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
            onClick={() =>
              requestPageTurn("next", "slide-stack", { source: "click" })
            }
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
            "--anythingllm-epub-frame-gutter": EPUB_READER_FRAME_GUTTER,
            ...readerFrameVariables,
            ...activeTurnStyle,
          }}
        >
          <div
            className={`epub-reader-content-frame pointer-events-none absolute z-0 overflow-hidden ${activeTheme.pageClassName}`}
            aria-hidden="true"
          >
            {stableSnapshot?.html && (
              <div
                className="h-full w-full overflow-hidden"
                style={{
                  background: "var(--anythingllm-epub-background)",
                  color: "var(--anythingllm-epub-color)",
                }}
                dangerouslySetInnerHTML={{
                  __html: `${
                    stableSnapshot.contentStyleText
                      ? `<style>${stableSnapshot.contentStyleText}</style>`
                      : ""
                  }${stableSnapshot.html}`,
                }}
              />
            )}
          </div>
          <div
            ref={incomingLayerRef}
            className={`epub-reader-content-frame epub-page-transition-layer epub-page-incoming pointer-events-none absolute z-[5] overflow-hidden ${activeTheme.pageClassName}`}
            data-turn-mode={activeTurn?.mode || undefined}
            data-turn-direction={activeTurn?.direction || undefined}
            data-turn-phase={activeTurn?.phase || undefined}
          />
          <div
            ref={turnCoverLayerRef}
            className={`epub-reader-content-frame epub-turn-cover-layer pointer-events-none absolute z-[8] overflow-hidden ${activeTheme.pageClassName}`}
            aria-hidden="true"
          />
          <div
            ref={outgoingLayerRef}
            className={`epub-reader-content-frame epub-page-transition-layer epub-page-outgoing absolute z-10 overflow-hidden ${
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
        .epub-reader-content-frame {
          top: 0;
          bottom: 0;
          left: var(--anythingllm-epub-frame-gutter);
          right: var(--anythingllm-epub-frame-gutter);
          min-width: 0;
        }
        .epub-page-transition-layer {
          will-change: transform, filter, opacity;
          transform: translateZ(0);
        }
        .epub-page-outgoing {
          transition: none !important;
        }
        .epub-turn-cover-layer {
          opacity: 0;
          visibility: hidden;
          transform: translateZ(0);
        }
        .epub-turn-cover-layer:not(:empty) {
          opacity: 1;
          visibility: visible;
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
