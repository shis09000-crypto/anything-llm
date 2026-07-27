import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  useReducer,
  forwardRef,
  memo,
  useCallback,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import HistoricalMessage from "./HistoricalMessage";
import AssistantTurn from "./AssistantTurn";
import { useManageWorkspaceModal } from "../../../Modals/ManageWorkspace";
import ManageWorkspace from "../../../Modals/ManageWorkspace";
import { ArrowDown } from "@phosphor-icons/react";
import debounce from "lodash.debounce";
import Workspace from "@/models/workspace";
import { useNavigate, useParams } from "react-router-dom";
import paths from "@/utils/paths";
import Appearance from "@/models/appearance";
import useTextSize from "@/hooks/useTextSize";
import useChatHistoryScrollHandle from "@/hooks/useChatHistoryScrollHandle";
import { ThoughtExpansionProvider } from "./ThoughtContainer";
import { DELETE_EVENT, MessageActionsProvider } from "./MessageActionsContext";
import { useChatThreadDrafts } from "@/contexts/ChatThreadDraftProvider";
import { debugChatTurn } from "@/utils/chat/debug";
import {
  CHAT_SCROLL_BOTTOM_TOLERANCE_PX,
  CHAT_SCROLL_PROGRAMMATIC_SUPPRESS_MS,
  CHAT_SCROLL_SMOOTH_SUPPRESS_MS,
  clearSavedChatScrollPosition,
  getChatScrollIntent,
  hasRecentChatUserScrollIntent,
  isExplicitChatScrollNavigationIntent,
  markChatUserScrollIntent,
  markProgrammaticChatScroll,
} from "@/utils/chat/chatScrollIntent";
import {
  chatBottomScrollBehavior,
  cancelChatRestoreRun,
  createChatScrollPositionSnapshot,
  isChatRestoreRunCurrent,
  normalizeChatScrollPosition,
  savedChatScrollTopFallback,
  shouldBlockChatScrollPersistenceForLayoutTransition,
  shouldBypassAutoScrollSuppressForSendFollow,
  shouldIgnorePersistedChatScrollMemory,
  shouldPreserveParkedChatAnchor,
  shouldRestoreExplicitPrepend,
  shouldSkipChatRestoreForLayoutTransition,
  startChatRestoreRun,
  tailCleanupFollowDecision,
  tailHydrationFollowDecision,
} from "@/utils/chat/chatScrollPosition";
import {
  createChatScrollMemorySnapshot,
  readChatScrollMemory,
  textFingerprint,
  writeChatScrollBottomMemory,
  writeChatScrollMemory,
} from "@/utils/chat/chatScrollMemory";
import {
  chatScrollReducer,
  initialChatScrollState,
} from "@/utils/chat/chatScrollCoordinator";
import { mobileShellRuntimeActive } from "@/utils/mobileRuntime";

const CHAT_LAYOUT_OVERLAP_TOLERANCE_PX = -2;
const CHAT_LAYOUT_MIN_ROW_HEIGHT_PX = 4;
const CHAT_LAYOUT_FALLBACK_AFTER_RECOVERIES = 2;
const CHAT_LAYOUT_SELF_CHECK_INTERVAL_MS = 1500;
const CHAT_SCROLL_LAYOUT_SUPPRESS_MS = 1200;
const CHAT_SCROLL_LAYOUT_MIN_SETTLE_MS = 700;
const CHAT_SEND_FOLLOW_STICK_MS = 2500;
const CHAT_SCROLL_RESTORE_SETTLE_SUPPRESS_MS = 2600;
const CHAT_SCROLL_RESTORE_SETTLE_DELAYS_MS = [
  80, 180, 360, 700, 1200, 1800, 2400, 3600, 5200, 7600,
];
const CHAT_SCROLL_MEMORY_HEARTBEAT_MS = 1500;
const CHAT_SCROLL_RESTORE_SESSION_MS = 8000;

function recordChatScrollMemoryEvent(event = {}) {
  if (typeof window === "undefined") return;
  try {
    const events = Array.isArray(window.__chatScrollMemoryDebugEvents)
      ? window.__chatScrollMemoryDebugEvents
      : [];
    events.push({ ...event, at: Date.now() });
    window.__chatScrollMemoryDebugEvents = events.slice(-80);
  } catch {
    // Debug storage must never interfere with scroll memory.
  }
}

