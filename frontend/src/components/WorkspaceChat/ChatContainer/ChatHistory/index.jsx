import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
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
import { MessageActionsProvider } from "./MessageActionsContext";
import { useChatThreadDrafts } from "@/contexts/ChatThreadDraftProvider";
import { debugChatTurn } from "@/utils/chat/debug";
import {
  CHAT_SCROLL_PROGRAMMATIC_SUPPRESS_MS,
  CHAT_SCROLL_SMOOTH_SUPPRESS_MS,
  clearSavedChatScrollPosition,
  getChatScrollIntent,
  markChatUserScrollIntent,
  markProgrammaticChatScroll,
} from "@/utils/chat/chatScrollIntent";

const CHAT_LAYOUT_OVERLAP_TOLERANCE_PX = -2;
const CHAT_LAYOUT_MIN_ROW_HEIGHT_PX = 4;
const CHAT_LAYOUT_FALLBACK_AFTER_RECOVERIES = 2;
const CHAT_LAYOUT_SELF_CHECK_INTERVAL_MS = 1500;

export default forwardRef(function (
  {
    items = [],
    workspace,
    sendCommand,
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
  const prependAnchorRef = useRef(null);
  const olderLoadPendingRef = useRef(false);
  const chatHistoryRef = useRef(null);
  const previousScrollHeightRef = useRef(0);
  const previousFirstItemIdRef = useRef(null);
  const layoutCheckFrameRef = useRef(null);
  const layoutCheckSettleFrameRef = useRef(null);
  const layoutRecoveryPassesRef = useRef(0);
  const { threadSlug = null } = useParams();
  const effectiveThreadSlug =
    activeThreadSlug === undefined ? threadSlug : activeThreadSlug;
  const navigate = useNavigate();
  const { showing, hideModal } = useManageWorkspaceModal();
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [, setIsUserScrolling] = useState(false);
  const isStreaming = items.some(
    (item) => item.type === "assistant_turn" && item.status === "running"
  );
  const { showScrollbar } = Appearance.getSettings();
  const { textSize, textSizeClass, textSizeStyle } = useTextSize();
  const { updateAssistantTurn, updateUserItem } = useChatThreadDrafts();
  const baseShouldVirtualize = items.length > 80;
  const [layoutFallbackActive, setLayoutFallbackActive] = useState(false);
  const shouldVirtualize = baseShouldVirtualize && !layoutFallbackActive;
  const normalizedBottomInset =
    Number.isFinite(bottomInset) && bottomInset >= 0 ? bottomInset : null;
  const textSizeFontSize = textSizeStyle?.fontSize || "";
  const rowLayoutContextKey = [
    textSize || "",
    textSizeFontSize,
    contentClassName,
    normalizedBottomInset ?? "",
  ].join(":");
  const scrollContainerStyle =
    normalizedBottomInset === null
      ? undefined
      : { paddingBottom: `${normalizedBottomInset}px` };
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

  const markUserScrollIntentFor = useCallback((source = "scroll") => {
    programmaticScrollGenerationRef.current += 1;
    programmaticScrollRef.current.reason = null;
    programmaticScrollRef.current.until = 0;
    markChatUserScrollIntent(userScrollIntentRef.current, source);
  }, []);

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
          window.requestAnimationFrame(() => {
            if (programmaticScrollGenerationRef.current !== generation) return;
            markProgrammaticChatScroll(
              programmaticScrollRef.current,
              `${reason}:settle`,
              Date.now(),
              durationMs
            );
          });
        }
      }
      return result;
    },
    []
  );

  const capturePrependAnchor = useCallback(() => {
    const element = chatHistoryRef.current;
    if (!element) return null;
    prependAnchorRef.current = getFirstVisibleChatMessageAnchor(element);
    return prependAnchorRef.current;
  }, []);

  const restorePrependAnchor = useCallback(
    (previousScrollHeight = 0) => {
      const element = chatHistoryRef.current;
      if (!element) return false;

      const anchor = prependAnchorRef.current;
      prependAnchorRef.current = null;
      guardProgrammaticScroll("older-history-anchor", () => {
        if (anchor && restoreChatMessageAnchor(element, anchor)) return;
        element.scrollTop += Math.max(
          element.scrollHeight - previousScrollHeight,
          0
        );
      });
      return true;
    },
    [guardProgrammaticScroll]
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
      }

      guardProgrammaticScroll(
        reason,
        () => {
          element.scrollTo({
            top: element.scrollHeight,
            ...(smooth ? { behavior: "smooth" } : {}),
          });
        },
        smooth
          ? CHAT_SCROLL_SMOOTH_SUPPRESS_MS
          : CHAT_SCROLL_PROGRAMMATIC_SUPPRESS_MS
      );
    },
    [chatKey, guardProgrammaticScroll]
  );

  const scrollToTop = useCallback(
    (smooth = true) => {
      const element = chatHistoryRef.current;
      if (!element) return;

      markUserScrollIntentFor("shortcut-top");
      shouldFollowOutputRef.current = false;
      setIsUserScrolling(true);
      element.scrollTo({
        top: 0,
        ...(smooth ? { behavior: "smooth" } : {}),
      });
    },
    [markUserScrollIntentFor]
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

      layoutRecoveryPassesRef.current += 1;
      measureVisibleVirtualRows();
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
      rowVirtualizer,
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
  }, [chatKey, clearLayoutCheckFrames]);

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
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false;
      return;
    }
    if (shouldFollowOutputRef.current) {
      scrollToBottom(false, { reason: "items-follow" });
    }
  }, [items, scrollToBottom]);

  useLayoutEffect(() => {
    const element = chatHistoryRef.current;
    if (!element || !chatKey) return;

    suppressAutoScrollRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      const current = chatHistoryRef.current;
      if (!current) return;

      const savedScrollTop = scrollPositionsRef.current[chatKey];
      const hasSavedScrollTop = typeof savedScrollTop === "number";
      const nextScrollTop = hasSavedScrollTop
        ? savedScrollTop
        : current.scrollHeight;
      guardProgrammaticScroll("chat-restore", () => {
        current.scrollTo({ top: nextScrollTop });
      });
      const isBottom =
        current.scrollHeight - current.scrollTop - current.clientHeight < 2;
      shouldFollowOutputRef.current = !hasSavedScrollTop && isBottom;
      setIsAtBottom(isBottom);
      setIsUserScrolling(!isBottom);
      lastScrollTopRef.current = current.scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chatKey, guardProgrammaticScroll]);

  useLayoutEffect(() => {
    if (!sendScrollRequest) return;

    setIsUserScrolling(false);
    setIsAtBottom(true);
    shouldFollowOutputRef.current = true;
    clearSavedChatScrollPosition(scrollPositionsRef.current, chatKey);
    scrollToBottom(true, {
      reason: "send-scroll",
      resetSavedPosition: true,
    });

    const frame = window.requestAnimationFrame(() => {
      scrollToBottom(true, {
        reason: "send-scroll:settle",
        resetSavedPosition: true,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chatKey, sendScrollRequest, scrollToBottom]);

  const requestOlderHistoryLoad = useMemo(
    () =>
      debounce(() => {
        if (olderLoadPendingRef.current || isLoadingOlderHistory) return;
        olderLoadPendingRef.current = true;
        capturePrependAnchor();
        onLoadOlderHistory?.();
      }, 100),
    [capturePrependAnchor, isLoadingOlderHistory, onLoadOlderHistory]
  );

  useEffect(() => {
    if (!isLoadingOlderHistory) olderLoadPendingRef.current = false;
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

      if (intent.canSavePosition) {
        if (intent.isBottom) {
          clearSavedChatScrollPosition(scrollPositionsRef.current, chatKey);
        } else {
          scrollPositionsRef.current[chatKey] = scrollTop;
        }
      }

      if (intent.shouldLeaveFollowOutput) shouldFollowOutputRef.current = false;
      if (intent.shouldEnterFollowOutput) shouldFollowOutputRef.current = true;

      if (
        Math.abs(scrollTop - lastScrollTopRef.current) > 10 &&
        (intent.hasUserIntent || !intent.isProgrammatic)
      ) {
        setIsUserScrolling(!intent.isBottom);
      }

      setIsAtBottom(intent.isBottom);
      lastScrollTopRef.current = scrollTop;

      if (intent.canLoadOlderHistory) requestOlderHistoryLoad();
    },
    [chatKey, hasMoreHistory, isLoadingOlderHistory, requestOlderHistoryLoad]
  );

  useChatHistoryScrollHandle(ref, {
    setIsUserScrolling,
    isStreaming,
    scrollToBottom,
    scrollToTop,
  });

  useLayoutEffect(() => {
    const element = chatHistoryRef.current;
    if (!element) return;

    const firstId = items[0]?.id || null;
    const previousFirstId = previousFirstItemIdRef.current;
    const previousScrollHeight = previousScrollHeightRef.current;
    if (
      previousFirstId &&
      firstId &&
      previousFirstId !== firstId &&
      !isAtBottom
    ) {
      restorePrependAnchor(previousScrollHeight);
    }

    previousFirstItemIdRef.current = firstId;
    previousScrollHeightRef.current = element.scrollHeight;
    rowVirtualizer.measure();
    scheduleChatLayoutSelfCheck("layout-input");
    const frame = requestAnimationFrame(() => {
      rowVirtualizer.measure();
      scheduleChatLayoutSelfCheck("layout-input:settle");
    });
    return () => cancelAnimationFrame(frame);
  }, [
    contentClassName,
    items,
    isAtBottom,
    normalizedBottomInset,
    restorePrependAnchor,
    rowVirtualizer,
    scheduleChatLayoutSelfCheck,
    textSize,
    textSizeFontSize,
  ]);

  const saveEditedMessage = async ({
    editedMessage,
    chatId,
    role,
    attachments = [],
    saveOnly = false,
  }) => {
    if (!editedMessage || !chatKey) return;

    if (role === "user" && saveOnly) {
      updateUserItem(chatKey, chatId, { content: editedMessage });
      await Workspace.updateChat(
        workspace.slug,
        effectiveThreadSlug,
        chatId,
        editedMessage,
        "user"
      );
      return;
    }

    if (role === "user") {
      updateUserItem(chatKey, chatId, { content: editedMessage });
      await Workspace.deleteEditedChats(
        workspace.slug,
        effectiveThreadSlug,
        chatId
      );
      sendCommand({
        text: editedMessage,
        autoSubmit: true,
        history: [],
        attachments,
      });
      return;
    }

    if (role === "assistant") {
      const target = items.find(
        (item) => item.type === "assistant_turn" && item.chatId === chatId
      );
      if (!target) return;
      updateAssistantTurn(chatKey, target.turnId, {
        finalContent: editedMessage,
      });
      await Workspace.updateChat(
        workspace.slug,
        effectiveThreadSlug,
        chatId,
        editedMessage
      );
    }
  };

  const forkThread = async (chatId) => {
    const newThreadSlug = await Workspace.forkThread(
      workspace.slug,
      effectiveThreadSlug,
      chatId
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
        saveEditedMessage={saveEditedMessage}
        forkThread={forkThread}
        readOnly={readOnly}
        isLastAssistantTurn={item.id === lastAssistantTurnId}
        onContentLayoutChange={scheduleChatLayoutSelfCheck}
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
      saveEditedMessage,
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
      }
    },
    [markUserScrollIntentFor]
  );
  const markPointerScrollIntent = useCallback(
    (event) => {
      if (event.target === event.currentTarget) {
        markUserScrollIntentFor("pointer");
      }
    },
    [markUserScrollIntentFor]
  );

  return (
    <MessageActionsProvider>
      <ThoughtExpansionProvider>
        <div
          className={`markdown text-white/80 light:text-theme-text-primary font-light ${textSizeClass} h-full md:h-[83%] pb-[100px] pt-6 md:pt-0 md:pb-20 md:mx-0 overflow-y-scroll flex flex-col items-center justify-start ${showScrollbar ? "show-scrollbar" : "no-scroll"}`}
          id="chat-history"
          ref={chatHistoryRef}
          onScroll={handleScroll}
          onWheel={() => markUserScrollIntentFor("wheel")}
          onTouchStart={() => markUserScrollIntentFor("touch")}
          onPointerDown={markPointerScrollIntent}
          onKeyDown={markKeyboardScrollIntent}
          style={{ ...textSizeStyle, ...scrollContainerStyle }}
        >
          <div className={`w-full max-w-[920px] ${contentClassName}`}>
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
        {!isAtBottom && (
          <div className="absolute bottom-40 right-10 z-50 cursor-pointer animate-pulse">
            <div className="flex flex-col items-center">
              <div
                className="p-1 rounded-full border border-white/10 bg-white/10 hover:bg-white/20 hover:text-white"
                onClick={() => {
                  shouldFollowOutputRef.current = true;
                  scrollToBottom(isStreaming ? false : true, {
                    reason: "jump-bottom-button",
                    resetSavedPosition: true,
                  });
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
      settleFrameRef.current = requestAnimationFrame(() => {
        settleFrameRef.current = null;
        measure();
      });
    });
  }, [clearMeasureFrames, measure]);

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
      if (typeof MutationObserver !== "undefined") {
        mutationObserverRef.current = new MutationObserver(scheduleMeasure);
        mutationObserverRef.current.observe(element, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
    },
    [disconnectObservers, scheduleMeasure, virtualizer]
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
  if (!row) return false;

  const rect = row.getBoundingClientRect();
  element.scrollTop += rect.top - viewport.top - anchor.offsetTop;
  return true;
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
