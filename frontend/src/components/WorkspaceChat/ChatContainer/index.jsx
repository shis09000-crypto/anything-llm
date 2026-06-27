import {
  useCallback,
  useEffect,
  useContext,
  useRef,
  useMemo,
  useState,
} from "react";
import ChatHistory from "./ChatHistory";
import { DndUploaderContext } from "./DnDWrapper";
import PromptInput, {
  PROMPT_INPUT_EVENT,
  PROMPT_INPUT_ID,
} from "./PromptInput";
import Workspace from "@/models/workspace";
import { isMobile } from "react-device-detect";
import { SidebarMobileHeader } from "../../Sidebar";
import { useNavigate } from "react-router-dom";
import DnDFileUploaderWrapper from "./DnDWrapper";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import { ChatTooltips } from "./ChatTooltips";
import { MetricsProvider } from "./ChatHistory/HistoricalMessage/Actions/RenderMetrics";
import useChatContainerQuickScroll from "@/hooks/useChatContainerQuickScroll";
import { PENDING_HOME_MESSAGE } from "@/utils/constants";
import { clearPromptInputDraft } from "@/hooks/usePromptInputStorage";
import { safeJsonParse } from "@/utils/request";
import paths from "@/utils/paths";
import QuickActions from "@/components/lib/QuickActions";
import SuggestedMessages from "@/components/lib/SuggestedMessages";
import WorkspaceModelPicker from "./WorkspaceModelPicker";
import SourcesSidebar, { SourcesSidebarProvider } from "./SourcesSidebar";
import MindMapPanel from "./MindMapPanel";
import TopRightActionZone from "./TopRightActionZone";
import DocumentReaderPanel from "./DocumentReader/Panel";
import { DocumentReaderProvider } from "./DocumentReader/Provider";
import {
  promptWithTempTextSources,
  READER_EVENT_CONSUME_TEXT_SOURCES,
  READER_EVENT_OPEN_DRAWER,
} from "./DocumentReader/storage";
import WorkspaceOverview from "./WorkspaceOverview";
import {
  draftNeedsServerHistoryRefresh,
  useChatDraft,
  useChatThreadDrafts,
} from "@/contexts/ChatThreadDraftProvider";
import { useWorkspaceSyncEvents } from "@/hooks/useWorkspaceSyncEvents";
import { useWorkspaceLayout } from "@/contexts/WorkspaceLayoutProvider";
import {
  createTurnId,
  isAssistantTurn,
  mergeServerHistoryIntoTurns,
} from "@/utils/chat/turns";
import { debugChatTurn } from "@/utils/chat/debug";
import FileAccessPolicy from "@/models/fileAccessPolicy";
import showToast from "@/utils/toast";
import useUser from "@/hooks/useUser";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import AppIcon from "@/components/lib/AppIcon";
import { isOverviewThread } from "@/utils/workspaceThreads";
import {
  clampReaderSplitPercent,
  readReaderSplitPercent,
} from "@/utils/layout/workspaceLayoutState";

function lastAssistantTurn(items = []) {
  return [...items].reverse().find((item) => isAssistantTurn(item));
}

const QUIZ_INTENT_PATTERN =
  /(出|生成|来|做|练|考|测).{0,8}(题|测试|测验|quiz|question)|(?:quiz|test)\s*(me|questions?)|(?:单选|多选|填空|选择题|练习题|测试题|测验题|考考我|自测)/i;
const NON_QUIZ_TEST_PATTERN =
  /(测试连接|测试接口|测试功能|测试代码|test connection|unit test|integration test|e2e test|jest|vitest|pytest)/i;
const DUAL_THREAD_FORK_MODE = "dual_thread_fork_mode";
const BRANCH_PROMPT_INPUT_ID = "branch-prompt-input";
const WORKSPACE_THREADS_REFRESH_EVENT = "workspaceThreadsRefresh";
const SELECTION_COPY_MIN_LENGTH = 8;
const DEFAULT_CHAT_HISTORY_BOTTOM_INSET = 104;
const CHAT_HISTORY_INPUT_GAP = 8;
const DUAL_THREAD_CONTENT_PADDING = "px-4 md:px-6";
const MEMORY_COMPACTION_STATUS_REFRESH_MS = 900;
const MEMORY_COMPACTION_TIMEOUT_MS = 5 * 60_000;
const MEMORY_COMPACTION_SUCCESS_MS = 2_800;
const MEMORY_COMPACTION_ERROR_MS = 4_500;
const DUAL_THREAD_RESUME_PROMPT =
  "检测到上一次双线程分支。\n点击“确定”继续上一次线程，点击“取消”开启全新线程。";