export default forwardRef(function (
  {
    items = [],
    workspace,
    regenerateAssistantMessage,
    chatKey = null,
    approvalState = null,
    onToolApprovalResponse,
    onGenerateMindMap,
    readOnly = false,
    activeThreadSlug = undefined,
    hasMoreHistory = false,
    isLoadingOlderHistory = false,
    onLoadOlderHistory = null,
    contentClassName = "",
    bottomInset = null,
    sendScrollRequest = 0,
    tailHydrationSignal = null,
    tailCleanupSignal = null,
    layoutTransitionSignal = null,
    chatScrollMemory = null,
  },
  ref
) {
  const lastScrollTopRef = useRef(0);
  const scrollPositionsRef = useRef({});
  const suppressAutoScrollRef = useRef(false);
  const shouldFollowOutputRef = useRef(true);
  const programmaticScrollRef = useRef({ reason: null, until: 0 });
  const programmaticScrollGenerationRef = useRef(0);
  const userScrollIntentRef = useRef({ source: null, at: 0 });
  const prependRestoreRequestRef = useRef(null);
  const parkedAnchorRef = useRef(null);
  const lastTailHydrationKeyRef = useRef(null);
  const lastTailCleanupKeyRef = useRef(null);
  const lastScrollMemoryRestoreKeyRef = useRef(null);
  const lastScrollMemoryHeartbeatRef = useRef({ signature: null });
  const scrollRestoreSessionRef = useRef({
    active: false,
    anchor: null,
    until: 0,
  });
  const chatRestoreRunRef = useRef({ active: false, generation: 0 });
  const chatRestoreHandlesRef = useRef({
    frames: [],
    timeouts: [],
    observers: [],
  });
  const persistScrollMemoryRef = useRef(() => null);
  const sendFollowRef = useRef({
    active: false,
    request: 0,
    generation: 0,
    startedAt: 0,
    settleUntil: 0,
  });
  const bottomStickHandlesRef = useRef({ frames: [], timeouts: [] });
  const layoutTransitionRef = useRef({
    active: false,
    seq: 0,
    reason: null,
    anchor: null,
    isAtBottom: false,
    firstItemId: null,
    lastItemId: null,
    scrollTop: 0,
    startedAt: 0,
  });
  const layoutTransitionHandlesRef = useRef({
    frames: [],
    timeouts: [],
    observer: null,
  });
  const lastLayoutTransitionSignalSeqRef = useRef(null);
  const olderLoadPendingRef = useRef(false);
  const chatHistoryRef = useRef(null);
  const previousFirstItemIdRef = useRef(null);
  const layoutCheckFrameRef = useRef(null);
  const layoutCheckSettleFrameRef = useRef(null);
  const layoutRecoveryPassesRef = useRef(0);
  const itemsRef = useRef(items);
  const previousItemsLengthRef = useRef(items.length);
  itemsRef.current = items;
  const { threadSlug = null } = useParams();
  const effectiveThreadSlug =
    activeThreadSlug === undefined ? threadSlug : activeThreadSlug;
  const navigate = useNavigate();
  const { showing, hideModal } = useManageWorkspaceModal();
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [, setIsUserScrolling] = useState(false);
  const [scrollCoordinatorState, dispatchScrollEvent] = useReducer(
    chatScrollReducer,
    initialChatScrollState
  );
  const isStreaming = items.some(
    (item) => item.type === "assistant_turn" && item.status === "running"
  );
  const latestPersistedChatId = useMemo(
    () =>
      items.reduce((latest, item) => {
        const chatId = Number(item?.chatId);
        return Number.isSafeInteger(chatId) && chatId > latest
          ? chatId
          : latest;
      }, 0),
    [items]
  );
  const { showScrollbar } = Appearance.getSettings();
  const { textSize, textSizeClass, textSizeStyle } = useTextSize();
  const isMobileShell = mobileShellRuntimeActive();
  const mobileSystemFontStyle = isMobileShell
    ? {
        fontFamily: "var(--athena-font-sans)",
      }
    : {};
  const textSizePx = Number.parseFloat(textSizeStyle?.fontSize);
  const chatTextSizeStyle =
    isMobileShell && Number.isFinite(textSizePx)
      ? {
          ...textSizeStyle,
          fontSize: `${Math.min(24, Math.max(17, textSizePx + 1))}px`,
        }
      : textSizeStyle;
  const { replaceDraftItems } = useChatThreadDrafts();
  const baseShouldVirtualize = items.length > 80;
  const [layoutFallbackActive, setLayoutFallbackActive] = useState(false);
  const shouldVirtualize = baseShouldVirtualize && !layoutFallbackActive;
  const normalizedBottomInset =
    Number.isFinite(bottomInset) && bottomInset >= 0 ? bottomInset : null;
  const scrollBottomButtonStyle = isMobileShell
    ? {
        "--athena-chat-scroll-bottom-button-right": "16px",
        ...(normalizedBottomInset === null
          ? {}
          : {
              "--athena-chat-scroll-bottom-button-bottom": `${
                normalizedBottomInset + 8
              }px`,
            }),
      }
    : undefined;
  const textSizeFontSize = chatTextSizeStyle?.fontSize || "";
  const rowLayoutContextKey = [
    textSize || "",
    textSizeFontSize,
    contentClassName,
    normalizedBottomInset ?? "",
  ].join(":");
  const scrollContainerStyle =
    normalizedBottomInset === null
      ? { overflowAnchor: "none" }
      : {
          paddingBottom: `${normalizedBottomInset}px`,
          scrollPaddingBottom: `${normalizedBottomInset}px`,
          overflowAnchor: "none",
        };
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => chatHistoryRef.current,
    getItemKey: (index) => items[index]?.id || index,
    estimateSize: () => 164,
    overscan: items.some(
      (item) => item.type === "assistant_turn" && item.status === "running"
    )
      ? 4
      : 8,
  });
  const persistedScrollMemory = useMemo(() => {
    if (chatScrollMemory?.chatKey === chatKey) return chatScrollMemory;
    return readChatScrollMemory(chatKey);
  }, [chatKey, chatScrollMemory]);

  const clearChatRestoreHandles = useCallback(() => {
    const handles = chatRestoreHandlesRef.current;
    handles.frames.forEach((handle) => window.cancelAnimationFrame(handle));
    handles.timeouts.forEach((handle) => window.clearTimeout(handle));
    handles.observers.forEach((observer) => observer.disconnect?.());
    chatRestoreHandlesRef.current = {
      frames: [],
      timeouts: [],
      observers: [],
    };
  }, []);

  const clearPendingChatRestore = useCallback(
    (reason = "chat-restore-cancel") => {
      const handles = chatRestoreHandlesRef.current;
      const hadPending =
        chatRestoreRunRef.current.active ||
        handles.frames.length > 0 ||
        handles.timeouts.length > 0 ||
        handles.observers.length > 0;
      clearChatRestoreHandles();
      cancelChatRestoreRun(chatRestoreRunRef.current);
      scrollRestoreSessionRef.current = {
        active: false,
        anchor: null,
        until: 0,
      };
      suppressAutoScrollRef.current = false;
      if (!hadPending) return;
      recordChatScrollMemoryEvent({
        label: "restore-cancelled",
        chatKey,
        reason,
      });
      debugChatTurn("ChatHistory:restoreCancelled", {
        chatKey,
        reason,
      });
    },
    [chatKey, clearChatRestoreHandles]
  );

  const markUserScrollIntentFor = useCallback(
    (source = "scroll") => {
      clearPendingChatRestore(`user-intent:${source}`);
      programmaticScrollGenerationRef.current += 1;
      programmaticScrollRef.current.reason = null;
      programmaticScrollRef.current.until = 0;
      markChatUserScrollIntent(userScrollIntentRef.current, source);
    },
    [clearPendingChatRestore]
  );

  const hasRecentUserScrollControl = useCallback(
    () => hasRecentChatUserScrollIntent(userScrollIntentRef.current),
    []
  );

  const guardProgrammaticScroll = useCallback(
    (reason, action, durationMs = CHAT_SCROLL_PROGRAMMATIC_SUPPRESS_MS) => {
      const generation = programmaticScrollGenerationRef.current + 1;
      programmaticScrollGenerationRef.current = generation;
      markProgrammaticChatScroll(
        programmaticScrollRef.current,
        reason,
        Date.now(),
        durationMs
      );

      let result;
      try {
        result = action?.();
      } finally {
        if (typeof window !== "undefined") {
          const markSettle = (suffix = "settle") => {
            if (programmaticScrollGenerationRef.current !== generation) return;
            markProgrammaticChatScroll(
              programmaticScrollRef.current,
              `${reason}:${suffix}`,
              Date.now(),
              durationMs
            );
          };
          window.requestAnimationFrame(() => {
            markSettle("settle");
            window.requestAnimationFrame(() => markSettle("settle-2"));
          });
          window.setTimeout(() => markSettle("timeout-settle"), durationMs);
        }
      }
      return result;
    },
    []
  );

  const capturePrependAnchor = useCallback(() => {
    const element = chatHistoryRef.current;
    if (!element) return null;
    const anchor = getFirstVisibleChatMessageAnchor(element);
    prependRestoreRequestRef.current = {
      anchor,
      previousScrollHeight: element.scrollHeight,
      requestedAt: Date.now(),
      allowFallback: true,
    };
    parkedAnchorRef.current = anchor;
    return anchor;
  }, []);

  const restorePrependAnchor = useCallback(() => {
    const element = chatHistoryRef.current;
    if (!element) return false;

    const request = prependRestoreRequestRef.current;
    prependRestoreRequestRef.current = null;
    if (!request) return false;

    const { anchor, previousScrollHeight = 0, allowFallback = false } = request;
    guardProgrammaticScroll(
      "older-history-anchor",
      () => {
        if (anchor && restoreChatMessageAnchor(element, anchor)) {
          parkedAnchorRef.current = anchor;
          return;
        }
        if (!allowFallback) return;
        element.scrollTop += Math.max(
          element.scrollHeight - previousScrollHeight,
          0
        );
      },
      CHAT_SCROLL_LAYOUT_SUPPRESS_MS
    );
    if (anchor) {
      window.requestAnimationFrame(() => {
        guardProgrammaticScroll(
          "older-history-anchor:settle",
          () => restoreChatMessageAnchor(element, anchor),
          CHAT_SCROLL_LAYOUT_SUPPRESS_MS
        );
      });
    }
    return true;
  }, [guardProgrammaticScroll]);

  const clearLayoutTransitionHandles = useCallback(() => {
    const handles = layoutTransitionHandlesRef.current;
    handles.frames.forEach((handle) => window.cancelAnimationFrame(handle));
    handles.timeouts.forEach((handle) => window.clearTimeout(handle));
    handles.observer?.disconnect?.();
    layoutTransitionHandlesRef.current = {
      frames: [],
      timeouts: [],
      observer: null,
    };
  }, []);

  const captureLayoutTransitionAnchor = useCallback(
    (signal = {}) => {
      const element = chatHistoryRef.current;
      if (!element || !chatKey) return null;

      const seq = signal.seq || Date.now();
      const reason = signal.reason || "layout-transition";
      const currentItems = itemsRef.current || [];
      const bottomGap =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      const isBottom = bottomGap < 2;
      const anchor = isBottom
        ? null
        : getFirstVisibleChatMessageAnchor(element);
      const item = findChatHistoryItemForAnchor(currentItems, anchor);
      const capturedAnchor =
        anchor && item
          ? {
              ...anchor,
              chatId: item.chatId ?? null,
              role: chatHistoryItemRole(item),
            }
          : anchor;

      clearLayoutTransitionHandles();
      layoutTransitionRef.current = {
        active: true,
        seq,
        reason,
        anchor: capturedAnchor,
        isAtBottom: isBottom,
        firstItemId: currentItems[0]?.id || null,
        lastItemId: currentItems[currentItems.length - 1]?.id || null,
        scrollTop: element.scrollTop,
        startedAt: Date.now(),
      };
      prependRestoreRequestRef.current = null;
      if (!isBottom) parkedAnchorRef.current = capturedAnchor;
      dispatchScrollEvent({
        type: "LAYOUT_WILL_CHANGE",
        anchorMessageId: capturedAnchor?.itemId || null,
        anchorOffset: capturedAnchor?.rowOffsetTop || 0,
      });

      debugChatTurn("ChatHistory:layoutTransitionStart", {
        chatKey,
        reason,
        seq,
        itemId: capturedAnchor?.itemId || null,
        chatId: capturedAnchor?.chatId || null,
        hasInnerAnchor: !!capturedAnchor?.innerAnchor,
        textFingerprint: capturedAnchor?.innerAnchor?.textFingerprint || null,
        isAtBottom: isBottom,
        bottomGap: Math.round(bottomGap),
      });
      return layoutTransitionRef.current;
    },
    [chatKey, clearLayoutTransitionHandles]
  );

  const buildVisibleScrollMemorySnapshot = useCallback(() => {
    const element = chatHistoryRef.current;
    if (!element || !chatKey) return null;

    const currentItems = itemsRef.current || [];
    const currentIsAtBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 2;
    const anchor = currentIsAtBottom
      ? null
      : getFirstVisibleChatMessageAnchor(element);
    const item =
      findChatHistoryItemForAnchor(currentItems, anchor) ||
      (currentIsAtBottom ? currentItems[currentItems.length - 1] : null);

    return createChatScrollMemorySnapshot({
      chatKey,
      item,
      anchor,
      scrollTop: element.scrollTop,
      isAtBottom: currentIsAtBottom,
      firstItemId: currentItems[0]?.id || null,
      lastItemId: currentItems[currentItems.length - 1]?.id || null,
    });
  }, [chatKey]);

  const persistBottomScrollMemory = useCallback(
    (reason = "bottom") => {
      if (!chatKey) return null;
      const element = chatHistoryRef.current;
      const currentItems = itemsRef.current || [];
      const latestItem = currentItems[currentItems.length - 1] || null;
      const written = writeChatScrollBottomMemory(chatKey, {
        item: latestItem,
        scrollTop: element?.scrollTop || 0,
        firstItemId: currentItems[0]?.id || null,
        lastItemId: latestItem?.id || null,
      });
      recordChatScrollMemoryEvent({
        label: "bottom-save",
        chatKey,
        reason,
        saved: !!written,
        itemId: written?.itemId || latestItem?.id || null,
        chatId: written?.chatId || latestItem?.chatId || null,
        isAtBottom: true,
      });
      if (written) {
        debugChatTurn("ChatHistory:scrollMemoryBottomSaved", {
          chatKey,
          reason,
          itemId: written.itemId,
          chatId: written.chatId,
          role: written.role,
        });
      }
      return written;
    },
    [chatKey]
  );

  const beginScrollRestoreSession = useCallback((anchor = null) => {
    if (!anchor?.itemId || anchor.isAtBottom) {
      scrollRestoreSessionRef.current = {
        active: false,
        anchor: null,
        until: 0,
      };
      return;
    }
    scrollRestoreSessionRef.current = {
      active: true,
      anchor,
      until: Date.now() + CHAT_SCROLL_RESTORE_SESSION_MS,
    };
  }, []);

  const clearScrollRestoreSession = useCallback(() => {
    scrollRestoreSessionRef.current = {
      active: false,
      anchor: null,
      until: 0,
    };
  }, []);

  const restoreScrollRestoreSession = useCallback(
    (reason = "restore-session") => {
      const session = scrollRestoreSessionRef.current;
      const element = chatHistoryRef.current;
      if (!session.active || !session.anchor || !element) return false;
      if (Date.now() > session.until) {
        clearScrollRestoreSession();
        return false;
      }

      const restored = restoreChatMessageAnchor(element, session.anchor);
      if (restored) return true;

      const targetIndex = findChatHistoryItemIndexForAnchor(
        itemsRef.current || [],
        session.anchor
      );
      if (targetIndex >= 0 && shouldVirtualize) {
        rowVirtualizer.scrollToIndex(targetIndex, { align: "start" });
        window.requestAnimationFrame(() => {
          restoreChatMessageAnchor(element, session.anchor);
        });
        debugChatTurn("ChatHistory:restoreSessionIndex", {
          chatKey,
          reason,
          itemId: session.anchor.itemId,
          targetIndex,
        });
        return true;
      }
      return false;
    },
    [chatKey, clearScrollRestoreSession, rowVirtualizer, shouldVirtualize]
  );

  const persistVisibleScrollMemory = useCallback(
    (reason = "scroll") => {
      if (sendFollowRef.current.active && shouldFollowOutputRef.current) {
        return persistBottomScrollMemory(reason);
      }
      if (
        shouldBlockChatScrollPersistenceForLayoutTransition({
          layoutTransitionActive: layoutTransitionRef.current.active,
          hasUserIntent: false,
        })
      ) {
        debugChatTurn("ChatHistory:layoutTransitionSkip", {
          chatKey,
          reason,
          result: "skip-persist",
        });
        return null;
      }
      let snapshot = buildVisibleScrollMemorySnapshot();
      if (!snapshot) {
        recordChatScrollMemoryEvent({
          label: "visible-save",
          chatKey,
          reason,
          saved: false,
          result: "missing-snapshot",
        });
        return null;
      }
      const restoreSession = scrollRestoreSessionRef.current;
      const restoreSessionActive =
        restoreSession.active && Date.now() <= restoreSession.until;
      const isUserPositionSave =
        reason.startsWith("user-scroll") ||
        reason.startsWith("observed-scroll") ||
        reason === "visibility-hidden" ||
        reason === "pagehide" ||
        reason === "unmount";
      if (
        restoreSessionActive &&
        restoreSession.anchor?.itemId &&
        snapshot.itemId !== restoreSession.anchor.itemId &&
        !isUserPositionSave
      ) {
        restoreScrollRestoreSession(`persist-block:${reason}`);
        recordChatScrollMemoryEvent({
          label: "visible-save",
          chatKey,
          reason,
          saved: false,
          result: "restore-session-blocked",
          itemId: snapshot.itemId || null,
          restoreItemId: restoreSession.anchor.itemId,
        });
        return null;
      }
      if (
        restoreSessionActive &&
        restoreSession.anchor?.itemId === snapshot.itemId &&
        restoreSession.anchor?.innerAnchor &&
        !snapshot.innerAnchor &&
        !isUserPositionSave
      ) {
        snapshot = {
          ...snapshot,
          innerAnchor: restoreSession.anchor.innerAnchor,
          rowOffsetTop:
            restoreSession.anchor.rowOffsetTop ??
            restoreSession.anchor.offsetTop ??
            snapshot.rowOffsetTop,
        };
      }
      const written = writeChatScrollMemory(chatKey, snapshot);
      recordChatScrollMemoryEvent({
        label: "visible-save",
        chatKey,
        reason,
        saved: !!written,
        itemId: written?.itemId || snapshot.itemId || null,
        chatId: written?.chatId || snapshot.chatId || null,
        isAtBottom: written?.isAtBottom || snapshot.isAtBottom,
        hasInnerAnchor: !!(written?.innerAnchor || snapshot.innerAnchor),
      });
      if (written) {
        debugChatTurn("ChatHistory:scrollMemorySaved", {
          chatKey,
          reason,
          itemId: written.itemId,
          chatId: written.chatId,
          role: written.role,
          isAtBottom: written.isAtBottom,
          hasInnerAnchor: !!written.innerAnchor,
        });
      }
      return written;
    },
    [
      buildVisibleScrollMemorySnapshot,
      chatKey,
      persistBottomScrollMemory,
      restoreScrollRestoreSession,
    ]
  );

  useEffect(() => {
    persistScrollMemoryRef.current = persistVisibleScrollMemory;
  }, [persistVisibleScrollMemory]);

  const debouncedPersistScrollMemory = useMemo(
    () =>
      debounce((reason = "scroll") => {
        persistScrollMemoryRef.current?.(reason);
      }, 250),
    []
  );

  useEffect(
    () => () => {
      debouncedPersistScrollMemory.cancel();
    },
    [debouncedPersistScrollMemory]
  );

  useEffect(() => {
    if (!chatKey) return undefined;

    const persistNow = (reason) => {
      debouncedPersistScrollMemory.flush();
      persistScrollMemoryRef.current?.(reason);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        persistNow("visibility-hidden");
      }
    };
    const handlePageHide = () => persistNow("pagehide");

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      persistNow("unmount");
    };
  }, [chatKey, debouncedPersistScrollMemory]);

  useEffect(() => {
    if (!chatKey) return undefined;

    lastScrollMemoryHeartbeatRef.current = { signature: null };
    const interval = window.setInterval(() => {
      const element = chatHistoryRef.current;
      if (!element) return;
      if (sendFollowRef.current.active && shouldFollowOutputRef.current) return;
      const restoreSession = scrollRestoreSessionRef.current;
      if (restoreSession.active && Date.now() <= restoreSession.until) {
        restoreScrollRestoreSession("heartbeat");
        return;
      }

      const transition = layoutTransitionRef.current;
      if (transition.active) {
        const ageMs = Date.now() - (transition.startedAt || Date.now());
        if (ageMs <= CHAT_SCROLL_LAYOUT_SUPPRESS_MS) return;
        transition.active = false;
        clearLayoutTransitionHandles();
      }

      const currentItems = itemsRef.current || [];
      const signature = [
        Math.round(element.scrollTop),
        element.scrollHeight,
        element.clientHeight,
        currentItems[0]?.id || "",
        currentItems[currentItems.length - 1]?.id || "",
      ].join(":");
      if (lastScrollMemoryHeartbeatRef.current.signature === signature) return;
      lastScrollMemoryHeartbeatRef.current.signature = signature;
      persistVisibleScrollMemory("heartbeat");
    }, CHAT_SCROLL_MEMORY_HEARTBEAT_MS);

    return () => window.clearInterval(interval);
  }, [
    chatKey,
    clearLayoutTransitionHandles,
    persistVisibleScrollMemory,
    restoreScrollRestoreSession,
  ]);

  const preserveParkedAnchor = useCallback(
    (reason = "layout") => {
      const element = chatHistoryRef.current;
      const anchor = parkedAnchorRef.current;
      if (
        !element ||
        !shouldPreserveParkedChatAnchor({
          hasAnchor: !!anchor,
          isAtBottom,
          shouldFollowOutput: shouldFollowOutputRef.current,
          sendFollowActive: sendFollowRef.current.active,
          layoutTransitionActive: layoutTransitionRef.current.active,
        })
      ) {
        return false;
      }

      const restoreResult = restoreChatMessageAnchor(element, anchor);
      debugChatTurn("ChatHistory:preserveParkedAnchor", {
        chatKey,
        reason,
        hasAnchor: !!anchor,
        restoreResult,
        anchorItemId: anchor?.itemId || null,
      });
      if (!restoreResult) return false;

      guardProgrammaticScroll(
        `parked-anchor:${reason}`,
        () => restoreChatMessageAnchor(element, anchor),
        CHAT_SCROLL_LAYOUT_SUPPRESS_MS
      );
      return true;
    },
    [guardProgrammaticScroll, isAtBottom]
  );

  const scrollToBottom = useCallback(
    (
      smooth = false,
      { reason = "bottom", resetSavedPosition = false } = {}
    ) => {
      const element = chatHistoryRef.current;
      if (!element) return;

      if (resetSavedPosition) {
        clearSavedChatScrollPosition(scrollPositionsRef.current, chatKey);
        parkedAnchorRef.current = null;
      }
      const behavior = chatBottomScrollBehavior({
        smooth,
        sendFollowActive: sendFollowRef.current.active,
      });

      guardProgrammaticScroll(
        reason,
        () => {
          element.scrollTo({
            top: element.scrollHeight,
            ...(behavior === "smooth" ? { behavior: "smooth" } : {}),
          });
        },
        behavior === "smooth"
          ? CHAT_SCROLL_SMOOTH_SUPPRESS_MS
          : CHAT_SCROLL_PROGRAMMATIC_SUPPRESS_MS
      );
    },
    [chatKey, guardProgrammaticScroll]
  );

  const clearBottomStickHandles = useCallback(() => {
    const handles = bottomStickHandlesRef.current;
    handles.frames.forEach((handle) => window.cancelAnimationFrame(handle));
    handles.timeouts.forEach((handle) => window.clearTimeout(handle));
    bottomStickHandlesRef.current = { frames: [], timeouts: [] };
  }, []);

  const stickToBottom = useCallback(
    (
      reason = "stick-bottom",
      { resetSavedPosition = false, persist = false } = {}
    ) => {
      const element = chatHistoryRef.current;
      if (!element) return false;

      const bottomGapBefore =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      scrollToBottom(false, { reason, resetSavedPosition });
      const bottomGapAfter =
        element.scrollHeight - element.scrollTop - element.clientHeight;

      if (persist) persistBottomScrollMemory(reason);
      setIsAtBottom(bottomGapAfter < 2);
      setIsNearBottom(true);
      setIsUserScrolling(false);
      lastScrollTopRef.current = element.scrollTop;
      debugChatTurn("ChatHistory:stickToBottom", {
        chatKey,
        reason,
        sendFollowActive: sendFollowRef.current.active,
        bottomGapBefore: Math.round(bottomGapBefore),
        bottomGapAfter: Math.round(bottomGapAfter),
        itemCount: itemsRef.current.length,
      });
      return true;
    },
    [chatKey, persistBottomScrollMemory, scrollToBottom]
  );

  const scheduleStickToBottom = useCallback(
    (reason = "stick-bottom", options = {}) => {
      clearBottomStickHandles();
      const run = (suffix = "") => {
        if (!shouldFollowOutputRef.current && !sendFollowRef.current.active) {
          return;
        }
        stickToBottom(suffix ? `${reason}:${suffix}` : reason, options);
      };

      run();
      const firstFrame = window.requestAnimationFrame(() => {
        run("raf");
        const secondFrame = window.requestAnimationFrame(() => run("raf-2"));
        bottomStickHandlesRef.current.frames.push(secondFrame);
      });
      bottomStickHandlesRef.current.frames.push(firstFrame);
      [80, 240, 600, CHAT_SCROLL_LAYOUT_SUPPRESS_MS].forEach((delayMs) => {
        const timeout = window.setTimeout(() => {
          run(`timeout-${delayMs}`);
        }, delayMs);
        bottomStickHandlesRef.current.timeouts.push(timeout);
      });
    },
    [clearBottomStickHandles, stickToBottom]
  );

  useEffect(() => clearBottomStickHandles, [clearBottomStickHandles]);
  useEffect(() => clearLayoutTransitionHandles, [clearLayoutTransitionHandles]);

  const restoreLayoutTransitionAnchor = useCallback(
    (reason = "layout-transition") => {
      const element = chatHistoryRef.current;
      const transition = layoutTransitionRef.current;
      if (!element || !transition.active) return false;

      let restored = false;
      let result = "missing-anchor";
      if (transition.isAtBottom) {
        restored = stickToBottom(reason, { persist: false });
        result = restored ? "bottom" : "bottom-failed";
      } else if (
        transition.anchor &&
        restoreChatMessageAnchor(element, transition.anchor)
      ) {
        restored = true;
        result = transition.anchor.innerAnchor ? "inner-anchor" : "row-anchor";
        parkedAnchorRef.current = transition.anchor;
      } else {
        const fallbackTop = savedChatScrollTopFallback(transition, {
          firstItemId: itemsRef.current[0]?.id || null,
          lastItemId: itemsRef.current[itemsRef.current.length - 1]?.id || null,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        });
        if (fallbackTop !== null) {
          element.scrollTo({ top: fallbackTop });
          restored = true;
          result = "scrollTop-fallback";
        }
      }

      const bottomGap =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      debugChatTurn("ChatHistory:layoutTransitionRestore", {
        chatKey,
        reason,
        seq: transition.seq,
        result,
        restored,
        itemId: transition.anchor?.itemId || null,
        chatId: transition.anchor?.chatId || null,
        hasInnerAnchor: !!transition.anchor?.innerAnchor,
        bottomGap: Math.round(bottomGap),
      });
      setIsAtBottom(bottomGap < 2);
      setIsNearBottom(bottomGap <= CHAT_SCROLL_BOTTOM_TOLERANCE_PX);
      setIsUserScrolling(!transition.isAtBottom);
      lastScrollTopRef.current = element.scrollTop;
      return restored;
    },
    [chatKey, stickToBottom]
  );

  const scheduleLayoutTransitionRestore = useCallback(
    (reason = "layout-transition") => {
      const element = chatHistoryRef.current;
      const transition = layoutTransitionRef.current;
      if (!element || !transition.active) return;

      clearLayoutTransitionHandles();
      const handles = layoutTransitionHandlesRef.current;
      let lastSize = "";
      let stableFrames = 0;

      const sizeSignature = () =>
        [
          element.clientWidth,
          element.clientHeight,
          element.scrollHeight,
          itemsRef.current.length,
        ].join(":");

      const tick = (suffix = "settle") => {
        if (!layoutTransitionRef.current.active) return;
        rowVirtualizer.measure();
        restoreLayoutTransitionAnchor(`${reason}:${suffix}`);
        const nextSize = sizeSignature();
        stableFrames = nextSize === lastSize ? stableFrames + 1 : 0;
        lastSize = nextSize;
        const ageMs = Date.now() - (transition.startedAt || Date.now());
        if (stableFrames >= 2 && ageMs >= CHAT_SCROLL_LAYOUT_MIN_SETTLE_MS) {
          layoutTransitionRef.current.active = false;
          clearLayoutTransitionHandles();
          dispatchScrollEvent({ type: "LAYOUT_DID_STABILIZE" });
          debugChatTurn("ChatHistory:layoutTransitionSkip", {
            chatKey,
            reason,
            seq: transition.seq,
            result: "stable",
            ageMs,
          });
          return;
        }
        const frame = window.requestAnimationFrame(() => tick("raf"));
        handles.frames.push(frame);
      };

      if (typeof ResizeObserver !== "undefined") {
        handles.observer = new ResizeObserver(() => {
          stableFrames = 0;
          restoreLayoutTransitionAnchor(`${reason}:resize`);
        });
        handles.observer.observe(element);
      }

      const firstFrame = window.requestAnimationFrame(() => {
        const secondFrame = window.requestAnimationFrame(() => tick("raf-2"));
        handles.frames.push(secondFrame);
      });
      handles.frames.push(firstFrame);
      const timeout = window.setTimeout(() => {
        if (!layoutTransitionRef.current.active) return;
        restoreLayoutTransitionAnchor(`${reason}:timeout`);
        layoutTransitionRef.current.active = false;
        clearLayoutTransitionHandles();
      }, CHAT_SCROLL_LAYOUT_SUPPRESS_MS);
      handles.timeouts.push(timeout);
    },
    [
      chatKey,
      clearLayoutTransitionHandles,
      restoreLayoutTransitionAnchor,
      rowVirtualizer,
    ]
  );

  const activateSendFollow = useCallback(
    (request = 0, reason = "send-follow") => {
      const previous = sendFollowRef.current;
      const now = Date.now();
      sendFollowRef.current = {
        active: true,
        request,
        generation: (previous.generation || 0) + 1,
        startedAt: now,
        settleUntil: now + CHAT_SEND_FOLLOW_STICK_MS,
      };
      shouldFollowOutputRef.current = true;
      parkedAnchorRef.current = null;
      clearScrollRestoreSession();
      clearSavedChatScrollPosition(scrollPositionsRef.current, chatKey);
      lastScrollMemoryRestoreKeyRef.current = null;
      debugChatTurn("ChatHistory:sendFollowActive", {
        chatKey,
        reason,
        request,
        generation: sendFollowRef.current.generation,
        itemCount: itemsRef.current.length,
      });
    },
    [chatKey, clearScrollRestoreSession]
  );

  const deactivateSendFollow = useCallback(
    (reason = "user-intent") => {
      if (!sendFollowRef.current.active) return;
      debugChatTurn("ChatHistory:sendFollowInactive", {
        chatKey,
        reason,
        request: sendFollowRef.current.request,
        generation: sendFollowRef.current.generation,
        itemCount: itemsRef.current.length,
      });
      sendFollowRef.current.active = false;
      sendFollowRef.current.settleUntil = 0;
      clearBottomStickHandles();
    },
    [chatKey, clearBottomStickHandles]
  );

  useLayoutEffect(() => {
    const signal = layoutTransitionSignal;
    if (!signal?.seq || lastLayoutTransitionSignalSeqRef.current === signal.seq)
      return;
    lastLayoutTransitionSignalSeqRef.current = signal.seq;
    if (
      !layoutTransitionRef.current.active ||
      layoutTransitionRef.current.seq !== signal.seq
    ) {
      captureLayoutTransitionAnchor(signal);
    }
    scheduleLayoutTransitionRestore(signal.reason || "layout-transition");
  }, [
    captureLayoutTransitionAnchor,
    layoutTransitionSignal,
    scheduleLayoutTransitionRestore,
  ]);

  const scrollToTop = useCallback(
    (smooth = true) => {
      const element = chatHistoryRef.current;
      if (!element) return;

      markUserScrollIntentFor("shortcut-top");
      deactivateSendFollow("shortcut-top");
      shouldFollowOutputRef.current = false;
      setIsUserScrolling(true);
      element.scrollTo({
        top: 0,
        ...(smooth ? { behavior: "smooth" } : {}),
      });
    },
    [deactivateSendFollow, markUserScrollIntentFor]
  );

  const clearLayoutCheckFrames = useCallback(() => {
    if (layoutCheckFrameRef.current) {
      cancelAnimationFrame(layoutCheckFrameRef.current);
      layoutCheckFrameRef.current = null;
    }
    if (layoutCheckSettleFrameRef.current) {
      cancelAnimationFrame(layoutCheckSettleFrameRef.current);
      layoutCheckSettleFrameRef.current = null;
    }
  }, []);

  const measureVisibleVirtualRows = useCallback(() => {
    const element = chatHistoryRef.current;
    if (!element) return;

    rowVirtualizer.measure();
    element
      .querySelectorAll('[data-virtual-message-row="true"]')
      .forEach((rowElement) => rowVirtualizer.measureElement(rowElement));
  }, [rowVirtualizer]);

  const recoverChatLayoutOnce = useCallback(
    (reason = "layout") => {
      const element = chatHistoryRef.current;
      if (!element || !baseShouldVirtualize || layoutFallbackActive) {
        return false;
      }

      const status = inspectChatHistoryVisibleLayout(element, {
        itemCount: items.length,
        virtualTotalSize: rowVirtualizer.getTotalSize(),
      });
      if (!status.hasIssue) {
        layoutRecoveryPassesRef.current = 0;
        return false;
      }

      if (hasRecentUserScrollControl()) {
        measureVisibleVirtualRows();
        layoutRecoveryPassesRef.current = 0;
        debugChatTurn("ChatHistory:layoutRecoveryDeferred", {
          chatKey,
          reason,
          result: "user-scroll-control",
          status,
        });
        return false;
      }

      layoutRecoveryPassesRef.current += 1;
      guardProgrammaticScroll(
        "layout-recovery",
        () => {
          measureVisibleVirtualRows();
          if (layoutTransitionRef.current.active) {
            scheduleLayoutTransitionRestore(`layout-recovery:${reason}`);
          } else if (
            sendFollowRef.current.active &&
            shouldFollowOutputRef.current
          ) {
            stickToBottom(`layout-recovery:${reason}`, { persist: true });
          } else {
            preserveParkedAnchor(reason);
          }
        },
        CHAT_SCROLL_LAYOUT_SUPPRESS_MS
      );
      debugChatTurn("ChatHistory:layoutRecovery", {
        chatKey,
        reason,
        passes: layoutRecoveryPassesRef.current,
        status,
      });

      if (
        layoutRecoveryPassesRef.current >= CHAT_LAYOUT_FALLBACK_AFTER_RECOVERIES
      ) {
        setLayoutFallbackActive(true);
        debugChatTurn("ChatHistory:layoutFallback", {
          chatKey,
          reason,
          status,
        });
      }

      return true;
    },
    [
      baseShouldVirtualize,
      chatKey,
      items.length,
      layoutFallbackActive,
      measureVisibleVirtualRows,
      preserveParkedAnchor,
      guardProgrammaticScroll,
      hasRecentUserScrollControl,
      rowVirtualizer,
      scheduleLayoutTransitionRestore,
      stickToBottom,
    ]
  );

  const scheduleChatLayoutSelfCheck = useCallback(
    (reason = "layout") => {
      if (!baseShouldVirtualize || layoutFallbackActive) return;

      clearLayoutCheckFrames();
      layoutCheckFrameRef.current = requestAnimationFrame(() => {
        layoutCheckFrameRef.current = null;
        const hadIssue = recoverChatLayoutOnce(reason);
        if (!hadIssue) return;

        layoutCheckSettleFrameRef.current = requestAnimationFrame(() => {
          layoutCheckSettleFrameRef.current = null;
          layoutCheckFrameRef.current = requestAnimationFrame(() => {
            layoutCheckFrameRef.current = null;
            recoverChatLayoutOnce(`${reason}:settle`);
          });
        });
      });
    },
    [
      baseShouldVirtualize,
      clearLayoutCheckFrames,
      layoutFallbackActive,
      recoverChatLayoutOnce,
    ]
  );

  useEffect(() => clearLayoutCheckFrames, [clearLayoutCheckFrames]);

  useEffect(() => {
    layoutRecoveryPassesRef.current = 0;
    setLayoutFallbackActive(false);
    clearLayoutCheckFrames();
    clearBottomStickHandles();
    clearScrollRestoreSession();
    sendFollowRef.current = {
      active: false,
      request: 0,
      generation: 0,
      startedAt: 0,
      settleUntil: 0,
    };
  }, [
    chatKey,
    clearBottomStickHandles,
    clearLayoutCheckFrames,
    clearScrollRestoreSession,
  ]);

  useEffect(() => {
    if (!shouldVirtualize) return;

    scheduleChatLayoutSelfCheck("interval-start");
    const interval = window.setInterval(
      () => scheduleChatLayoutSelfCheck("periodic"),
      CHAT_LAYOUT_SELF_CHECK_INTERVAL_MS
    );
    return () => window.clearInterval(interval);
  }, [scheduleChatLayoutSelfCheck, shouldVirtualize]);

  useEffect(() => {
    const assistantTurns = items
      .filter((item) => item.type === "assistant_turn")
      .map((item) => ({
        turnId: item.turnId,
        status: item.status,
        finalContentLength: item.finalContent?.length || 0,
        timelineEventCount: item.timeline?.length || 0,
      }));
    debugChatTurn("ChatHistory:renderState", {
      chatKey,
      isStreaming,
      itemCount: items.length,
      runningTurnIds: assistantTurns
        .filter((item) => item.status === "running")
        .map((item) => item.turnId),
      lastAssistantTurn: assistantTurns[assistantTurns.length - 1] || null,
    });
  }, [chatKey, isStreaming, items]);

  useEffect(() => {
    if (
      readOnly ||
      isStreaming ||
      !isNearBottom ||
      !workspace?.slug ||
      latestPersistedChatId <= 0 ||
      document.visibilityState === "hidden"
    )
      return;
    const timer = window.setTimeout(async () => {
      if (
        document.visibilityState === "hidden" ||
        !shouldFollowOutputRef.current
      )
        return;
      try {
        const { advanceThreadReadCursor } = await import(
          "@/utils/userStateSync"
        );
        await advanceThreadReadCursor({
          workspaceSlug: workspace.slug,
          threadSlug: effectiveThreadSlug,
          cursor: latestPersistedChatId,
          messageId: latestPersistedChatId,
        });
      } catch {
        // Read-state delivery is recoverable and must never block chat render.
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [
    effectiveThreadSlug,
    isNearBottom,
    isStreaming,
    latestPersistedChatId,
    readOnly,
    workspace?.slug,
  ]);

  useEffect(() => {
    const previousItemsLength = previousItemsLengthRef.current;
    const currentAnchor = parkedAnchorRef.current;
    if (isStreaming) {
      dispatchScrollEvent({
        type: "ASSISTANT_MESSAGE_STREAMING",
        anchorMessageId: currentAnchor?.itemId || null,
        anchorOffset: currentAnchor?.rowOffsetTop || 0,
      });
    } else if (items.length !== previousItemsLength) {
      dispatchScrollEvent({
        type: "MESSAGE_APPENDED",
        messageId: items[items.length - 1]?.id || null,
        anchorMessageId: currentAnchor?.itemId || null,
        anchorOffset: currentAnchor?.rowOffsetTop || 0,
      });
    }
    previousItemsLengthRef.current = items.length;

    if (layoutTransitionRef.current.active) {
      scheduleLayoutTransitionRestore("items-follow:layout-transition");
      return;
    }
    const sendFollowActive = sendFollowRef.current.active;
    const bypassSuppress = shouldBypassAutoScrollSuppressForSendFollow({
      suppressAutoScroll: suppressAutoScrollRef.current,
      sendFollowActive,
    });
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false;
      if (!bypassSuppress) return;
    }
    if (sendFollowActive && shouldFollowOutputRef.current) {
      scheduleStickToBottom("items-follow:send-follow", { persist: true });
    } else if (shouldFollowOutputRef.current) {
      scrollToBottom(false, { reason: "items-follow" });
    }
  }, [
    isStreaming,
    items,
    preserveParkedAnchor,
    scheduleLayoutTransitionRestore,
    scheduleStickToBottom,
    scrollToBottom,
  ]);

  useLayoutEffect(() => {
    if (!sendScrollRequest) return;
    if (sendFollowRef.current.request === sendScrollRequest) return;

    dispatchScrollEvent({ type: "USER_SENT_MESSAGE" });
    activateSendFollow(sendScrollRequest, "send-scroll:init");
  }, [activateSendFollow, sendScrollRequest]);

  useLayoutEffect(() => {
    const element = chatHistoryRef.current;
    if (!element || !chatKey) return;

    clearChatRestoreHandles();
    const restoreRunId = startChatRestoreRun(chatRestoreRunRef.current);
    const restoreHandles = chatRestoreHandlesRef.current;
    const restoreRunIsCurrent = () =>
      isChatRestoreRunCurrent(chatRestoreRunRef.current, restoreRunId);
    suppressAutoScrollRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      if (!restoreRunIsCurrent()) return;
      const current = chatHistoryRef.current;
      if (!current) return;
      if (
        shouldSkipChatRestoreForLayoutTransition({
          layoutTransitionActive: layoutTransitionRef.current.active,
        })
      ) {
        suppressAutoScrollRef.current = false;
        scheduleLayoutTransitionRestore("chat-restore:layout-transition");
        debugChatTurn("ChatHistory:layoutTransitionSkip", {
          chatKey,
          reason: "chat-restore",
          result: "skip-persisted-restore",
        });
        return;
      }

      const inMemoryPosition = normalizeChatScrollPosition(
        scrollPositionsRef.current[chatKey]
      );
      const sendFollowActive = sendFollowRef.current.active;
      const shouldIgnorePersistedPosition =
        shouldIgnorePersistedChatScrollMemory({
          sendFollowActive,
          persistedMemory: persistedScrollMemory,
        });
      const persistedPosition =
        !shouldIgnorePersistedPosition &&
        persistedScrollMemory?.chatKey === chatKey
          ? {
              ...persistedScrollMemory,
              offsetTop: persistedScrollMemory.rowOffsetTop,
            }
          : null;
      const savedPosition = inMemoryPosition || persistedPosition;
      const currentItems = itemsRef.current || [];
      const restoreKey = [
        chatKey,
        savedPosition?.savedAt || "none",
        savedPosition?.itemId || "",
        savedPosition?.isAtBottom ? "bottom" : "anchor",
        currentItems[0]?.id || "",
        currentItems[currentItems.length - 1]?.id || "",
      ].join(":");
      if (lastScrollMemoryRestoreKeyRef.current === restoreKey) {
        suppressAutoScrollRef.current = false;
        chatRestoreRunRef.current.active = false;
        return;
      }
      lastScrollMemoryRestoreKeyRef.current = restoreKey;

      const hasSavedPosition =
        !!savedPosition && savedPosition.isAtBottom !== true;
      if (hasSavedPosition) beginScrollRestoreSession(savedPosition);
      else clearScrollRestoreSession();
      recordChatScrollMemoryEvent({
        label: "restore-candidate",
        chatKey,
        source: inMemoryPosition
          ? "memory-ref"
          : persistedPosition
            ? "persisted"
            : "none",
        itemId: savedPosition?.itemId || null,
        chatId: savedPosition?.chatId || null,
        isAtBottom: !!savedPosition?.isAtBottom,
        hasInnerAnchor: !!savedPosition?.innerAnchor,
        hasSavedPosition,
      });
      const scheduleRestoreMemoryPersist = (reason) => {
        const persistTimeout = window.setTimeout(() => {
          if (!restoreRunIsCurrent()) return;
          persistScrollMemoryRef.current?.(reason);
        }, 320);
        restoreHandles.timeouts.push(persistTimeout);
      };
      const scheduleAnchorSettle = (anchor, reason) => {
        const element = chatHistoryRef.current;
        const runSettle = (suffix = "settle") => {
          if (!restoreRunIsCurrent()) return;
          const latest = chatHistoryRef.current;
          if (!latest) return;
          guardProgrammaticScroll(
            `${reason}:${suffix}`,
            () => {
              if (restoreChatMessageAnchor(latest, anchor)) {
                parkedAnchorRef.current = anchor;
                persistScrollMemoryRef.current?.(`${reason}:${suffix}`);
              }
            },
            CHAT_SCROLL_RESTORE_SETTLE_SUPPRESS_MS
          );
        };
        const addFrame = (callback) => {
          const handle = window.requestAnimationFrame(() => {
            if (!restoreRunIsCurrent()) return;
            callback();
          });
          restoreHandles.frames.push(handle);
          return handle;
        };
        addFrame(() => {
          runSettle("raf");
          addFrame(() => runSettle("raf-2"));
        });
        CHAT_SCROLL_RESTORE_SETTLE_DELAYS_MS.forEach((delayMs) => {
          const settleTimeout = window.setTimeout(
            () => runSettle(`timeout-${delayMs}`),
            delayMs
          );
          restoreHandles.timeouts.push(settleTimeout);
        });
        if (element && typeof ResizeObserver !== "undefined") {
          const observer = new ResizeObserver(() => {
            if (!restoreRunIsCurrent()) return;
            runSettle("resize");
          });
          observer.observe(element);
          restoreHandles.observers.push(observer);
          restoreHandles.timeouts.push(
            window.setTimeout(() => {
              observer.disconnect();
            }, 2500)
          );
        }
      };
      const scheduleBottomSettle = (reason) => {
        const runSettle = () => {
          if (!restoreRunIsCurrent()) return;
          const latest = chatHistoryRef.current;
          if (!latest) return;
          guardProgrammaticScroll(
            reason,
            () => {
              latest.scrollTo({ top: latest.scrollHeight });
              persistScrollMemoryRef.current?.(reason);
            },
            CHAT_SCROLL_RESTORE_SETTLE_SUPPRESS_MS
          );
        };
        const frameHandle = window.requestAnimationFrame(() => {
          if (!restoreRunIsCurrent()) return;
          const secondFrame = window.requestAnimationFrame(runSettle);
          restoreHandles.frames.push(secondFrame);
        });
        restoreHandles.frames.push(frameHandle);
        CHAT_SCROLL_RESTORE_SETTLE_DELAYS_MS.forEach((delayMs) => {
          const timeout = window.setTimeout(runSettle, delayMs);
          restoreHandles.timeouts.push(timeout);
        });
      };

      guardProgrammaticScroll("chat-restore", () => {
        if (!restoreRunIsCurrent()) return;
        if (sendFollowActive) {
          parkedAnchorRef.current = null;
          clearScrollRestoreSession();
          stickToBottom("chat-restore:send-follow", {
            resetSavedPosition: true,
            persist: true,
          });
          scheduleRestoreMemoryPersist("chat-restore:send-follow");
          return;
        }

        if (savedPosition?.isAtBottom) {
          parkedAnchorRef.current = null;
          clearScrollRestoreSession();
          current.scrollTo({ top: current.scrollHeight });
          scheduleBottomSettle("chat-restore:bottom-settle");
          scheduleRestoreMemoryPersist("chat-restore:bottom");
          return;
        }

        if (savedPosition && restoreChatMessageAnchor(current, savedPosition)) {
          parkedAnchorRef.current = savedPosition;
          scheduleAnchorSettle(savedPosition, "chat-restore:settle");
          scheduleRestoreMemoryPersist("chat-restore");
          return;
        }

        const targetIndex = findChatHistoryItemIndexForAnchor(
          currentItems,
          savedPosition
        );
        if (savedPosition && targetIndex >= 0 && shouldVirtualize) {
          rowVirtualizer.scrollToIndex(targetIndex, { align: "start" });
          parkedAnchorRef.current = savedPosition;
          scheduleAnchorSettle(savedPosition, "chat-restore:index-settle");
          return;
        }

        const fallbackTop = savedChatScrollTopFallback(savedPosition, {
          firstItemId: currentItems[0]?.id || null,
          lastItemId: currentItems[currentItems.length - 1]?.id || null,
          scrollHeight: current.scrollHeight,
          clientHeight: current.clientHeight,
        });
        current.scrollTo({
          top: fallbackTop === null ? current.scrollHeight : fallbackTop,
        });
        scheduleRestoreMemoryPersist("chat-restore:fallback");
      });
      const isBottom =
        current.scrollHeight - current.scrollTop - current.clientHeight < 2;
      const isNearBottom =
        current.scrollHeight - current.scrollTop - current.clientHeight <=
        CHAT_SCROLL_BOTTOM_TOLERANCE_PX;
      shouldFollowOutputRef.current =
        sendFollowActive ||
        savedPosition?.isAtBottom === true ||
        (!hasSavedPosition && isBottom);
      setIsAtBottom(isBottom);
      setIsNearBottom(isNearBottom);
      setIsUserScrolling(!isNearBottom);
      lastScrollTopRef.current = current.scrollTop;
    });
    restoreHandles.frames.push(frame);
    return () => {
      if (!isChatRestoreRunCurrent(chatRestoreRunRef.current, restoreRunId))
        return;
      clearPendingChatRestore("chat-restore:effect-cleanup");
    };
  }, [
    beginScrollRestoreSession,
    chatKey,
    clearChatRestoreHandles,
    clearPendingChatRestore,
    clearScrollRestoreSession,
    guardProgrammaticScroll,
    items.length,
    persistedScrollMemory,
    rowVirtualizer,
    scheduleLayoutTransitionRestore,
    shouldVirtualize,
    stickToBottom,
  ]);

  useLayoutEffect(() => {
    if (!sendScrollRequest) return;

    activateSendFollow(sendScrollRequest, "send-scroll");
    setIsUserScrolling(false);
    setIsAtBottom(true);
    setIsNearBottom(true);
    persistBottomScrollMemory("send-scroll:start");
    scheduleStickToBottom("send-scroll", {
      resetSavedPosition: true,
      persist: true,
    });

    return undefined;
  }, [
    activateSendFollow,
    persistBottomScrollMemory,
    scheduleStickToBottom,
    sendScrollRequest,
  ]);

  useLayoutEffect(() => {
    const tailHydrationKey =
      chatKey && tailHydrationSignal?.seq
        ? [
            chatKey,
            tailHydrationSignal.seq,
            tailHydrationSignal.chatId || "",
            tailHydrationSignal.turnId || "",
          ].join(":")
        : null;
    if (
      !tailHydrationKey ||
      lastTailHydrationKeyRef.current === tailHydrationKey
    ) {
      return;
    }
    lastTailHydrationKeyRef.current = tailHydrationKey;

    const element = chatHistoryRef.current;
    if (!element) return;

    const savedPosition = normalizeChatScrollPosition(
      scrollPositionsRef.current[chatKey]
    );
    const currentIsAtBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 2;
    const sendFollowActive = sendFollowRef.current.active;
    const decision = tailHydrationFollowDecision({
      signalChanged: true,
      isAtBottom: currentIsAtBottom || sendFollowActive,
      shouldFollowOutput: shouldFollowOutputRef.current || sendFollowActive,
      hasParkedAnchor: sendFollowActive ? false : !!parkedAnchorRef.current,
      hasSavedPosition: sendFollowActive ? false : !!savedPosition,
      hasRecentUserIntent: hasRecentChatUserScrollIntent(
        userScrollIntentRef.current
      ),
      isLoadingOlderHistory,
      hasPrependRestoreRequest: !!prependRestoreRequestRef.current,
    });

    debugChatTurn("ChatHistory:tailHydration", {
      chatKey,
      tailHydrationChatId: tailHydrationSignal.chatId || null,
      tailHydrationTurnId: tailHydrationSignal.turnId || null,
      allowedToFollowBottom: decision.shouldFollowBottom,
      blockedByUserIntent: decision.blockedByUserIntent,
      blockedByOlderHistory: decision.blockedByOlderHistory,
      sendFollowActive,
    });

    if (!decision.shouldFollowBottom) return;

    shouldFollowOutputRef.current = true;
    parkedAnchorRef.current = null;
    clearSavedChatScrollPosition(scrollPositionsRef.current, chatKey);
    setIsUserScrolling(false);
    setIsAtBottom(true);
    setIsNearBottom(true);
    scheduleStickToBottom("tail-hydration", {
      resetSavedPosition: true,
      persist: true,
    });
    return undefined;
  }, [
    chatKey,
    isLoadingOlderHistory,
    scheduleStickToBottom,
    tailHydrationSignal?.chatId,
    tailHydrationSignal?.seq,
    tailHydrationSignal?.turnId,
  ]);

  useLayoutEffect(() => {
    const tailCleanupKey =
      chatKey && tailCleanupSignal?.seq
        ? [
            chatKey,
            tailCleanupSignal.seq,
            (tailCleanupSignal.turnIds || []).join(","),
            tailCleanupSignal.reason || "",
          ].join(":")
        : null;
    if (!tailCleanupKey || lastTailCleanupKeyRef.current === tailCleanupKey) {
      return;
    }
    lastTailCleanupKeyRef.current = tailCleanupKey;

    const element = chatHistoryRef.current;
    if (!element) return;

    const removedItemIds = new Set(tailCleanupSignal.removedItemIds || []);
    if (
      parkedAnchorRef.current?.itemId &&
      removedItemIds.has(parkedAnchorRef.current.itemId)
    ) {
      parkedAnchorRef.current = null;
    }
    if (
      scrollRestoreSessionRef.current.anchor?.itemId &&
      removedItemIds.has(scrollRestoreSessionRef.current.anchor.itemId)
    ) {
      clearScrollRestoreSession();
    }

    const savedPosition = normalizeChatScrollPosition(
      scrollPositionsRef.current[chatKey]
    );
    const currentIsAtBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 2;
    const sendFollowActive = sendFollowRef.current.active;
    const decision = tailCleanupFollowDecision({
      signalChanged: true,
      isAtBottom: currentIsAtBottom || sendFollowActive,
      shouldFollowOutput: shouldFollowOutputRef.current || sendFollowActive,
      hasParkedAnchor: sendFollowActive ? false : !!parkedAnchorRef.current,
      hasSavedPosition: sendFollowActive ? false : !!savedPosition,
      hasRecentUserIntent: hasRecentChatUserScrollIntent(
        userScrollIntentRef.current
      ),
      isLoadingOlderHistory,
      hasPrependRestoreRequest: !!prependRestoreRequestRef.current,
    });

    debugChatTurn("ChatHistory:tailCleanup", {
      chatKey,
      removedTurnIds: tailCleanupSignal.turnIds || [],
      reason: tailCleanupSignal.reason || null,
      allowedToFollowBottom: decision.shouldFollowBottom,
      blockedByUserIntent: decision.blockedByUserIntent,
      blockedByOlderHistory: decision.blockedByOlderHistory,
      sendFollowActive,
    });

    if (!decision.shouldFollowBottom) return;

    shouldFollowOutputRef.current = true;
    parkedAnchorRef.current = null;
    clearSavedChatScrollPosition(scrollPositionsRef.current, chatKey);
    setIsUserScrolling(false);
    setIsAtBottom(true);
    setIsNearBottom(true);
    scheduleStickToBottom("tail-cleanup", {
      resetSavedPosition: true,
      persist: true,
    });
    return undefined;
  }, [
    chatKey,
    clearScrollRestoreSession,
    isLoadingOlderHistory,
    scheduleStickToBottom,
    tailCleanupSignal,
  ]);

  const requestOlderHistoryLoad = useMemo(
    () =>
      debounce(() => {
        if (olderLoadPendingRef.current || isLoadingOlderHistory) return;
        olderLoadPendingRef.current = true;
        const anchor = capturePrependAnchor();
        dispatchScrollEvent({
          type: "OLDER_MESSAGES_LOADING",
          anchorMessageId: anchor?.itemId || null,
          anchorOffset: anchor?.rowOffsetTop || 0,
        });
        onLoadOlderHistory?.();
      }, 100),
    [capturePrependAnchor, isLoadingOlderHistory, onLoadOlderHistory]
  );

  useEffect(() => {
    if (!isLoadingOlderHistory) {
      olderLoadPendingRef.current = false;
      prependRestoreRequestRef.current = null;
      dispatchScrollEvent({ type: "OLDER_MESSAGES_LOADED" });
    }
  }, [isLoadingOlderHistory]);

  useEffect(
    () => () => {
      requestOlderHistoryLoad.cancel();
    },
    [requestOlderHistoryLoad]
  );

  const handleScroll = useCallback(
    (event) => {
      const target = event.currentTarget || event.target;
      const { scrollTop, scrollHeight, clientHeight } = target;
      const intent = getChatScrollIntent({
        chatKey,
        scrollTop,
        scrollHeight,
        clientHeight,
        hasMoreHistory,
        isLoadingOlderHistory,
        programmaticState: programmaticScrollRef.current,
        userIntentState: userScrollIntentRef.current,
      });
      const userIntentSource = userScrollIntentRef.current?.source || null;
      const hasLayoutScrollNavigationIntent =
        intent.hasUserIntent &&
        isExplicitChatScrollNavigationIntent(userIntentSource);
      const scrollDelta = Math.abs(scrollTop - lastScrollTopRef.current);
      const layoutTransitionAgeMs =
        Date.now() - (layoutTransitionRef.current.startedAt || Date.now());
      const hasObservedLayoutScrollNavigationIntent =
        !intent.isProgrammatic &&
        scrollDelta > 8 &&
        layoutTransitionAgeMs > CHAT_SCROLL_LAYOUT_SUPPRESS_MS;
      const hasObservedUserScrollIntent =
        !intent.isProgrammatic &&
        !sendFollowRef.current.active &&
        scrollDelta > 2;
      if (hasObservedUserScrollIntent && !intent.hasUserIntent) {
        markChatUserScrollIntent(
          userScrollIntentRef.current,
          "observed-scroll"
        );
      }
      if (
        intent.hasUserIntent ||
        hasObservedLayoutScrollNavigationIntent ||
        hasObservedUserScrollIntent
      ) {
        clearPendingChatRestore(
          `scroll:${
            intent.hasUserIntent
              ? userIntentSource || "user"
              : "observed-user-scroll"
          }`
        );
      }
      if (
        layoutTransitionRef.current.active &&
        !hasLayoutScrollNavigationIntent &&
        !hasObservedLayoutScrollNavigationIntent
      ) {
        debugChatTurn("ChatHistory:scrollIntentIgnored", {
          chatKey,
          reason: "layout-transition",
          scrollTop,
          isProgrammatic: intent.isProgrammatic,
          source: userIntentSource,
        });
        setIsAtBottom(intent.isPinnedToBottom);
        setIsNearBottom(intent.isNearBottom);
        lastScrollTopRef.current = scrollTop;
        return;
      }
      if (
        layoutTransitionRef.current.active &&
        (hasLayoutScrollNavigationIntent ||
          hasObservedLayoutScrollNavigationIntent)
      ) {
        layoutTransitionRef.current.active = false;
        clearLayoutTransitionHandles();
      }

      const saveVisiblePosition = (
        reason,
        { updateParkedAnchor = true } = {}
      ) => {
        if (intent.isPinnedToBottom) {
          clearSavedChatScrollPosition(scrollPositionsRef.current, chatKey);
          parkedAnchorRef.current = null;
          persistVisibleScrollMemory(`${reason}-bottom`);
          debouncedPersistScrollMemory(`${reason}-bottom:settle`);
        } else {
          const anchor = getFirstVisibleChatMessageAnchor(target);
          if (updateParkedAnchor) parkedAnchorRef.current = anchor;
          scrollPositionsRef.current[chatKey] =
            createChatScrollPositionSnapshot({
              scrollTop,
              scrollHeight,
              clientHeight,
              anchor,
              firstItemId: itemsRef.current[0]?.id || null,
              lastItemId:
                itemsRef.current[itemsRef.current.length - 1]?.id || null,
            });
          persistVisibleScrollMemory(reason);
          debouncedPersistScrollMemory(`${reason}:settle`);
        }
      };

      if (intent.canSavePosition) {
        clearScrollRestoreSession();
        if (!intent.isPinnedToBottom) deactivateSendFollow("user-scroll");
        saveVisiblePosition("user-scroll");
      } else if (
        chatKey &&
        !intent.isProgrammatic &&
        !layoutTransitionRef.current.active &&
        !sendFollowRef.current.active &&
        scrollDelta > 2
      ) {
        clearScrollRestoreSession();
        saveVisiblePosition("observed-scroll", { updateParkedAnchor: false });
      } else {
        debugChatTurn("ChatHistory:scrollIntentIgnored", {
          chatKey,
          reason: "canSavePosition=false",
          isProgrammatic: intent.isProgrammatic,
          source: userScrollIntentRef.current?.source || null,
          hasUserIntent: intent.hasUserIntent,
          isBottom: intent.isPinnedToBottom,
          isNearBottom: intent.isNearBottom,
        });
      }

      if (intent.shouldLeaveFollowOutput) {
        deactivateSendFollow("leave-follow-output");
        shouldFollowOutputRef.current = false;
      }
      if (hasObservedUserScrollIntent && !intent.isPinnedToBottom) {
        deactivateSendFollow("observed-scroll");
        shouldFollowOutputRef.current = false;
      }
      if (intent.shouldEnterFollowOutput) shouldFollowOutputRef.current = true;

      if (
        scrollDelta > 10 &&
        (intent.hasUserIntent || !intent.isProgrammatic)
      ) {
        setIsUserScrolling(!intent.isNearBottom);
      }

      setIsAtBottom(intent.isPinnedToBottom);
      setIsNearBottom(intent.isNearBottom);
      dispatchScrollEvent({
        type: "USER_SCROLLED",
        scrollTop,
        scrollHeight,
        clientHeight,
      });
      lastScrollTopRef.current = scrollTop;

      if (!layoutTransitionRef.current.active && intent.canLoadOlderHistory)
        requestOlderHistoryLoad();
    },
    [
      chatKey,
      clearPendingChatRestore,
      clearLayoutTransitionHandles,
      clearScrollRestoreSession,
      deactivateSendFollow,
      debouncedPersistScrollMemory,
      hasMoreHistory,
      isLoadingOlderHistory,
      persistVisibleScrollMemory,
      requestOlderHistoryLoad,
    ]
  );

  useChatHistoryScrollHandle(ref, {
    setIsUserScrolling,
    isStreaming,
    scrollToBottom,
    scrollToTop,
    beginLayoutTransition: captureLayoutTransitionAnchor,
  });

  useLayoutEffect(() => {
    const element = chatHistoryRef.current;
    if (!element) return;

    const firstId = items[0]?.id || null;
    const previousFirstId = previousFirstItemIdRef.current;
    const firstItemChanged =
      Boolean(previousFirstId && firstId) && previousFirstId !== firstId;
    if (
      shouldRestoreExplicitPrepend({
        hasRestoreRequest: !!prependRestoreRequestRef.current,
        firstItemChanged,
        isAtBottom,
      })
    ) {
      restorePrependAnchor();
    } else if (firstItemChanged) {
      prependRestoreRequestRef.current = null;
    }

    previousFirstItemIdRef.current = firstId;
    const handleInputLayoutChange = (reason) => {
      if (hasRecentUserScrollControl() && !sendFollowRef.current.active) {
        debugChatTurn("ChatHistory:layoutInputMeasureOnly", {
          chatKey,
          reason,
          result: "stream-row-observer-only",
        });
        return;
      }
      rowVirtualizer.measure();
      if (layoutTransitionRef.current.active) {
        scheduleLayoutTransitionRestore(`${reason}:layout-transition`);
      } else if (
        sendFollowRef.current.active &&
        shouldFollowOutputRef.current
      ) {
        stickToBottom(`${reason}:send-follow`, { persist: true });
      } else {
        preserveParkedAnchor(reason);
      }
    };

    handleInputLayoutChange("layout-input");
    scheduleChatLayoutSelfCheck("layout-input");
    const frame = requestAnimationFrame(() => {
      handleInputLayoutChange("layout-input:settle");
      scheduleChatLayoutSelfCheck("layout-input:settle");
    });
    return () => cancelAnimationFrame(frame);
  }, [
    chatKey,
    contentClassName,
    items,
    isAtBottom,
    normalizedBottomInset,
    hasRecentUserScrollControl,
    preserveParkedAnchor,
    restorePrependAnchor,
    rowVirtualizer,
    scheduleChatLayoutSelfCheck,
    scheduleLayoutTransitionRestore,
    stickToBottom,
    textSize,
    textSizeFontSize,
  ]);

  useEffect(() => {
    if (!chatKey || readOnly) return;
    const handleDelete = async (event) => {
      const requestedChatId = Number(event.detail?.chatId);
      if (!Number.isInteger(requestedChatId) || requestedChatId <= 0) return;
      const currentItems = itemsRef.current || [];
      if (!currentItems.some((item) => Number(item.chatId) === requestedChatId))
        return;
      if (!window.confirm("永久删除这一轮对话？此操作无法撤销。")) return;

      const snapshot = [...currentItems];
      const optimisticItems = currentItems.filter(
        (item) => Number(item.chatId) !== requestedChatId
      );
      replaceDraftItems(chatKey, optimisticItems);
      const sourceActionId =
        globalThis.crypto?.randomUUID?.() ||
        `chat-delete-${Date.now()}-${requestedChatId}`;
      try {
        await Workspace.deleteChatTurn(
          workspace.slug,
          effectiveThreadSlug,
          event.detail?.publicChatId || requestedChatId,
          { sourceActionId }
        );
      } catch (error) {
        replaceDraftItems(chatKey, snapshot);
        window.alert(error?.message || "删除失败，请稍后重试。");
      }
    };
    window.addEventListener(DELETE_EVENT, handleDelete);
    return () => window.removeEventListener(DELETE_EVENT, handleDelete);
  }, [
    chatKey,
    effectiveThreadSlug,
    readOnly,
    replaceDraftItems,
    workspace.slug,
  ]);

  const forkThread = async (chatId, publicChatId = null) => {
    const newThreadSlug = await Workspace.forkThread(
      workspace.slug,
      effectiveThreadSlug,
      publicChatId || chatId
    );
    navigate(paths.workspace.thread(workspace.slug, newThreadSlug));
  };

  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items]
  );
  const itemLayoutSignatures = useMemo(
    () =>
      new Map(
        items.map((item) => [item.id, chatHistoryItemLayoutSignature(item)])
      ),
    [items]
  );
  const lastAssistantTurnId = [...items]
    .reverse()
    .find((item) => item.type === "assistant_turn")?.id;
  const renderMessageRow = useCallback(
    (item) => (
      <MessageRow
        key={item.id}
        item={item}
        itemById={itemById}
        workspace={workspace}
        chatKey={chatKey}
        approvalState={approvalState}
        onToolApprovalResponse={onToolApprovalResponse}
        onGenerateMindMap={onGenerateMindMap}
        regenerateAssistantMessage={regenerateAssistantMessage}
        saveEditedMessage={null}
        forkThread={forkThread}
        readOnly={readOnly}
        isLastAssistantTurn={item.id === lastAssistantTurnId}
        onContentLayoutChange={(reason = "content-layout") => {
          const resolvedReason =
            reason === "content-layout" ? "content-layout" : reason;
          debugChatTurn("ChatHistory:onContentLayoutChange", {
            chatKey,
            itemId: item.id,
            reason: resolvedReason,
          });
          scheduleChatLayoutSelfCheck(resolvedReason);
        }}
      />
    ),
    [
      approvalState,
      chatKey,
      forkThread,
      itemById,
      lastAssistantTurnId,
      scheduleChatLayoutSelfCheck,
      onGenerateMindMap,
      onToolApprovalResponse,
      readOnly,
      regenerateAssistantMessage,
      workspace,
    ]
  );
  const renderStaticMessageRow = useCallback(
    (item, index) => (
      <div
        key={item.id}
        data-chat-message-row="true"
        data-index={index}
        data-item-id={item.id}
        className="w-full"
      >
        {renderMessageRow(item)}
      </div>
    ),
    [renderMessageRow]
  );
  const markKeyboardScrollIntent = useCallback(
    (event) => {
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      ) {
        markUserScrollIntentFor("keyboard");
        const movingUp =
          ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
          (event.key === " " && event.shiftKey);
        if (movingUp) {
          deactivateSendFollow("keyboard-up");
          shouldFollowOutputRef.current = false;
        }
      }
    },
    [deactivateSendFollow, markUserScrollIntentFor]
  );
  const markPointerScrollIntent = useCallback(
    (event) => {
      if (event.target === event.currentTarget) {
        markUserScrollIntentFor("pointer");
        deactivateSendFollow("pointer");
        shouldFollowOutputRef.current = false;
      }
    },
    [deactivateSendFollow, markUserScrollIntentFor]
  );
  const markWheelScrollIntent = useCallback(
    (event) => {
      markUserScrollIntentFor("wheel");
      if (event.deltaY < 0) {
        deactivateSendFollow("wheel-up");
        shouldFollowOutputRef.current = false;
      }
    },
    [deactivateSendFollow, markUserScrollIntentFor]
  );
  const markTouchScrollIntent = useCallback(() => {
    markUserScrollIntentFor("touch");
    deactivateSendFollow("touch-drag");
    shouldFollowOutputRef.current = false;
  }, [deactivateSendFollow, markUserScrollIntentFor]);

  return (
    <MessageActionsProvider>
      <ThoughtExpansionProvider chatKey={chatKey}>
        <div
          className={`markdown chatgpt-mobile-chat text-white/80 light:text-theme-text-primary font-light ${textSizeClass} h-full pb-4 pt-6 md:pt-0 md:pb-4 md:mx-0 overflow-y-scroll flex flex-col items-center justify-start ${showScrollbar ? "show-scrollbar" : "no-scroll"}`}
          id="chat-history"
          ref={chatHistoryRef}
          onScroll={handleScroll}
          onWheel={markWheelScrollIntent}
          onTouchStart={() => markUserScrollIntentFor("touch")}
          onTouchMove={markTouchScrollIntent}
          onPointerDown={markPointerScrollIntent}
          onKeyDown={markKeyboardScrollIntent}
          style={{
            ...mobileSystemFontStyle,
            ...chatTextSizeStyle,
            ...scrollContainerStyle,
          }}
        >
          <div
            className={`athena-chat-history-width w-full max-w-[920px] ${contentClassName}`}
          >
            {isLoadingOlderHistory && (
              <div className="motion-skeleton h-12 rounded-md mb-2" />
            )}
            {shouldVirtualize ? (
              <div
                data-virtual-message-stack="true"
                className="relative w-full"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const item = items[virtualRow.index];
                  if (!item) return null;
                  return (
                    <VirtualMessageRow
                      key={virtualRow.key}
                      itemId={item.id}
                      layoutSignature={[
                        rowLayoutContextKey,
                        itemLayoutSignatures.get(item.id) || "",
                      ].join(":")}
                      virtualRow={virtualRow}
                      virtualizer={rowVirtualizer}
                      isStreamingRow={
                        item.type === "assistant_turn" &&
                        item.status === "running"
                      }
                    >
                      {renderMessageRow(item)}
                    </VirtualMessageRow>
                  );
                })}
              </div>
            ) : (
              items.map(renderStaticMessageRow)
            )}
          </div>
          {showing && (
            <ManageWorkspace
              hideModal={hideModal}
              providedSlug={workspace.slug}
            />
          )}
        </div>
        {(!isNearBottom || scrollCoordinatorState.hasNewMessagesBelow) && (
          <div
            className="athena-chat-scroll-bottom-button absolute bottom-40 right-10 z-50 cursor-pointer animate-pulse"
            style={scrollBottomButtonStyle}
          >
            <div className="flex flex-col items-center">
              {scrollCoordinatorState.hasNewMessagesBelow && (
                <div className="mb-2 rounded-full border border-sky-300/30 bg-sky-500/15 px-3 py-1 text-xs font-medium text-sky-100 shadow-lg backdrop-blur light:border-sky-500/30 light:bg-sky-100 light:text-sky-700">
                  新消息
                </div>
              )}
              <div
                className="p-1 rounded-full border border-white/10 bg-white/10 hover:bg-white/20 hover:text-white"
                onClick={() => {
                  dispatchScrollEvent({ type: "JUMP_TO_BOTTOM" });
                  shouldFollowOutputRef.current = true;
                  scrollToBottom(isStreaming ? false : true, {
                    reason: "jump-bottom-button",
                    resetSavedPosition: true,
                  });
                  window.requestAnimationFrame(() => {
                    persistScrollMemoryRef.current?.("jump-bottom-button");
                  });
                  setIsAtBottom(true);
                  setIsNearBottom(true);
                  setIsUserScrolling(false);
                }}
              >
                <ArrowDown weight="bold" className="text-white/60 w-5 h-5" />
              </div>
            </div>
          </div>
        )}
      </ThoughtExpansionProvider>
    </MessageActionsProvider>
  );
});

function inspectChatHistoryVisibleLayout(
  element,
  { itemCount = 0, virtualTotalSize = 0 } = {}
) {
  const viewport = element.getBoundingClientRect();
  const rowElements = Array.from(
    element.querySelectorAll('[data-virtual-message-row="true"]')
  );
  const rows = rowElements
    .map((rowElement) => {
      const rect = rowElement.getBoundingClientRect();
      return {
        index: Number(rowElement.dataset.index),
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        textLength: rowElement.textContent?.trim().length || 0,
      };
    })
    .filter(
      (row) => row.bottom > viewport.top - 1 && row.top < viewport.bottom + 1
    )
    .sort((a, b) => a.top - b.top);

  const overlaps = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const gap = current.top - previous.bottom;
    if (gap < CHAT_LAYOUT_OVERLAP_TOLERANCE_PX) {
      overlaps.push({
        previousIndex: previous.index,
        currentIndex: current.index,
        gap,
      });
    }
  }

  const tinyRows = rows.filter(
    (row) => row.textLength > 0 && row.height < CHAT_LAYOUT_MIN_ROW_HEIGHT_PX
  );
  const stackElement = element.querySelector(
    '[data-virtual-message-stack="true"]'
  );
  const stackRect = stackElement?.getBoundingClientRect();
  const maxRenderedBottom = stackRect
    ? Math.max(
        0,
        ...rowElements.map(
          (rowElement) =>
            rowElement.getBoundingClientRect().bottom - stackRect.top
        )
      )
    : 0;
  const stackTooSmall =
    Boolean(stackRect) &&
    (maxRenderedBottom > stackRect.height + 2 ||
      (virtualTotalSize > 0 && maxRenderedBottom > virtualTotalSize + 2));
  const missingRows =
    itemCount > 80 && virtualTotalSize > 0 && !rowElements.length;

  return {
    hasIssue:
      overlaps.length > 0 ||
      tinyRows.length > 0 ||
      stackTooSmall ||
      missingRows,
    overlaps: overlaps.slice(0, 3),
    tinyRowCount: tinyRows.length,
    stackTooSmall,
    missingRows,
    visibleRowCount: rows.length,
    renderedRowCount: rowElements.length,
  };
}