export default function ChatContainer({
  workspace,
  threadSlug = null,
  activeThread = null,
  knownHistory = [],
  hasMoreHistory = false,
  isLoadingOlderHistory = false,
  onLoadOlderHistory = null,
  chatScrollMemory = null,
}) {
  const navigate = useNavigate();
  const { user } = useUser();
  const {
    mergeServerHistory,
    startStream,
    startLocalTurn,
    appendTimelineEvent,
    completeAssistantTurn,
    failAssistantTurn,
    respondToApproval,
    respondToClarification,
    getChatKey,
  } = useChatThreadDrafts();
  const chatKey = getChatKey(workspace?.slug, threadSlug);
  const workspaceLayout = useWorkspaceLayout();
  const layoutState = workspaceLayout?.layoutState || {};
  const layoutMode =
    workspaceLayout?.layoutMode || layoutState.mode || "normal";
  const dispatchLayoutEvent = workspaceLayout?.dispatchLayoutEvent;
  const activeThreadSlug = activeThread?.slug || null;
  const activeThreadId = activeThread?.id || null;
  const draft = useChatDraft(workspace?.slug, threadSlug);
  const knownItems = useMemo(
    () => mergeServerHistoryIntoTurns(knownHistory, [], { chatKey }),
    [knownHistory, chatKey]
  );
  const chatItems = draft?.items || knownItems;
  const loadingResponse = !!draft?.isStreaming;
  const latestAssistantTurn = lastAssistantTurn(chatItems);
  const [mindMapRequest, setMindMapRequest] = useState(null);
  const [quizModeActive, setQuizModeActive] = useState(false);
  const [quizIntentPrompt, setQuizIntentPrompt] = useState(null);
  const { files, parseAttachments } = useContext(DndUploaderContext);
  const { chatHistoryRef } = useChatContainerQuickScroll();
  const pendingMessageChecked = useRef(false);
  const readerLayoutRef = useRef(null);
  const readerResizeFrameRef = useRef(null);
  const readerResizeDraftRef = useRef(null);
  const quizIntentResolverRef = useRef(null);
  const sourcePanelRef = useRef(null);
  const selectionDebounceRef = useRef(null);
  const lastSelectionSignatureRef = useRef("");
  const historyRepairRef = useRef({ signature: null, controller: null });
  const [dualThreadFork, setDualThreadFork] = useState({
    enabled: false,
    sourceThreadSlug: null,
    sourceThreadId: null,
    branchThreadSlug: null,
    branchThreadId: null,
    forkedAtMessageId: null,
    sourcePanelVisible: false,
    branchPanelVisible: false,
  });
  const [dualThreadLoading, setDualThreadLoading] = useState(false);
  const [branchHistory, setBranchHistory] = useState([]);
  const [sourceHistory, setSourceHistory] = useState(null);
  const [closeMenuOpen, setCloseMenuOpen] = useState(false);
  const [promptBottomInset, setPromptBottomInset] = useState(
    DEFAULT_CHAT_HISTORY_BOTTOM_INSET
  );
  const [branchPromptBottomInset, setBranchPromptBottomInset] = useState(
    DEFAULT_CHAT_HISTORY_BOTTOM_INSET
  );
  const [mobileNewThreadLoading, setMobileNewThreadLoading] = useState(false);
  const [emptyThreadComposeActive, setEmptyThreadComposeActive] =
    useState(false);
  const readerActive =
    layoutMode === "readerDrawer" || layoutMode === "readerDocument";
  const mindMapOpen = layoutMode === "mindMap";
  const readerPanelPercent = clampReaderSplitPercent(
    layoutState.readerPercent ?? readReaderSplitPercent()
  );
  const readerActiveRef = useRef(readerActive);
  const readerLayoutTransitionSeqRef = useRef(0);
  const [chatLayoutTransitionSignal, setChatLayoutTransitionSignal] =
    useState(null);
  const [memoryCompactionStatus, setMemoryCompactionStatus] = useState(null);
  const [memoryCompactionLoading, setMemoryCompactionLoading] = useState(false);
  const [memoryCompactionPending, setMemoryCompactionPending] = useState(false);
  const [memoryCompactionDivider, setMemoryCompactionDivider] = useState(null);
  const memoryStatusRequestRef = useRef({ id: 0, controller: null });
  const memoryStreamRefreshTimerRef = useRef(null);
  const memoryDividerTimerRef = useRef(null);
  const memoryCompactRef = useRef({
    controller: null,
    timeout: null,
    timedOut: false,
  });
  useWorkspaceSyncEvents({
    workspaceSlug: workspace?.slug,
    activeThreadSlug: threadSlug,
    enabled: !!workspace?.slug,
    onThreadDeleted: () => navigate(paths.workspace.chat(workspace.slug)),
  });
  const compactionUserId = user?.id ?? undefined;
  const compactionApiSessionId = undefined;
  const memoryCompactionScopeKey = useMemo(
    () =>
      [
        workspace?.slug || "workspace",
        threadSlug || "default",
        compactionUserId === undefined ? "session" : compactionUserId,
        compactionApiSessionId === undefined ? "null" : compactionApiSessionId,
      ].join(":"),
    [workspace?.slug, threadSlug, compactionUserId, compactionApiSessionId]
  );
  const branchChatKey = getChatKey(
    workspace?.slug,
    dualThreadFork.branchThreadSlug
  );
  const branchDraft = useChatDraft(
    workspace?.slug,
    dualThreadFork.branchThreadSlug
  );
  const branchKnownItems = useMemo(
    () =>
      mergeServerHistoryIntoTurns(branchHistory, [], {
        chatKey: branchChatKey,
      }),
    [branchHistory, branchChatKey]
  );
  const branchItems = branchDraft?.items || branchKnownItems;
  const branchLoadingResponse = !!branchDraft?.isStreaming;
  const sourceChatKey = getChatKey(
    workspace?.slug,
    dualThreadFork.sourceThreadSlug
  );

  function clarificationPayloadFromText(clarification, text = "") {
    const answer = String(text || "").trim();
    const questions = Array.isArray(clarification?.questions)
      ? clarification.questions
      : [];
    return {
      skipped: false,
      answers: (questions.length ? questions : [null]).map(() => ({
        skipped: false,
        answer,
      })),
    };
  }

  async function submitPendingClarificationFromInput({
    currentDraft,
    currentChatKey,
    message,
    clearInput,
  }) {
    const clarification = currentDraft?.pendingClarification;
    const answer = String(message || "").trim();
    if (!clarification?.requestId || !answer || !currentChatKey) return false;

    const result = await respondToClarification(
      currentChatKey,
      clarification.requestId,
      clarificationPayloadFromText(clarification, answer)
    );
    if (!result?.ok) {
      showToast("补充回答发送失败，请重试。", "error");
      return true;
    }

    clearInput?.();
    return true;
  }

  const sourceItems = useMemo(
    () =>
      sourceHistory
        ? mergeServerHistoryIntoTurns(sourceHistory, [], {
            chatKey: sourceChatKey,
          })
        : chatItems,
    [chatItems, sourceChatKey, sourceHistory]
  );
  const activeThreadIsOverview = isOverviewThread(activeThread);

  const { listening, resetTranscript } = useSpeechRecognition({
    clearTranscriptOnListen: true,
  });

  const [sendScrollRequest, setSendScrollRequest] = useState(0);
  const [branchSendScrollRequest, setBranchSendScrollRequest] = useState(0);
  const requestSendScrollToBottom = useCallback(() => {
    setSendScrollRequest((request) => request + 1);
  }, []);
  const requestBranchSendScrollToBottom = useCallback(() => {
    setBranchSendScrollRequest((request) => request + 1);
  }, []);

  const clearMemoryCompactionDivider = useCallback(() => {
    clearTimeout(memoryDividerTimerRef.current);
    memoryDividerTimerRef.current = null;
    setMemoryCompactionDivider(null);
  }, []);

  const showMemoryCompactionDivider = useCallback(
    (type, customText = "") => {
      const text = {
        pending: "上下文记忆正在压缩",
        success: "上下文记忆压缩完成",
        error: "上下文记忆压缩失败，请手动重试",
        timeout: "上下文记忆压缩等待超时，请刷新状态后重试",
        aborted: "上下文记忆压缩已取消",
      }[type];
      if (!text) return;
      clearTimeout(memoryDividerTimerRef.current);
      setMemoryCompactionDivider({
        scopeKey: memoryCompactionScopeKey,
        type,
        text: customText || text,
      });
      if (
        type === "success" ||
        type === "error" ||
        type === "timeout" ||
        type === "aborted"
      ) {
        memoryDividerTimerRef.current = setTimeout(
          () => {
            setMemoryCompactionDivider((current) =>
              current?.scopeKey === memoryCompactionScopeKey ? null : current
            );
          },
          type === "success"
            ? MEMORY_COMPACTION_SUCCESS_MS
            : MEMORY_COMPACTION_ERROR_MS
        );
      }
    },
    [memoryCompactionScopeKey]
  );

  const refreshMemoryCompactionStatus = useCallback(
    async ({ preserveOnError = false } = {}) => {
      if (!workspace?.slug || !threadSlug) {
        setMemoryCompactionStatus(null);
        setMemoryCompactionLoading(false);
        return;
      }

      memoryStatusRequestRef.current.controller?.abort();
      const controller = new AbortController();
      const requestId = memoryStatusRequestRef.current.id + 1;
      memoryStatusRequestRef.current = { id: requestId, controller };
      setMemoryCompactionLoading(true);

      try {
        const result = await Workspace.threads.compactionStatus(
          workspace.slug,
          threadSlug,
          {
            userId: compactionUserId,
            apiSessionId: compactionApiSessionId,
            signal: controller.signal,
          }
        );
        if (memoryStatusRequestRef.current.id !== requestId) return;
        if (result?.success) {
          setMemoryCompactionStatus(result.status || null);
        } else if (!preserveOnError) {
          setMemoryCompactionStatus(null);
        }
      } catch (error) {
        if (error?.name !== "AbortError" && !preserveOnError) {
          setMemoryCompactionStatus(null);
        }
      } finally {
        if (memoryStatusRequestRef.current.id === requestId) {
          setMemoryCompactionLoading(false);
        }
      }
    },
    [workspace?.slug, threadSlug, compactionUserId, compactionApiSessionId]
  );

  const scheduleMemoryStatusRefresh = useCallback(() => {
    clearTimeout(memoryStreamRefreshTimerRef.current);
    memoryStreamRefreshTimerRef.current = setTimeout(() => {
      refreshMemoryCompactionStatus({ preserveOnError: true });
    }, MEMORY_COMPACTION_STATUS_REFRESH_MS);
  }, [refreshMemoryCompactionStatus]);

  const compactThreadMemory = useCallback(async () => {
    if (!workspace?.slug || !threadSlug || memoryCompactionPending) return;
    setMemoryCompactionPending(true);
    showMemoryCompactionDivider("pending");
    const controller = new AbortController();
    memoryCompactRef.current.controller = controller;
    memoryCompactRef.current.timedOut = false;
    clearTimeout(memoryCompactRef.current.timeout);
    memoryCompactRef.current.timeout = setTimeout(() => {
      memoryCompactRef.current.timedOut = true;
      controller.abort();
      setMemoryCompactionPending(false);
      showMemoryCompactionDivider(
        "timeout",
        "上下文记忆压缩等待超时，后端可能仍在处理，请稍后刷新状态"
      );
      refreshMemoryCompactionStatus({ preserveOnError: true });
    }, MEMORY_COMPACTION_TIMEOUT_MS);

    try {
      const result = await Workspace.threads.compact(
        workspace.slug,
        threadSlug,
        {
          userId: compactionUserId,
          apiSessionId: compactionApiSessionId,
          mode: "target",
          targetRatio: memoryCompactionStatus?.targetRatio,
          signal: controller.signal,
        }
      );
      clearTimeout(memoryCompactRef.current.timeout);
      if (controller.signal.aborted) return;
      setMemoryCompactionPending(false);
      if (result?.success && !result?.error) {
        showMemoryCompactionDivider("success");
        await refreshMemoryCompactionStatus({ preserveOnError: true });
        return;
      }
      showMemoryCompactionDivider(
        "error",
        result?.error
          ? `上下文记忆压缩失败：${result.error}`
          : "上下文记忆压缩失败，请手动重试"
      );
    } catch (error) {
      clearTimeout(memoryCompactRef.current.timeout);
      if (error?.name === "AbortError") {
        if (memoryCompactRef.current.timedOut) return;
        setMemoryCompactionPending(false);
        showMemoryCompactionDivider("aborted");
        return;
      }
      setMemoryCompactionPending(false);
      showMemoryCompactionDivider(
        "error",
        error?.message
          ? `上下文记忆压缩失败：${error.message}`
          : "上下文记忆压缩失败，请手动重试"
      );
    }
  }, [
    workspace?.slug,
    threadSlug,
    compactionUserId,
    compactionApiSessionId,
    memoryCompactionPending,
    memoryCompactionStatus?.targetRatio,
    refreshMemoryCompactionStatus,
    showMemoryCompactionDivider,
  ]);

  useEffect(() => {
    clearMemoryCompactionDivider();
    setMemoryCompactionPending(false);
    setMemoryCompactionStatus(null);
    clearTimeout(memoryCompactRef.current.timeout);
    memoryCompactRef.current.controller?.abort();
    refreshMemoryCompactionStatus({ preserveOnError: false });

    return () => {
      memoryStatusRequestRef.current.controller?.abort();
      clearTimeout(memoryStreamRefreshTimerRef.current);
      clearTimeout(memoryCompactRef.current.timeout);
      memoryCompactRef.current.controller?.abort();
    };
  }, [
    memoryCompactionScopeKey,
    clearMemoryCompactionDivider,
    refreshMemoryCompactionStatus,
  ]);

  const wasLoadingResponseRef = useRef(false);
  useEffect(() => {
    if (loadingResponse) {
      wasLoadingResponseRef.current = true;
      return;
    }
    if (!wasLoadingResponseRef.current) return;
    wasLoadingResponseRef.current = false;
    scheduleMemoryStatusRefresh();
  }, [loadingResponse, scheduleMemoryStatusRefresh]);

  const updatePromptBottomInset = useCallback((height) => {
    const nextInset = Math.max(
      DEFAULT_CHAT_HISTORY_BOTTOM_INSET,
      Math.ceil(height) + CHAT_HISTORY_INPUT_GAP
    );
    setPromptBottomInset((currentInset) =>
      Math.abs(currentInset - nextInset) < 2 ? currentInset : nextInset
    );
  }, []);

  const updateBranchPromptBottomInset = useCallback((height) => {
    const nextInset = Math.max(
      DEFAULT_CHAT_HISTORY_BOTTOM_INSET,
      Math.ceil(height) + CHAT_HISTORY_INPUT_GAP
    );
    setBranchPromptBottomInset((currentInset) =>
      Math.abs(currentInset - nextInset) < 2 ? currentInset : nextInset
    );
  }, []);

  const updateEmptyThreadComposeState = useCallback((state = {}) => {
    const nextActive = !!(
      state.hasDraftInput ||
      state.hasAttachments ||
      state.isComposing ||
      state.slashMenuOpen ||
      state.isVoiceInputActive
    );
    setEmptyThreadComposeActive((current) =>
      current === nextActive ? current : nextActive
    );
  }, []);

  const beginChatLayoutTransition = useCallback(
    (reason = "layout-transition") => {
      const signal = {
        seq: (readerLayoutTransitionSeqRef.current += 1),
        reason,
        at: Date.now(),
      };
      chatHistoryRef.current?.beginLayoutTransition?.(signal);
      setChatLayoutTransitionSignal(signal);
      debugChatTurn("ChatContainer:layoutTransition", {
        chatKey,
        reason,
        seq: signal.seq,
        readerActive: readerActiveRef.current,
        readerPanelPercent,
      });
      return signal;
    },
    [chatHistoryRef, chatKey, readerPanelPercent]
  );

  const setReaderActiveWithLayoutTransition = useCallback(
    (
      nextActive,
      reason = nextActive ? "reader-open" : "reader-close",
      { force = false } = {}
    ) => {
      if (!force && readerActiveRef.current === nextActive) return;
      beginChatLayoutTransition(reason);
      readerActiveRef.current = nextActive;
      dispatchLayoutEvent?.(
        nextActive
          ? { type: "READER_OPENED", readerType: "drawer" }
          : { type: "READER_CLOSED" }
      );
    },
    [beginChatLayoutTransition, dispatchLayoutEvent]
  );

  useEffect(() => {
    readerActiveRef.current = readerActive;
  }, [readerActive]);

  const startReaderResize = useCallback(
    (event) => {
      event.preventDefault();
      beginChatLayoutTransition("reader-resize");
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const layoutRect = readerLayoutRef.current?.getBoundingClientRect();
      if (!layoutRect?.width) return;
      const startX = event.clientX;
      const startPercent = readerPanelPercent;
      readerResizeDraftRef.current = startPercent;

      function onPointerMove(moveEvent) {
        const deltaPercent =
          ((moveEvent.clientX - startX) / layoutRect.width) * 100;
        const nextPercent = clampReaderSplitPercent(
          startPercent - deltaPercent
        );
        readerResizeDraftRef.current = nextPercent;
        if (readerResizeFrameRef.current) return;
        readerResizeFrameRef.current = window.requestAnimationFrame(() => {
          readerResizeFrameRef.current = null;
          dispatchLayoutEvent?.({
            type: "READER_RESIZE_DRAFT",
            percent: readerResizeDraftRef.current,
          });
        });
      }

      function stopResize() {
        if (readerResizeFrameRef.current) {
          window.cancelAnimationFrame(readerResizeFrameRef.current);
          readerResizeFrameRef.current = null;
        }
        dispatchLayoutEvent?.({
          type: "READER_RESIZE_COMMIT",
          percent: readerResizeDraftRef.current ?? startPercent,
        });
        readerResizeDraftRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
      }

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    },
    [beginChatLayoutTransition, dispatchLayoutEvent, readerPanelPercent]
  );

  function chatItemComparableText(item) {
    if (item?.type === "user") return `user:${item.content || ""}`;
    if (item?.type === "assistant_turn") {
      if (item.status === "running") return "assistant:__running__";
      return `assistant:${item.finalContent || ""}`;
    }
    return null;
  }

  function comparableChatItems(items = []) {
    return items.map(chatItemComparableText).filter(Boolean);
  }

  function branchHasUnsentDraft() {
    return (
      document.getElementById(BRANCH_PROMPT_INPUT_ID)?.value?.trim?.()?.length >
      0
    );
  }

  function branchMatchesSourcePrefix() {
    const branchComparable = comparableChatItems(branchItems);
    const sourceComparable = comparableChatItems(sourceItems);
    if (branchComparable.some((item) => item.endsWith(":__running__")))
      return false;
    if (branchComparable.length > sourceComparable.length) return false;

    return branchComparable.every(
      (item, index) => item === sourceComparable[index]
    );
  }

  async function deleteDisposableBranchIfNeeded() {
    if (
      !dualThreadFork.branchThreadSlug ||
      branchLoadingResponse ||
      branchHasUnsentDraft() ||
      !branchMatchesSourcePrefix()
    ) {
      return false;
    }

    const deleted = await Workspace.threads.delete(
      workspace.slug,
      dualThreadFork.branchThreadSlug
    );
    if (deleted) {
      clearPromptInputDraft(dualThreadFork.branchThreadSlug, {
        workspaceSlug: workspace.slug,
        threadSlug: dualThreadFork.branchThreadSlug,
      });
      refreshWorkspaceThreads();
      showToast("未改动的分支线程已自动取消", "success");
    } else {
      showToast("未改动的分支线程取消失败", "error");
    }
    return deleted;
  }

  /**
   * Emit an update to the state of the prompt input without directly
   * passing a prop in so that it does not re-render constantly.
   * @param {string} messageContent - The message content to set
   * @param {'replace' | 'append'} writeMode - Replace current text or append to existing text (default: replace)
   */
  function setMessageEmit(
    messageContent = "",
    writeMode = "replace",
    target = {}
  ) {
    window.dispatchEvent(
      new CustomEvent(PROMPT_INPUT_EVENT, {
        detail: { messageContent, writeMode, ...target },
      })
    );
  }

  function openMindMap(body = {}) {
    beginChatLayoutTransition("mind-map-open");
    dispatchLayoutEvent?.({ type: "MINDMAP_OPENED" });
    setMindMapRequest({ id: Date.now(), body });
  }

  const closeMindMap = useCallback(() => {
    beginChatLayoutTransition("mind-map-close");
    dispatchLayoutEvent?.({ type: "MINDMAP_CLOSED" });
  }, [beginChatLayoutTransition, dispatchLayoutEvent]);

  const openDocumentReader = useCallback(() => {
    debugChatTurn("ChatContainer:openDocumentReader", {
      chatKey,
      activeThreadSlug,
      activeThreadId,
      threadSlug,
      activeThreadIsOverview,
      readerActiveBefore: readerActive,
      isEmptyThread,
      itemCount: chatItems.length,
    });
    setReaderActiveWithLayoutTransition(true, "reader-open", { force: true });
    window.dispatchEvent(new CustomEvent(READER_EVENT_OPEN_DRAWER));
  }, [
    activeThreadId,
    activeThreadIsOverview,
    activeThreadSlug,
    chatKey,
    chatItems.length,
    readerActive,
    setReaderActiveWithLayoutTransition,
    threadSlug,
  ]);

  useEffect(() => {
    debugChatTurn("ChatContainer:readerActive", {
      chatKey,
      threadSlug,
      activeThreadSlug,
      readerActive,
      activeThreadIsOverview,
      hasMessages: chatItems.length > 0,
      promptDraftKey: threadSlug || "default",
    });
  }, [
    activeThreadIsOverview,
    activeThreadSlug,
    chatKey,
    chatItems.length,
    readerActive,
    threadSlug,
  ]);

  function consumeReaderTempTextSources() {
    let sources = [];
    window.dispatchEvent(
      new CustomEvent(READER_EVENT_CONSUME_TEXT_SOURCES, {
        detail: {
          reply: (payload) => {
            sources = payload?.sources || [];
          },
        },
      })
    );
    return sources;
  }

  function readerPromptPayload(prompt, includeReaderTempTextSources = true) {
    if (!includeReaderTempTextSources) return { prompt, readerTextSources: [] };
    const readerTextSources = consumeReaderTempTextSources();
    return {
      prompt: promptWithTempTextSources(prompt, readerTextSources),
      readerTextSources,
    };
  }

  function openGraphOverviewConcept(target) {
    if (!target) return;
    const graphTarget =
      typeof target === "object" ? target : { concept: String(target) };
    openMindMap({
      sourceType: "graph",
      ...graphTarget,
      concept:
        graphTarget.concept || graphTarget.displayName || graphTarget.label,
    });
  }

  function openGraphOverviewPath(path = {}) {
    openMindMap({
      sourceType: "graphPath",
      concept: path.source,
      source: path.source,
      target: path.target,
    });
  }

  function openGraphOverviewEvidence(evidence = {}) {
    openMindMap({
      sourceType: "evidence",
      concept: evidence.concept,
      targetType: evidence.targetType,
      targetId: evidence.targetId,
    });
  }

  function handleMindMapCommand(message = "") {
    if (!/^\/mindmap(\s|$)/i.test(message.trim())) return false;
    const text = message
      .trim()
      .replace(/^\/mindmap/i, "")
      .trim();
    if (text) {
      openMindMap({ sourceType: "text", text });
      return true;
    }
    if (!latestAssistantTurn?.finalContent) {
      openMindMap();
      showToast("当前还没有可用于生成思维导图的助手回复。", "info");
      return true;
    }
    openMindMap({
      sourceType: "chat",
      chatId: latestAssistantTurn.chatId,
      text: latestAssistantTurn.finalContent,
    });
    return true;
  }

  function currentFileAccessMode() {
    return FileAccessPolicy.getSessionMode(workspace?.slug, threadSlug);
  }

  function shouldOfferQuizIntent(message = "", attachments = []) {
    const text = String(message || "").trim();
    if (!text || quizModeActive) return false;
    if ((attachments || []).length > 0) return false;
    if (/^[/@]/.test(text)) return false;
    if (NON_QUIZ_TEST_PATTERN.test(text)) return false;
    return QUIZ_INTENT_PATTERN.test(text);
  }

  function confirmQuizIntent(message = "") {
    if (quizIntentResolverRef.current) {
      quizIntentResolverRef.current(false);
      quizIntentResolverRef.current = null;
    }
    return new Promise((resolve) => {
      quizIntentResolverRef.current = resolve;
      setQuizIntentPrompt({ message });
    });
  }

  function resolveQuizIntentPrompt(confirmed) {
    const resolve = quizIntentResolverRef.current;
    quizIntentResolverRef.current = null;
    setQuizIntentPrompt(null);
    resolve?.(confirmed);
  }

  async function maybeRouteQuizIntent(message = "", attachments = []) {
    if (!shouldOfferQuizIntent(message, attachments)) return false;
    const confirmed = await confirmQuizIntent(message);
    if (!confirmed) return false;
    await submitQuizMessage(message);
    return true;
  }

  async function submitQuizMessage(message = "", nodeContext = null) {
    clearPromptInputDraft(threadSlug ?? workspace.slug, {
      workspaceSlug: workspace.slug,
      threadSlug,
    });
    setMessageEmit("");
    setQuizModeActive(false);
    if (listening) endSTTSession();
    const localTurn = startLocalTurn({
      workspaceSlug: workspace.slug,
      threadSlug,
      prompt: message,
      history: knownHistory,
    });
    requestSendScrollToBottom();
    appendTimelineEvent(localTurn.chatKey, localTurn.turnId, {
      type: "thought",
      content: "正在解析测试计划...",
    });
    const result = await Workspace.generateQuiz(workspace.slug, {
      message,
      threadSlug,
      nodeContext,
    });
    appendTimelineEvent(localTurn.chatKey, localTurn.turnId, {
      type: "thought",
      content: result?.success
        ? "已生成首批题目，后续题型将继续补齐。"
        : "测试题生成失败。",
    });
    if (result?.history) {
      mergeServerHistory({
        workspaceSlug: workspace.slug,
        threadSlug,
        history: result.history,
      });
    }
    if (!result?.success) {
      failAssistantTurn(
        localTurn.chatKey,
        localTurn.turnId,
        result?.error || "测试题生成失败。"
      );
      showToast(result?.error || "测试题生成失败。", "error");
    } else {
      completeAssistantTurn(localTurn.chatKey, localTurn.turnId, {
        chatId: result.quizId,
        finalContent:
          result.quiz?.analysis || result.quiz?.title || "测试题已生成。",
        sources: result.quiz?.sourceRefs || [],
        outputs: [{ type: "QuizCard", payload: result.quiz }],
      });
    }
    return result;
  }

  useEffect(() => {
    if (!workspace?.slug || !chatKey) return;
    mergeServerHistory({
      workspaceSlug: workspace.slug,
      threadSlug,
      history: knownHistory,
    });
  }, [workspace?.slug, threadSlug, chatKey, knownHistory, mergeServerHistory]);

  useEffect(() => {
    if (
      !workspace?.slug ||
      !chatKey ||
      !draftNeedsServerHistoryRefresh(draft)
    ) {
      return;
    }

    const repairSignature = `${chatKey}:${(draft?.items || [])
      .filter((item) => item.type === "assistant_turn" && !item.chatId)
      .map((item) => `${item.turnId}:${item.status}:${item.updatedAt || 0}`)
      .join("|")}`;
    if (historyRepairRef.current.signature === repairSignature) return;

    historyRepairRef.current.controller?.abort?.();
    const controller = new AbortController();
    historyRepairRef.current = { signature: repairSignature, controller };

    (async () => {
      const result = threadSlug
        ? await Workspace.threads.chatHistoryPage(workspace.slug, threadSlug, {
            limit: 30,
            detail: "full",
            priorityWindow: 30,
            signal: controller.signal,
          })
        : await Workspace.chatHistoryPage(workspace.slug, {
            limit: 30,
            detail: "full",
            priorityWindow: 30,
            signal: controller.signal,
          });
      if (controller.signal.aborted || !result?.history?.length) return;
      mergeServerHistory({
        workspaceSlug: workspace.slug,
        threadSlug,
        history: result.history,
      });
    })().catch((error) => {
      if (error?.name === "AbortError") return;
      debugChatTurn("ChatContainer:historyRepairFailed", {
        chatKey,
        error: error.message,
      });
    });

    return () => controller.abort();
  }, [workspace?.slug, threadSlug, chatKey, draft?.items, mergeServerHistory]);

  useEffect(() => {
    debugChatTurn("ChatContainer:runtime", {
      chatKey,
      loadingResponse,
      activeTurnId: draft?.activeTurnId || null,
      isStreaming: !!draft?.isStreaming,
      isAgentRunning: !!draft?.isAgentRunning,
      lastAssistantTurnId: latestAssistantTurn?.turnId || null,
      lastAssistantStatus: latestAssistantTurn?.status || null,
    });
  }, [
    chatKey,
    draft?.activeTurnId,
    draft?.isAgentRunning,
    draft?.isStreaming,
    latestAssistantTurn?.status,
    latestAssistantTurn?.turnId,
    loadingResponse,
  ]);

  async function loadFullThreadHistory(activeThreadSlug = null) {
    if (!workspace?.slug) return [];
    return activeThreadSlug
      ? await Workspace.threads.chatHistory(workspace.slug, activeThreadSlug)
      : await Workspace.chatHistory(workspace.slug);
  }

  function refreshWorkspaceThreads() {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_THREADS_REFRESH_EVENT, {
        detail: { workspaceSlug: workspace.slug },
      })
    );
  }

  async function createMobileWorkspaceThread() {
    if (mobileNewThreadLoading || !workspace?.slug) return;

    try {
      setMobileNewThreadLoading(true);
      const { thread, error } = await Workspace.threads.new(workspace.slug);
      if (error || !thread?.slug) {
        showToast(
          `新建线程失败 - ${error || "Invalid thread response"}`,
          "error",
          { clear: true }
        );
        return;
      }

      refreshWorkspaceThreads();
      navigate(paths.workspace.thread(workspace.slug, thread.slug), {
        state: { userSelectedThread: true },
      });
    } catch (error) {
      showToast(`新建线程失败 - ${error.message}`, "error", { clear: true });
    } finally {
      setMobileNewThreadLoading(false);
    }
  }

  function renderMobileHeader() {
    return (
      <SidebarMobileHeader
        onNewThread={createMobileWorkspaceThread}
        newThreadLoading={mobileNewThreadLoading}
      />
    );
  }

  function resetDualThreadFork() {
    clearTimeout(selectionDebounceRef.current);
    lastSelectionSignatureRef.current = "";
    setCloseMenuOpen(false);
    setDualThreadFork({
      enabled: false,
      sourceThreadSlug: null,
      sourceThreadId: null,
      branchThreadSlug: null,
      branchThreadId: null,
      forkedAtMessageId: null,
      sourcePanelVisible: false,
      branchPanelVisible: false,
    });
    dispatchLayoutEvent?.({ type: "DUAL_THREAD_CLOSED" });
    setBranchHistory([]);
    setSourceHistory(null);
  }

  function latestReusableDualThreadBranch(threads = [], sourceThreadId = null) {
    const candidates = threads.filter((thread) => {
      const isDualThreadBranch =
        thread.created_from === DUAL_THREAD_FORK_MODE ||
        (thread.thread_type === "branch" &&
          thread.forked_at_message_id &&
          thread.forked_at);
      if (!isDualThreadBranch || !thread.slug) return false;
      return (thread.parent_thread_id ?? null) === (sourceThreadId ?? null);
    });

    return candidates.sort((a, b) => {
      const aTime = Date.parse(a.forked_at || a.lastUpdatedAt || a.createdAt);
      const bTime = Date.parse(b.forked_at || b.lastUpdatedAt || b.createdAt);
      return (
        (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime)
      );
    })[0];
  }

  async function openDualThreadBranch(branchThread, sourceThreadId = null) {
    const branchHistoryFromServer = await loadFullThreadHistory(
      branchThread.slug
    );
    if (!Array.isArray(branchHistoryFromServer)) {
      throw new Error("Branch history failed to load");
    }

    setBranchHistory(branchHistoryFromServer);
    mergeServerHistory({
      workspaceSlug: workspace.slug,
      threadSlug: branchThread.slug,
      history: branchHistoryFromServer,
    });
    setSourceHistory(null);
    setDualThreadFork({
      enabled: true,
      sourceThreadSlug: threadSlug,
      sourceThreadId,
      branchThreadSlug: branchThread.slug,
      branchThreadId: branchThread.id || null,
      forkedAtMessageId: branchThread.forked_at_message_id || null,
      sourcePanelVisible: true,
      branchPanelVisible: true,
    });
    dispatchLayoutEvent?.({ type: "DUAL_THREAD_OPENED" });
    refreshWorkspaceThreads();
  }

  async function startDualThreadFork() {
    if (dualThreadLoading || dualThreadFork.enabled) return;
    const lastVisibleChatId = [...chatItems]
      .reverse()
      .find((item) => item.chatId)?.chatId;
    if (!lastVisibleChatId) {
      showToast("当前线程暂无可分支的消息", "info");
      return;
    }

    setDualThreadLoading(true);
    try {
      const { threads = [] } = await Workspace.threads.all(workspace.slug);
      const sourceThread = threadSlug
        ? threads.find((thread) => thread.slug === threadSlug)
        : null;
      const sourceThreadId = sourceThread?.id || null;
      const previousBranch =
        !threadSlug || sourceThread
          ? latestReusableDualThreadBranch(threads, sourceThreadId)
          : null;
      if (
        previousBranch &&
        (await showAppConfirm({
          tone: "info",
          title: "继续上一次双线程分支？",
          description: DUAL_THREAD_RESUME_PROMPT,
          confirmText: "继续",
          cancelText: "新建",
        }))
      ) {
        await openDualThreadBranch(previousBranch, sourceThreadId);
        return;
      }

      const result = await Workspace.forkThread(
        workspace.slug,
        threadSlug,
        lastVisibleChatId,
        {
          openMode: DUAL_THREAD_FORK_MODE,
          createdFrom: DUAL_THREAD_FORK_MODE,
          returnFull: true,
        }
      );
      const branchThreadSlug = result?.newThread?.slug || result?.newThreadSlug;
      if (!branchThreadSlug || result?.error) {
        throw new Error(result?.message || result?.error || "Fork failed");
      }

      const branchHistoryFromServer =
        await loadFullThreadHistory(branchThreadSlug);
      if (!Array.isArray(branchHistoryFromServer)) {
        throw new Error("Branch history failed to load");
      }

      setBranchHistory(branchHistoryFromServer);
      mergeServerHistory({
        workspaceSlug: workspace.slug,
        threadSlug: branchThreadSlug,
        history: branchHistoryFromServer,
      });
      setSourceHistory(null);
      setDualThreadFork({
        enabled: true,
        sourceThreadSlug: threadSlug,
        sourceThreadId: result?.sourceThread?.id || sourceThreadId,
        branchThreadSlug,
        branchThreadId: result?.newThread?.id || null,
        forkedAtMessageId: result?.forkedAtMessageId || lastVisibleChatId,
        sourcePanelVisible: true,
        branchPanelVisible: true,
      });
      dispatchLayoutEvent?.({ type: "DUAL_THREAD_OPENED" });
      refreshWorkspaceThreads();
    } catch (error) {
      resetDualThreadFork();
      const message =
        error?.message === "Failed to fork thread."
          ? "双线程分支创建失败"
          : error?.message || "双线程分支创建失败";
      showToast(message, "error");
    } finally {
      setDualThreadLoading(false);
    }
  }

  async function reloadSourceHistoryIfNeeded() {
    if (!dualThreadFork.enabled || sourceHistory !== null) return;
    if (sourceItems.length > 0) return;
    const sourceHistoryFromServer = await loadFullThreadHistory(
      dualThreadFork.sourceThreadSlug
    );
    setSourceHistory(sourceHistoryFromServer);
  }

  function branchFileAccessMode() {
    return FileAccessPolicy.getSessionMode(
      workspace?.slug,
      dualThreadFork.branchThreadSlug
    );
  }

  function branchMessageEmit(messageContent = "", writeMode = "replace") {
    setMessageEmit(messageContent, writeMode, {
      targetInputId: BRANCH_PROMPT_INPUT_ID,
      targetThreadSlug: dualThreadFork.branchThreadSlug,
    });
  }

  async function handleBranchSubmit(event) {
    event.preventDefault();
    const currentMessage =
      document.getElementById(BRANCH_PROMPT_INPUT_ID)?.value || "";
    if (!currentMessage || !dualThreadFork.branchThreadSlug) return false;
    if (
      await submitPendingClarificationFromInput({
        currentDraft: branchDraft,
        currentChatKey: branchChatKey,
        message: currentMessage,
        clearInput: () => {
          clearPromptInputDraft(dualThreadFork.branchThreadSlug, {
            workspaceSlug: workspace.slug,
            threadSlug: dualThreadFork.branchThreadSlug,
          });
          branchMessageEmit("");
        },
      })
    ) {
      requestBranchSendScrollToBottom();
      return false;
    }

    clearPromptInputDraft(dualThreadFork.branchThreadSlug, {
      workspaceSlug: workspace.slug,
      threadSlug: dualThreadFork.branchThreadSlug,
    });
    branchMessageEmit("");
    startStream({
      workspaceSlug: workspace.slug,
      threadSlug: dualThreadFork.branchThreadSlug,
      prompt: currentMessage,
      clientGeneratedTurnId: createTurnId(),
      attachments: parseAttachments(),
      fileAccessMode: branchFileAccessMode(),
      history: branchHistory,
      parseAttachments,
      sendToExistingAgent: !!branchDraft?.isAgentRunning,
    });
    requestBranchSendScrollToBottom();
  }

  const sendBranchCommand = async ({
    text = "",
    autoSubmit = false,
    history = [],
    attachments = [],
    nodeContext = null,
    writeMode = "replace",
  } = {}) => {
    if (!autoSubmit) {
      branchMessageEmit(text, writeMode);
      return;
    }

    if (writeMode === "prepend") {
      const currentText =
        document.getElementById(BRANCH_PROMPT_INPUT_ID)?.value ?? "";
      text = currentText + " " + text;
    }
    if (writeMode === "append") {
      const currentText =
        document.getElementById(BRANCH_PROMPT_INPUT_ID)?.value ?? "";
      text = currentText + text;
    }
    if (!text || !dualThreadFork.branchThreadSlug) return false;
    if (
      await submitPendingClarificationFromInput({
        currentDraft: branchDraft,
        currentChatKey: branchChatKey,
        message: text,
        clearInput: () => {
          clearPromptInputDraft(dualThreadFork.branchThreadSlug, {
            workspaceSlug: workspace.slug,
            threadSlug: dualThreadFork.branchThreadSlug,
          });
          branchMessageEmit("");
        },
      })
    ) {
      requestBranchSendScrollToBottom();
      return false;
    }

    clearPromptInputDraft(dualThreadFork.branchThreadSlug, {
      workspaceSlug: workspace.slug,
      threadSlug: dualThreadFork.branchThreadSlug,
    });
    branchMessageEmit("");
    startStream({
      workspaceSlug: workspace.slug,
      threadSlug: dualThreadFork.branchThreadSlug,
      prompt: text,
      clientGeneratedTurnId: createTurnId(),
      attachments,
      fileAccessMode: branchFileAccessMode(),
      nodeContext,
      history: history.length > 0 ? history : branchHistory,
      parseAttachments,
      sendToExistingAgent: !!branchDraft?.isAgentRunning,
    });
    requestBranchSendScrollToBottom();
  };

  async function closeSourceThreadPanel() {
    const branchThreadSlug = dualThreadFork.branchThreadSlug;
    const deletedDisposableBranch = await deleteDisposableBranchIfNeeded();
    const sourceThreadSlug = dualThreadFork.sourceThreadSlug;
    resetDualThreadFork();
    if (deletedDisposableBranch) {
      navigate(
        sourceThreadSlug
          ? paths.workspace.thread(workspace.slug, sourceThreadSlug)
          : paths.workspace.chat(workspace.slug)
      );
      return;
    }
    if (branchThreadSlug)
      navigate(paths.workspace.thread(workspace.slug, branchThreadSlug));
  }

  async function closeBranchThreadPanel() {
    const sourceThreadSlug = dualThreadFork.sourceThreadSlug;
    await deleteDisposableBranchIfNeeded();
    resetDualThreadFork();
    navigate(
      sourceThreadSlug
        ? paths.workspace.thread(workspace.slug, sourceThreadSlug)
        : paths.workspace.chat(workspace.slug)
    );
  }

  useEffect(() => {
    reloadSourceHistoryIfNeeded().catch((error) => {
      console.error(error);
      showToast("旧线程历史恢复失败", "error");
      resetDualThreadFork();
    });
  }, [
    dualThreadFork.enabled,
    dualThreadFork.sourceThreadSlug,
    sourceItems.length,
  ]);

  useEffect(() => {
    if (!dualThreadFork.enabled || !sourcePanelRef.current) return;
    const panel = sourcePanelRef.current;

    function selectionBelongsToSource(selection) {
      if (!selection || selection.rangeCount === 0) return false;
      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      return (
        (!anchorNode || panel.contains(anchorNode)) &&
        (!focusNode || panel.contains(focusNode))
      );
    }

    function handleSelection() {
      clearTimeout(selectionDebounceRef.current);
      selectionDebounceRef.current = setTimeout(() => {
        const selection = window.getSelection?.();
        if (!selectionBelongsToSource(selection)) return;
        const selectedText = selection?.toString?.().trim?.() || "";
        if (selectedText.length < SELECTION_COPY_MIN_LENGTH) return;
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const signature = [
          selectedText,
          Math.round(rect.left),
          Math.round(rect.top),
          Math.round(rect.right),
          Math.round(rect.bottom),
        ].join(":");
        if (signature === lastSelectionSignatureRef.current) return;
        lastSelectionSignatureRef.current = signature;
        branchMessageEmit(`\n> 来自前文本：\n> ${selectedText}\n`, "insert");
        showToast("已复制到左侧输入框", "success");
      }, 180);
    }

    panel.addEventListener("mouseup", handleSelection);
    panel.addEventListener("keyup", handleSelection);
    return () => {
      clearTimeout(selectionDebounceRef.current);
      panel.removeEventListener("mouseup", handleSelection);
      panel.removeEventListener("keyup", handleSelection);
    };
  }, [dualThreadFork.enabled, dualThreadFork.branchThreadSlug]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const currentMessage =
      document.getElementById(PROMPT_INPUT_ID)?.value || "";
    if (!currentMessage) return false;

    if (
      await submitPendingClarificationFromInput({
        currentDraft: draft,
        currentChatKey: chatKey,
        message: currentMessage,
        clearInput: () => {
          clearPromptInputDraft(threadSlug ?? workspace.slug, {
            workspaceSlug: workspace.slug,
            threadSlug,
          });
          setMessageEmit("");
        },
      })
    ) {
      if (listening) endSTTSession();
      requestSendScrollToBottom();
      return false;
    }

    if (quizModeActive) {
      await submitQuizMessage(currentMessage);
      return false;
    }

    if (handleMindMapCommand(currentMessage)) {
      clearPromptInputDraft(threadSlug ?? workspace.slug, {
        workspaceSlug: workspace.slug,
        threadSlug,
      });
      setMessageEmit("");
      return false;
    }

    const attachments = parseAttachments();
    if (await maybeRouteQuizIntent(currentMessage, attachments)) {
      return false;
    }

    // Clear the localStorage draft for this thread/workspace so that if the
    // PromptInput remounts (empty→chat transition), it won't restore stale text
    clearPromptInputDraft(threadSlug ?? workspace.slug, {
      workspaceSlug: workspace.slug,
      threadSlug,
    });

    if (listening) {
      // Stop the mic if the send button is clicked
      endSTTSession();
    }
    const readerPayload = readerPromptPayload(currentMessage);
    setMessageEmit("");
    startStream({
      workspaceSlug: workspace.slug,
      threadSlug,
      prompt: readerPayload.prompt,
      displayPrompt: currentMessage,
      readerTextSources: readerPayload.readerTextSources,
      clientGeneratedTurnId: createTurnId(),
      attachments,
      fileAccessMode: currentFileAccessMode(),
      history: knownHistory,
      parseAttachments,
      sendToExistingAgent: !!draft?.isAgentRunning,
    });
    requestSendScrollToBottom();
  };

  function endSTTSession() {
    SpeechRecognition.stopListening();
    resetTranscript();
  }

  const regenerateAssistantMessage = (chatId, publicChatId = null) => {
    const assistantIdx = chatItems.findIndex(
      (item) => item.type === "assistant_turn" && item.chatId === chatId
    );
    const assistantTurn = chatItems[assistantIdx];
    const lastUserMessage = chatItems.find(
      (item) => item.id === assistantTurn?.userMessageId
    );
    if (!lastUserMessage?.content) return;
    Workspace.deleteChats(workspace.slug, [publicChatId || chatId])
      .then(() =>
        sendCommand({
          text: lastUserMessage.content,
          autoSubmit: true,
          history: knownHistory,
          attachments: lastUserMessage?.attachments,
          includeReaderTempTextSources: false,
        })
      )
      .catch((e) => console.error(e));
  };

  /**
   * Send a command to the LLM prompt input.
   * @param {Object} options - Arguments to send to the LLM
   * @param {string} options.text - The text to send to the LLM
   * @param {boolean} options.autoSubmit - Determines if the text should be sent immediately or if it should be added to the message state (default: false)
   * @param {Object[]} options.history - The history of the chat prior to this message for overriding the current chat history
   * @param {Object[import("./DnDWrapper").Attachment]} options.attachments - The attachments to send to the LLM for this message
   * @param {'replace' | 'append' | 'prepend'} options.writeMode - Replace current text or append to existing text (default: replace)
   * @returns {void}
   */
  const sendCommand = async ({
    text = "",
    autoSubmit = false,
    history = [],
    attachments = [],
    nodeContext = null,
    writeMode = "replace",
    includeReaderTempTextSources = true,
  } = {}) => {
    // If we are not auto-submitting, we can just emit the text to the prompt input.
    if (!autoSubmit) {
      setMessageEmit(text, writeMode);
      return;
    }

    if (writeMode === "prepend") {
      const currentText = document.getElementById(PROMPT_INPUT_ID)?.value ?? "";
      text = currentText + " " + text;
    }

    // If we are auto-submitting in append mode
    // than we need to update text with whatever is in the prompt input + the text we are sending.
    // @note: `message` will not work here since it is not updated yet.
    // If text is still empty, after this, then we should just return.
    if (writeMode === "append") {
      const currentText = document.getElementById(PROMPT_INPUT_ID)?.value ?? "";
      text = currentText + text;
    }

    if (!text || text === "") return false;

    if (
      await submitPendingClarificationFromInput({
        currentDraft: draft,
        currentChatKey: chatKey,
        message: text,
        clearInput: () => {
          clearPromptInputDraft(threadSlug ?? workspace.slug, {
            workspaceSlug: workspace.slug,
            threadSlug,
          });
          setMessageEmit("");
        },
      })
    ) {
      requestSendScrollToBottom();
      return false;
    }

    if (quizModeActive) {
      await submitQuizMessage(text, nodeContext);
      return false;
    }

    if (handleMindMapCommand(text)) {
      clearPromptInputDraft(threadSlug ?? workspace.slug, {
        workspaceSlug: workspace.slug,
        threadSlug,
      });
      setMessageEmit("");
      return false;
    }

    if (await maybeRouteQuizIntent(text, attachments)) {
      return false;
    }

    // Clear the localStorage draft so that if the PromptInput remounts
    // (e.g. /reset causing empty→chat or chat→empty transitions),
    // it won't restore stale text.
    clearPromptInputDraft(threadSlug ?? workspace.slug, {
      workspaceSlug: workspace.slug,
      threadSlug,
    });

    const readerPayload = readerPromptPayload(
      text,
      includeReaderTempTextSources
    );
    setMessageEmit("");
    startStream({
      workspaceSlug: workspace.slug,
      threadSlug,
      prompt: readerPayload.prompt,
      displayPrompt: text,
      readerTextSources: readerPayload.readerTextSources,
      clientGeneratedTurnId: createTurnId(),
      attachments,
      fileAccessMode: currentFileAccessMode(),
      nodeContext,
      history: history.length > 0 ? history : knownHistory,
      parseAttachments,
      sendToExistingAgent: !!draft?.isAgentRunning,
    });
    requestSendScrollToBottom();
  };

  useEffect(() => {
    if (pendingMessageChecked.current || !workspace?.slug) return;
    if (activeThreadIsOverview) return;
    pendingMessageChecked.current = true;

    const pending = safeJsonParse(sessionStorage.getItem(PENDING_HOME_MESSAGE));
    if (pending?.message) {
      setTimeout(() => {
        sessionStorage.removeItem(PENDING_HOME_MESSAGE);
        sendCommand({
          text: pending.message,
          attachments: pending.attachments || [],
          autoSubmit: true,
        });
      }, 100);
    }
  }, [activeThreadIsOverview, workspace?.slug]);

  const hasMessages = chatItems.length > 0;
  const hasPendingHomeMessage = !!sessionStorage.getItem(PENDING_HOME_MESSAGE);
  const isEmptyThread = !hasMessages && !hasPendingHomeMessage;
  const emptyThreadShellActive = isEmptyThread && readerActive;
  const overviewIsVisible =
    isEmptyThread &&
    !loadingResponse &&
    !readerActive &&
    !emptyThreadComposeActive;
  const memoryCompactionControl = useMemo(
    () => ({
      visible: !!threadSlug && !dualThreadFork.enabled,
      status: memoryCompactionStatus,
      loading: memoryCompactionLoading,
      pending: memoryCompactionPending,
      onCompact: compactThreadMemory,
    }),
    [
      threadSlug,
      dualThreadFork.enabled,
      memoryCompactionStatus,
      memoryCompactionLoading,
      memoryCompactionPending,
      compactThreadMemory,
    ]
  );

  useEffect(() => {
    if (!isEmptyThread) setEmptyThreadComposeActive(false);
  }, [isEmptyThread]);

  useEffect(() => {
    return () => {
      clearTimeout(selectionDebounceRef.current);
      lastSelectionSignatureRef.current = "";
      quizIntentResolverRef.current?.(false);
      quizIntentResolverRef.current = null;
    };
  }, []);

  if (activeThreadIsOverview) {
    return (
      <SourcesSidebarProvider>
        <DocumentReaderProvider
          workspace={workspace}
          threadSlug={threadSlug}
          setMessage={(message, mode = "append") =>
            setMessageEmit(message, mode)
          }
        >
          <div
            style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
            className="motion-hover relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-zinc-900 light:bg-white w-full h-full overflow-hidden border-none light:border-solid light:border light:border-theme-modal-border"
          >
            {isMobile && renderMobileHeader()}
            <WorkspaceModelPicker workspaceSlug={workspace.slug} />
            <DnDFileUploaderWrapper>
              <WorkspaceOverview
                workspace={workspace}
                threadSlug={threadSlug}
                shouldLoad={true}
                isVisible={true}
                onOpenGraph={openGraphOverviewConcept}
                onOpenPath={openGraphOverviewPath}
                onOpenEvidence={openGraphOverviewEvidence}
                onOpenDocument={() =>
                  navigate(
                    paths.workspace.settings.vectorDatabase(workspace.slug)
                  )
                }
                onUploadDocument={() =>
                  document.getElementById("dnd-chat-file-uploader")?.click()
                }
              />
            </DnDFileUploaderWrapper>
            <ChatTooltips />
            <MindMapPanel
              workspace={workspace}
              threadSlug={threadSlug}
              isOpen={mindMapOpen}
              request={mindMapRequest}
              onClose={closeMindMap}
              sendCommand={sendCommand}
              setMessage={(message) => setMessageEmit(message)}
              floating
            />
          </div>
        </DocumentReaderProvider>
      </SourcesSidebarProvider>
    );
  }

  if (dualThreadFork.enabled) {
    return (
      <SourcesSidebarProvider>
        <div
          style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
          className="relative flex gap-4 md:gap-5 md:ml-[2px] md:mr-[16px] md:my-[16px] w-full h-full z-[2] overflow-hidden px-2 py-2 md:px-4 md:py-3"
        >
          <div className="flex-[1.08] min-w-0 motion-hover relative md:rounded-[18px] bg-zinc-900 light:bg-white text-white light:text-slate-900 h-full overflow-hidden border border-white/10 light:border-white/70 shadow-[0_18px_45px_rgba(0,0,0,0.28)] light:shadow-[0_18px_42px_rgba(15,23,42,0.14)] ring-1 ring-white/5 light:ring-slate-200/70">
            {isMobile && renderMobileHeader()}
            <WorkspaceModelPicker workspaceSlug={workspace.slug} />
            <DnDFileUploaderWrapper>
              <div className="flex flex-col h-full w-full pb-20 md:pb-0">
                <div className="px-5 pt-4 pb-2 border-b border-white/10 light:border-slate-200">
                  <p className="m-0 text-xs uppercase tracking-wide text-sky-300 light:text-sky-600">
                    分支线程
                  </p>
                  <p className="m-0 text-sm text-white/70 light:text-slate-600">
                    fork 后的新线程，消息写入当前分支
                  </p>
                </div>
                <MetricsProvider>
                  <ChatHistory
                    ref={chatHistoryRef}
                    items={branchItems}
                    workspace={workspace}
                    sendCommand={sendBranchCommand}
                    regenerateAssistantMessage={() => null}
                    chatKey={branchChatKey}
                    approvalState={branchDraft?.pendingApproval}
                    onToolApprovalResponse={respondToApproval}
                    onGenerateMindMap={openMindMap}
                    activeThreadSlug={dualThreadFork.branchThreadSlug}
                    contentClassName={DUAL_THREAD_CONTENT_PADDING}
                    bottomInset={branchPromptBottomInset}
                    sendScrollRequest={branchSendScrollRequest}
                  />
                </MetricsProvider>
                <PromptInput
                  workspace={workspace}
                  submit={handleBranchSubmit}
                  isStreaming={branchLoadingResponse}
                  sendCommand={sendBranchCommand}
                  attachments={files}
                  centered={false}
                  glass={true}
                  workspaceSlug={workspace.slug}
                  threadSlug={dualThreadFork.branchThreadSlug}
                  inputId={BRANCH_PROMPT_INPUT_ID}
                  targetThreadSlug={dualThreadFork.branchThreadSlug}
                  promptStorageKey={dualThreadFork.branchThreadSlug}
                  onHeightChange={updateBranchPromptBottomInset}
                  quizModeActive={false}
                  memoryCompaction={null}
                />
              </div>
            </DnDFileUploaderWrapper>
            <ChatTooltips />
          </div>
          <div className="hidden md:flex w-3 shrink-0 items-center justify-center">
            <div className="h-[82%] w-[1px] rounded-full bg-white/10 light:bg-slate-300/45" />
          </div>
          <div
            ref={sourcePanelRef}
            className="flex-1 min-w-0 motion-hover relative md:rounded-[18px] bg-zinc-950 light:bg-slate-50 text-white light:text-slate-900 h-full overflow-hidden border border-white/10 light:border-white/70 shadow-[0_18px_45px_rgba(0,0,0,0.24)] light:shadow-[0_18px_42px_rgba(15,23,42,0.12)] ring-1 ring-white/5 light:ring-slate-200/70"
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-2 border-b border-white/10 light:border-slate-200">
              <div>
                <p className="m-0 text-xs uppercase tracking-wide text-white/50 light:text-slate-500">
                  旧线程
                </p>
                <p className="m-0 text-sm text-white/70 light:text-slate-600">
                  MVP 只读查看区
                </p>
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setCloseMenuOpen((open) => !open)}
                  className="motion-hover flex h-10 w-10 items-center justify-center rounded-full border-none bg-transparent p-0 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                  aria-label="关闭双线程面板"
                >
                  <AppIcon name="close" size="md" tone="muted" weight="bold" />
                </button>
                {closeMenuOpen && (
                  <div className="absolute right-0 top-11 z-50 w-[150px] rounded-lg border border-white/10 light:border-slate-200 bg-zinc-900 light:bg-white shadow-xl overflow-hidden">
                    <button
                      type="button"
                      onClick={closeSourceThreadPanel}
                      className="w-full border-none text-left px-3 py-2 text-sm text-white light:text-slate-900 hover:bg-zinc-800 light:hover:bg-slate-100"
                    >
                      关闭旧线程
                    </button>
                    <button
                      type="button"
                      onClick={closeBranchThreadPanel}
                      className="w-full border-none text-left px-3 py-2 text-sm text-white light:text-slate-900 hover:bg-zinc-800 light:hover:bg-slate-100"
                    >
                      关闭新线程
                    </button>
                    <button
                      type="button"
                      onClick={() => setCloseMenuOpen(false)}
                      className="w-full border-none text-left px-3 py-2 text-sm text-white/70 light:text-slate-600 hover:bg-zinc-800 light:hover:bg-slate-100"
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            </div>
            <MetricsProvider>
              <ChatHistory
                items={sourceItems}
                workspace={workspace}
                sendCommand={() => null}
                regenerateAssistantMessage={() => null}
                chatKey={sourceChatKey}
                activeThreadSlug={dualThreadFork.sourceThreadSlug}
                contentClassName={DUAL_THREAD_CONTENT_PADDING}
                readOnly
              />
            </MetricsProvider>
          </div>
        </div>
      </SourcesSidebarProvider>
    );
  }

  if (isEmptyThread && !loadingResponse) {
    return (
      <SourcesSidebarProvider>
        <DocumentReaderProvider
          workspace={workspace}
          threadSlug={threadSlug}
          setMessage={(message, mode = "append") =>
            setMessageEmit(message, mode)
          }
        >
          {emptyThreadShellActive ? (
            <div
              ref={readerLayoutRef}
              style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
              className={`relative flex md:ml-[2px] md:mr-[16px] md:my-[16px] w-full h-full z-[2] overflow-hidden px-2 py-2 md:px-4 md:py-3 ${
                readerActive ? "gap-0" : "gap-4 md:gap-5"
              }`}
            >
              <div
                className="min-w-0 motion-hover relative md:rounded-[18px] bg-zinc-900 light:bg-white text-white light:text-slate-900 h-full overflow-hidden border border-white/10 light:border-white/70 shadow-[0_18px_45px_rgba(0,0,0,0.28)] light:shadow-[0_18px_42px_rgba(15,23,42,0.14)] ring-1 ring-white/5 light:ring-slate-200/70"
                style={{
                  flex: readerActive
                    ? `${100 - readerPanelPercent} 1 0%`
                    : "1 1 0%",
                }}
              >
                {isMobile && renderMobileHeader()}
                {!readerActive && (
                  <TopRightActionZone
                    isMindMapOpen={mindMapOpen}
                    onMindMap={openMindMap}
                    onDocumentReader={openDocumentReader}
                    onDualThreadFork={startDualThreadFork}
                    dualThreadMode={dualThreadFork.enabled}
                    workspaceSlug={workspace.slug}
                  />
                )}
                <WorkspaceModelPicker workspaceSlug={workspace.slug} />
                <DnDFileUploaderWrapper>
                  <div className="flex flex-col h-full w-full pb-20 md:pb-0">
                    <div className="contents">
                      <MetricsProvider>
                        <ChatHistory
                          ref={chatHistoryRef}
                          items={chatItems}
                          workspace={workspace}
                          sendCommand={sendCommand}
                          regenerateAssistantMessage={
                            regenerateAssistantMessage
                          }
                          chatKey={chatKey}
                          approvalState={draft?.pendingApproval}
                          onToolApprovalResponse={respondToApproval}
                          onGenerateMindMap={openMindMap}
                          contentClassName={DUAL_THREAD_CONTENT_PADDING}
                          bottomInset={promptBottomInset}
                          sendScrollRequest={sendScrollRequest}
                          tailHydrationSignal={draft?.tailHydration || null}
                          tailCleanupSignal={draft?.tailCleanup || null}
                          layoutTransitionSignal={chatLayoutTransitionSignal}
                          chatScrollMemory={chatScrollMemory}
                        />
                      </MetricsProvider>
                      <MemoryCompactionDivider
                        divider={memoryCompactionDivider}
                        scopeKey={memoryCompactionScopeKey}
                        bottomInset={promptBottomInset}
                      />
                      <PromptInput
                        workspace={workspace}
                        submit={handleSubmit}
                        isStreaming={loadingResponse}
                        sendCommand={sendCommand}
                        attachments={files}
                        centered={false}
                        glass={true}
                        workspaceSlug={workspace.slug}
                        threadSlug={threadSlug}
                        onComposeStateChange={updateEmptyThreadComposeState}
                        onHeightChange={updatePromptBottomInset}
                        quizModeActive={quizModeActive}
                        onToggleQuizMode={() =>
                          setQuizModeActive((active) => !active)
                        }
                        memoryCompaction={memoryCompactionControl}
                      />
                      <QuizIntentConfirmation
                        prompt={quizIntentPrompt}
                        onConfirm={() => resolveQuizIntentPrompt(true)}
                        onCancel={() => resolveQuizIntentPrompt(false)}
                      />
                    </div>
                  </div>
                </DnDFileUploaderWrapper>
                <ChatTooltips />
              </div>
              {readerActive && (
                <ReaderSplitResizeHandle onResizeStart={startReaderResize} />
              )}
              <DocumentReaderPanel
                percent={readerPanelPercent}
                onBeforeActiveChange={setReaderActiveWithLayoutTransition}
                onReaderLayoutTransition={beginChatLayoutTransition}
              />
              <MindMapPanel
                workspace={workspace}
                threadSlug={threadSlug}
                isOpen={mindMapOpen}
                request={mindMapRequest}
                onClose={closeMindMap}
                sendCommand={sendCommand}
                setMessage={(message) => setMessageEmit(message)}
              />
              <SourcesSidebar />
            </div>
          ) : (
            <div
              style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
              className="motion-hover relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-zinc-900 light:bg-white w-full h-full overflow-hidden border-none light:border-solid light:border light:border-theme-modal-border"
            >
              {isMobile && renderMobileHeader()}
              <TopRightActionZone
                isMindMapOpen={mindMapOpen}
                onMindMap={openMindMap}
                onDocumentReader={openDocumentReader}
                onDualThreadFork={startDualThreadFork}
                dualThreadMode={dualThreadFork.enabled}
                workspaceSlug={workspace.slug}
              />
              <WorkspaceModelPicker workspaceSlug={workspace.slug} />
              <DnDFileUploaderWrapper>
                <div className="flex flex-col h-full w-full">
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <div
                      className={`motion-hover h-full transform-gpu ${
                        overviewIsVisible
                          ? "translate-y-0 opacity-100 pointer-events-auto"
                          : "translate-y-3 opacity-0 pointer-events-none"
                      }`}
                    >
                      <WorkspaceOverview
                        workspace={workspace}
                        threadSlug={threadSlug}
                        shouldLoad={isEmptyThread}
                        isVisible={overviewIsVisible}
                        onOpenGraph={openGraphOverviewConcept}
                        onOpenPath={openGraphOverviewPath}
                        onOpenEvidence={openGraphOverviewEvidence}
                        onOpenDocument={() =>
                          navigate(
                            paths.workspace.settings.vectorDatabase(
                              workspace.slug
                            )
                          )
                        }
                        onUploadDocument={() =>
                          document
                            .getElementById("dnd-chat-file-uploader")
                            ?.click()
                        }
                      />
                    </div>
                  </div>
                  <div className="overview-input-fade">
                    <div className="pointer-events-auto mx-auto flex w-full max-w-[850px] flex-col items-center">
                      <PromptInput
                        workspace={workspace}
                        submit={handleSubmit}
                        isStreaming={loadingResponse}
                        sendCommand={sendCommand}
                        attachments={files}
                        centered={true}
                        glass={true}
                        workspaceSlug={workspace.slug}
                        threadSlug={threadSlug}
                        onComposeStateChange={updateEmptyThreadComposeState}
                        quizModeActive={quizModeActive}
                        onToggleQuizMode={() =>
                          setQuizModeActive((active) => !active)
                        }
                        memoryCompaction={memoryCompactionControl}
                      />
                      <QuizIntentConfirmation
                        prompt={quizIntentPrompt}
                        onConfirm={() => resolveQuizIntentPrompt(true)}
                        onCancel={() => resolveQuizIntentPrompt(false)}
                      />
                      <QuickActions
                        hasAvailableWorkspace={!!workspace}
                        onCreateAgent={() =>
                          navigate(paths.settings.agentSkills())
                        }
                        onEditWorkspace={() =>
                          navigate(
                            paths.workspace.settings.generalAppearance(
                              workspace.slug
                            )
                          )
                        }
                        onUploadDocument={() =>
                          document
                            .getElementById("dnd-chat-file-uploader")
                            ?.click()
                        }
                      />
                    </div>
                  </div>
                  <div className="hidden">
                    <SuggestedMessages
                      suggestedMessages={workspace?.suggestedMessages}
                      sendCommand={sendCommand}
                    />
                  </div>
                </div>
              </DnDFileUploaderWrapper>
              <ChatTooltips />
              <MindMapPanel
                workspace={workspace}
                threadSlug={threadSlug}
                isOpen={mindMapOpen}
                request={mindMapRequest}
                onClose={closeMindMap}
                sendCommand={sendCommand}
                setMessage={(message) => setMessageEmit(message)}
                floating
              />
            </div>
          )}
        </DocumentReaderProvider>
      </SourcesSidebarProvider>
    );
  }

  return (
    <SourcesSidebarProvider>
      <DocumentReaderProvider
        workspace={workspace}
        threadSlug={threadSlug}
        setMessage={(message, mode = "append") => setMessageEmit(message, mode)}
      >
        <div
          ref={readerLayoutRef}
          style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
          className={`relative flex md:ml-[2px] md:mr-[16px] md:my-[16px] w-full h-full z-[2] overflow-hidden px-2 py-2 md:px-4 md:py-3 ${
            readerActive ? "gap-0" : "gap-4 md:gap-5"
          }`}
        >
          <div
            className="min-w-0 motion-hover relative md:rounded-[18px] bg-zinc-900 light:bg-white text-white light:text-slate-900 h-full overflow-hidden border border-white/10 light:border-white/70 shadow-[0_18px_45px_rgba(0,0,0,0.28)] light:shadow-[0_18px_42px_rgba(15,23,42,0.14)] ring-1 ring-white/5 light:ring-slate-200/70"
            style={{
              flex: readerActive
                ? `${100 - readerPanelPercent} 1 0%`
                : "1 1 0%",
            }}
          >
            {isMobile && renderMobileHeader()}
            {!readerActive && (
              <TopRightActionZone
                isMindMapOpen={mindMapOpen}
                onMindMap={openMindMap}
                onDocumentReader={openDocumentReader}
                onDualThreadFork={startDualThreadFork}
                dualThreadMode={dualThreadFork.enabled}
                workspaceSlug={workspace.slug}
              />
            )}
            <WorkspaceModelPicker workspaceSlug={workspace.slug} />
            <DnDFileUploaderWrapper>
              <div className="flex flex-col h-full w-full pb-20 md:pb-0">
                <div className="contents">
                  <MetricsProvider>
                    <ChatHistory
                      ref={chatHistoryRef}
                      items={chatItems}
                      workspace={workspace}
                      sendCommand={sendCommand}
                      regenerateAssistantMessage={regenerateAssistantMessage}
                      chatKey={chatKey}
                      approvalState={draft?.pendingApproval}
                      onToolApprovalResponse={respondToApproval}
                      onGenerateMindMap={openMindMap}
                      hasMoreHistory={hasMoreHistory}
                      isLoadingOlderHistory={isLoadingOlderHistory}
                      onLoadOlderHistory={onLoadOlderHistory}
                      contentClassName={DUAL_THREAD_CONTENT_PADDING}
                      bottomInset={promptBottomInset}
                      sendScrollRequest={sendScrollRequest}
                      tailHydrationSignal={draft?.tailHydration || null}
                      tailCleanupSignal={draft?.tailCleanup || null}
                      layoutTransitionSignal={chatLayoutTransitionSignal}
                      chatScrollMemory={chatScrollMemory}
                    />
                  </MetricsProvider>
                  <MemoryCompactionDivider
                    divider={memoryCompactionDivider}
                    scopeKey={memoryCompactionScopeKey}
                    bottomInset={promptBottomInset}
                  />
                  <PromptInput
                    workspace={workspace}
                    submit={handleSubmit}
                    isStreaming={loadingResponse}
                    sendCommand={sendCommand}
                    attachments={files}
                    centered={false}
                    glass={true}
                    workspaceSlug={workspace.slug}
                    threadSlug={threadSlug}
                    onHeightChange={updatePromptBottomInset}
                    quizModeActive={quizModeActive}
                    onToggleQuizMode={() =>
                      setQuizModeActive((active) => !active)
                    }
                    memoryCompaction={memoryCompactionControl}
                  />
                  <QuizIntentConfirmation
                    prompt={quizIntentPrompt}
                    onConfirm={() => resolveQuizIntentPrompt(true)}
                    onCancel={() => resolveQuizIntentPrompt(false)}
                  />
                </div>
              </div>
            </DnDFileUploaderWrapper>
            <ChatTooltips />
          </div>
          {readerActive && (
            <ReaderSplitResizeHandle onResizeStart={startReaderResize} />
          )}
          <DocumentReaderPanel
            percent={readerPanelPercent}
            onBeforeActiveChange={setReaderActiveWithLayoutTransition}
            onReaderLayoutTransition={beginChatLayoutTransition}
          />
          <MindMapPanel
            workspace={workspace}
            threadSlug={threadSlug}
            isOpen={mindMapOpen}
            request={mindMapRequest}
            onClose={closeMindMap}
            sendCommand={sendCommand}
            setMessage={(message) => setMessageEmit(message)}
          />
          <SourcesSidebar />
        </div>
      </DocumentReaderProvider>
    </SourcesSidebarProvider>
  );
}