function chatHistoryArrayLayoutSignature(items = [], pickLast = null) {
  if (!Array.isArray(items) || items.length === 0) return "0";
  const last = items[items.length - 1] || {};
  return `${items.length}:${
    pickLast ? pickLast(last) : last.id || last.type || ""
  }`;
}

function chatHistoryContentLength(value) {
  return typeof value === "string" ? value.length : 0;
}

function chatHistoryItemLayoutSignature(item = {}) {
  if (!item) return "";

  if (item.type === "assistant_turn") {
    return [
      item.type,
      item.id,
      item.turnId || "",
      item.chatId || "",
      item.status || "",
      item.hydrationStatus || "",
      chatHistoryContentLength(item.finalContent),
      chatHistoryArrayLayoutSignature(
        item.timeline,
        (event) =>
          `${event.id || event.uuid || event.type || ""}:${
            event.status || ""
          }:${chatHistoryContentLength(
            event.content || event.text || event.message
          )}`
      ),
      chatHistoryArrayLayoutSignature(
        item.outputs,
        (output) => `${output.id || output.type || ""}:${output.status || ""}`
      ),
      chatHistoryArrayLayoutSignature(item.sourceDocuments),
      chatHistoryArrayLayoutSignature(item.readerTextSources),
    ].join("|");
  }

  return [
    item.type,
    item.id,
    item.chatId || "",
    item.turnId || "",
    item.hydrationStatus || "",
    chatHistoryContentLength(item.content),
    chatHistoryArrayLayoutSignature(item.attachments),
    chatHistoryArrayLayoutSignature(item.readerTextSources),
    chatHistoryArrayLayoutSignature(item.outputs),
  ].join("|");
}

function VirtualMessageRow({
  itemId,
  layoutSignature,
  virtualRow,
  virtualizer,
  isStreamingRow = false,
  children,
}) {
  const elementRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const mutationObserverRef = useRef(null);
  const measureFrameRef = useRef(null);
  const settleFrameRef = useRef(null);

  const measure = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    virtualizer.measureElement(element);
  }, [virtualizer]);

  const clearMeasureFrames = useCallback(() => {
    if (measureFrameRef.current) {
      cancelAnimationFrame(measureFrameRef.current);
      measureFrameRef.current = null;
    }
    if (settleFrameRef.current) {
      cancelAnimationFrame(settleFrameRef.current);
      settleFrameRef.current = null;
    }
  }, []);

  const scheduleMeasure = useCallback(() => {
    clearMeasureFrames();
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measure();
      if (!isStreamingRow) {
        settleFrameRef.current = requestAnimationFrame(() => {
          settleFrameRef.current = null;
          measure();
        });
      }
    });
  }, [clearMeasureFrames, isStreamingRow, measure]);

  const disconnectObservers = useCallback(() => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    mutationObserverRef.current?.disconnect();
    mutationObserverRef.current = null;
    clearMeasureFrames();
  }, [clearMeasureFrames]);

  const setElement = useCallback(
    (element) => {
      disconnectObservers();
      elementRef.current = element;
      if (!element) return;

      virtualizer.measureElement(element);
      scheduleMeasure();
      if (typeof ResizeObserver !== "undefined") {
        resizeObserverRef.current = new ResizeObserver(scheduleMeasure);
        resizeObserverRef.current.observe(element);
      }
      if (!isStreamingRow && typeof MutationObserver !== "undefined") {
        mutationObserverRef.current = new MutationObserver(scheduleMeasure);
        mutationObserverRef.current.observe(element, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
    },
    [disconnectObservers, isStreamingRow, scheduleMeasure, virtualizer]
  );

  useLayoutEffect(() => {
    scheduleMeasure();
    return clearMeasureFrames;
  }, [clearMeasureFrames, itemId, layoutSignature, scheduleMeasure]);

  useEffect(() => {
    return disconnectObservers;
  }, [disconnectObservers]);

  return (
    <div
      ref={setElement}
      data-chat-message-row="true"
      data-virtual-message-row="true"
      data-index={virtualRow.index}
      data-item-id={itemId}
      className="absolute left-0 top-0 w-full"
      style={{
        transform: `translateY(${virtualRow.start}px)`,
      }}
    >
      {children}
    </div>
  );
}

const CHAT_INNER_ANCHOR_SELECTOR = [
  "[data-chat-anchor-block='true']",
  "p",
  "li",
  "pre",
  "blockquote",
  "td",
  "th",
  "table",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "img",
  "video",
  "button",
].join(",");

function getFirstVisibleChatMessageAnchor(element) {
  const viewport = element.getBoundingClientRect();
  const rows = Array.from(
    element.querySelectorAll('[data-chat-message-row="true"]')
  );
  const row = rows.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1;
  });
  if (!row) return null;

  const rect = row.getBoundingClientRect();
  return {
    itemId: row.dataset.itemId || null,
    offsetTop: rect.top - viewport.top,
    rowOffsetTop: rect.top - viewport.top,
    innerAnchor: getFirstVisibleInnerAnchor(row, viewport),
  };
}