function ReaderSplitResizeHandle({ onResizeStart }) {
  return (
    <button
      type="button"
      aria-label="调整伴读分屏比例"
      title="拖动调整左右区域"
      onPointerDown={onResizeStart}
      className="group relative hidden h-full w-10 shrink-0 cursor-col-resize items-center justify-center border-none bg-transparent p-0 md:flex"
    >
      <span className="pointer-events-none absolute inset-y-8 left-1/2 w-px -translate-x-1/2 rounded-full bg-slate-200/70 group-hover:bg-sky-300/80" />
      <span className="motion-hover relative flex h-16 w-7 items-center justify-center rounded-full border border-white/80 bg-white/90 shadow-[0_14px_34px_rgba(15,23,42,0.2)] backdrop-blur-xl group-hover:-translate-y-0.5 group-hover:scale-105 group-hover:border-sky-200 group-hover:bg-white light:border-slate-200">
        <span className="flex flex-col gap-1">
          <span className="h-1 w-1 rounded-full bg-slate-300 group-hover:bg-sky-400" />
          <span className="h-1 w-1 rounded-full bg-slate-300 group-hover:bg-sky-400" />
          <span className="h-1 w-1 rounded-full bg-slate-300 group-hover:bg-sky-400" />
        </span>
      </span>
    </button>
  );
}