function restoreChatMessageAnchor(element, anchor) {
  if (!anchor?.itemId) return false;

  const viewport = element.getBoundingClientRect();
  const rows = Array.from(
    element.querySelectorAll('[data-chat-message-row="true"]')
  );
  const row = rows.find(
    (candidate) => candidate.dataset.itemId === anchor.itemId
  );
  if (!row) {
    debugChatTurn("ChatHistory:restoreAnchorMissing", {
      anchorItemId: anchor.itemId,
      rowCount: rows.length,
    });
    return false;
  }

  if (
    anchor.innerAnchor &&
    restoreInnerAnchor(element, row, anchor.innerAnchor)
  ) {
    return true;
  }

  const rect = row.getBoundingClientRect();
  const rowOffsetTop = Number(anchor.rowOffsetTop ?? anchor.offsetTop);
  element.scrollTop +=
    rect.top -
    viewport.top -
    (Number.isFinite(rowOffsetTop) ? rowOffsetTop : 0);
  return true;
}

function getCandidateInnerAnchorBlocks(row) {
  const rawCandidates = Array.from(
    row.querySelectorAll(CHAT_INNER_ANCHOR_SELECTOR)
  );
  const meaningfulCandidates = rawCandidates
    .filter((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.height > 0 && rect.width > 0;
    })
    .filter((candidate) => {
      const text = candidate.textContent?.trim() || "";
      return (
        text.length > 0 || ["IMG", "VIDEO", "TABLE"].includes(candidate.tagName)
      );
    });
  const candidates = meaningfulCandidates.filter((candidate) => {
    if (["IMG", "VIDEO"].includes(candidate.tagName)) return true;
    return !meaningfulCandidates.some(
      (other) => other !== candidate && candidate.contains(other)
    );
  });
  return candidates.length ? candidates : [row];
}

function anchorBlockFingerprint(block) {
  const fingerprintSource =
    block.textContent ||
    block.getAttribute("alt") ||
    block.getAttribute("aria-label") ||
    block.tagName ||
    "";
  return textFingerprint(fingerprintSource);
}

function getFirstVisibleInnerAnchor(row, viewport) {
  const blocks = getCandidateInnerAnchorBlocks(row);
  const blockIndex = blocks.findIndex((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1;
  });
  if (blockIndex < 0) return null;

  const block = blocks[blockIndex];
  const rect = block.getBoundingClientRect();
  return {
    blockIndex,
    offsetTop: rect.top - viewport.top,
    textFingerprint: anchorBlockFingerprint(block),
  };
}

function restoreInnerAnchor(element, row, innerAnchor) {
  const blocks = getCandidateInnerAnchorBlocks(row);
  if (!blocks.length) return false;

  const expectedFingerprint = innerAnchor.textFingerprint || null;
  const fingerprintMatchIndex = expectedFingerprint
    ? blocks.findIndex(
        (candidate) => anchorBlockFingerprint(candidate) === expectedFingerprint
      )
    : -1;
  const requestedIndex = Number(innerAnchor.blockIndex);
  const fallbackIndex = Number.isFinite(requestedIndex)
    ? Math.max(0, Math.min(blocks.length - 1, requestedIndex))
    : 0;
  const block =
    blocks[fingerprintMatchIndex >= 0 ? fingerprintMatchIndex : fallbackIndex];
  if (!block) return false;

  const viewport = element.getBoundingClientRect();
  const rect = block.getBoundingClientRect();
  const offsetTop = Number(innerAnchor.offsetTop);
  element.scrollTop +=
    rect.top - viewport.top - (Number.isFinite(offsetTop) ? offsetTop : 0);
  return true;
}