function MemoryCompactionDivider({
  divider = null,
  scopeKey = "",
  bottomInset = DEFAULT_CHAT_HISTORY_BOTTOM_INSET,
}) {
  if (!divider || divider.scopeKey !== scopeKey) return null;
  const tone =
    divider.type === "error"
      ? "text-red-300 light:text-red-600"
      : divider.type === "success"
        ? "text-emerald-300 light:text-emerald-600"
        : "text-sky-300 light:text-sky-600";
  const lineTone =
    divider.type === "error"
      ? "bg-red-400/30 light:bg-red-400/35"
      : divider.type === "success"
        ? "bg-emerald-400/30 light:bg-emerald-400/35"
        : "bg-sky-400/30 light:bg-sky-400/35";

  return (
    <div
      className="pointer-events-none absolute inset-x-6 z-20 flex justify-center"
      style={{ bottom: `${Math.max(96, Number(bottomInset || 0))}px` }}
      aria-live="polite"
    >
      <div className="flex w-full max-w-[620px] items-center gap-3">
        <div className={`h-px flex-1 ${lineTone}`} />
        <div
          className={`rounded-full border border-white/10 bg-zinc-950/85 px-3 py-1 text-xs font-medium shadow-lg backdrop-blur light:border-slate-200 light:bg-white/90 ${tone}`}
        >
          {divider.text}
        </div>
        <div className={`h-px flex-1 ${lineTone}`} />
      </div>
    </div>
  );
}

function QuizIntentConfirmation({ prompt, onConfirm, onCancel }) {
  if (!prompt) return null;
  const buttonBase =
    "border rounded-2xl px-4 py-2.5 text-sm font-medium shadow-[0_10px_24px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.95)] motion-hover hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-sky-300/60 focus:ring-offset-2 focus:ring-offset-white";
  const secondaryButton = `${buttonBase} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`;
  const primaryButton = `${buttonBase} border-sky-300/40 bg-sky-500 text-white font-semibold shadow-[0_12px_32px_rgba(14,165,233,0.28),0_0_22px_rgba(125,211,252,0.22),inset_0_1px_0_rgba(255,255,255,0.24)] hover:bg-sky-400 hover:shadow-[0_16px_42px_rgba(14,165,233,0.36),0_0_30px_rgba(125,211,252,0.28),inset_0_1px_0_rgba(255,255,255,0.28)]`;
  return (
    <div className="fixed inset-x-4 bottom-28 z-40 flex justify-center pointer-events-none">
      <div className="pointer-events-auto w-full max-w-[520px] rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-[0_18px_50px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.95)]">
        <p className="m-0 text-sm font-semibold">检测到你可能想做测试题</p>
        <p className="m-0 mt-2 text-sm text-slate-600">
          是否进入测试模式？确认后会基于知识库生成测试题；取消则按普通聊天发送。
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={secondaryButton}>
            取消
          </button>
          <button type="button" onClick={onConfirm} className={primaryButton}>
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