function chatHistoryItemRole(item = null) {
  if (!item) return null;
  if (item.role) return item.role;
  if (item.type === "assistant_turn") return "assistant";
  if (item.type === "user") return "user";
  return item.type || null;
}

function findChatHistoryItemIndexForAnchor(items = [], anchor = null) {
  if (!anchor) return -1;
  const itemId = anchor.itemId ? String(anchor.itemId) : null;
  if (itemId) {
    const byItemId = items.findIndex((item) => item?.id === itemId);
    if (byItemId >= 0) return byItemId;
  }

  const chatId = Number(anchor.chatId);
  const role = anchor.role ? String(anchor.role) : null;
  if (!Number.isFinite(chatId)) return -1;
  return items.findIndex(
    (item) =>
      Number(item?.chatId) === chatId &&
      (!role || chatHistoryItemRole(item) === role)
  );
}

function findChatHistoryItemForAnchor(items = [], anchor = null) {
  const index = findChatHistoryItemIndexForAnchor(items, anchor);
  return index >= 0 ? items[index] : null;
}

const MessageRow = memo(
  function MessageRow({
    item,
    itemById,
    workspace,
    chatKey,
    approvalState,
    onToolApprovalResponse,
    onGenerateMindMap,
    regenerateAssistantMessage,
    saveEditedMessage,
    forkThread,
    readOnly,
    isLastAssistantTurn,
    onContentLayoutChange,
  }) {
    if (item.type === "user") {
      return (
        <HistoricalMessage
          uuid={item.id}
          message={item.content}
          role="user"
          workspace={workspace}
          chatKey={chatKey}
          turnId={item.turnId}
          chatId={item.chatId}
          publicChatId={item.publicChatId}
          attachments={item.attachments}
          readerTextSources={item.readerTextSources}
          hydrationStatus={item.hydrationStatus}
          saveEditedMessage={saveEditedMessage}
          forkThread={forkThread}
          readOnly={readOnly}
        />
      );
    }

    if (item.type === "assistant_turn") {
      return (
        <AssistantTurn
          turn={item}
          userItem={itemById.get(item.userMessageId)}
          workspace={workspace}
          chatKey={chatKey}
          approvalState={approvalState}
          onToolApprovalResponse={onToolApprovalResponse}
          onGenerateMindMap={onGenerateMindMap}
          regenerateMessage={regenerateAssistantMessage}
          saveEditedMessage={saveEditedMessage}
          forkThread={forkThread}
          readOnly={readOnly}
          isLastMessage={isLastAssistantTurn}
          onContentLayoutChange={onContentLayoutChange}
        />
      );
    }

    return null;
  },
  (prevProps, nextProps) =>
    prevProps.item === nextProps.item &&
    prevProps.workspace === nextProps.workspace &&
    prevProps.chatKey === nextProps.chatKey &&
    prevProps.approvalState === nextProps.approvalState &&
    prevProps.readOnly === nextProps.readOnly &&
    prevProps.isLastAssistantTurn === nextProps.isLastAssistantTurn &&
    prevProps.onContentLayoutChange === nextProps.onContentLayoutChange
);
