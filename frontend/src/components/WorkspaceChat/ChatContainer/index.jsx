import { useEffect, useContext, useRef, useMemo, useState } from "react";
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
import WorkspaceOverview from "./WorkspaceOverview";
import {
  useChatDraft,
  useChatThreadDrafts,
} from "@/contexts/ChatThreadDraftProvider";
import {
  isAssistantTurn,
  mergeServerHistoryIntoTurns,
} from "@/utils/chat/turns";
import { debugChatTurn } from "@/utils/chat/debug";
import FileAccessPolicy from "@/models/fileAccessPolicy";
import showToast from "@/utils/toast";
import {
  previousSidebarState,
  SIDEBAR_SET_STATE_EVENT,
} from "@/components/Sidebar/SidebarToggle";
import { X } from "@phosphor-icons/react";

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
function setSidebarForMindMap(open) {
  window.dispatchEvent(
    new CustomEvent(SIDEBAR_SET_STATE_EVENT, {
      detail: { open, source: "mind-map-panel" },
    })
  );
}

export default function ChatContainer({
  workspace,
  threadSlug = null,
  knownHistory = [],
  hasMoreHistory = false,
  isLoadingOlderHistory = false,
  onLoadOlderHistory = null,
}) {
  const navigate = useNavigate();
  const {
    mergeServerHistory,
    startStream,
    startLocalTurn,
    appendTimelineEvent,
    completeAssistantTurn,
    failAssistantTurn,
    respondToApproval,
    getChatKey,
  } = useChatThreadDrafts();
  const chatKey = getChatKey(workspace?.slug, threadSlug);
  const draft = useChatDraft(workspace?.slug, threadSlug);
  const knownItems = useMemo(
    () => mergeServerHistoryIntoTurns(knownHistory, [], { chatKey }),
    [knownHistory, chatKey]
  );
  const chatItems = draft?.items || knownItems;
  const loadingResponse = !!draft?.isStreaming;
  const latestAssistantTurn = lastAssistantTurn(chatItems);
  const [mindMapOpen, setMindMapOpen] = useState(false);
  const [mindMapRequest, setMindMapRequest] = useState(null);
  const [quizModeActive, setQuizModeActive] = useState(false);
  const [quizIntentPrompt, setQuizIntentPrompt] = useState(null);
  const { files, parseAttachments } = useContext(DndUploaderContext);
  const { chatHistoryRef } = useChatContainerQuickScroll();
  const pendingMessageChecked = useRef(false);
  const mindMapSidebarStateRef = useRef(null);
  const quizIntentResolverRef = useRef(null);
  const sourcePanelRef = useRef(null);
  const selectionDebounceRef = useRef(null);
  const lastSelectionSignatureRef = useRef("");
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
  const sourceItems = useMemo(
    () =>
      sourceHistory
        ? mergeServerHistoryIntoTurns(sourceHistory, [], {
            chatKey: sourceChatKey,
          })
        : chatItems,
    [chatItems, sourceChatKey, sourceHistory]
  );

  const { listening, resetTranscript } = useSpeechRecognition({
    clearTranscriptOnListen: true,
  });

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
    setMindMapOpen(true);
    setMindMapRequest({ id: Date.now(), body });
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
      setMindMapOpen(true);
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
    clearPromptInputDraft(threadSlug ?? workspace.slug);
    setMessageEmit("");
    setQuizModeActive(false);
    if (listening) endSTTSession();
    const localTurn = startLocalTurn({
      workspaceSlug: workspace.slug,
      threadSlug,
      prompt: message,
      history: knownHistory,
    });
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
        result?.insufficientEvidence
          ? "知识库资料不足，暂时无法生成测试题。"
          : result?.error || "测试题生成失败。"
      );
      showToast(
        result?.insufficientEvidence
          ? "知识库资料不足，暂时无法生成测试题。"
          : result?.error || "测试题生成失败。",
        "error"
      );
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
    if (isMobile) return;

    if (mindMapOpen) {
      if (mindMapSidebarStateRef.current === null)
        mindMapSidebarStateRef.current = previousSidebarState();
      setSidebarForMindMap(false);
      return;
    }

    if (mindMapSidebarStateRef.current === null) return;
    const shouldRestoreOpen = mindMapSidebarStateRef.current;
    mindMapSidebarStateRef.current = null;
    setSidebarForMindMap(shouldRestoreOpen);
  }, [mindMapOpen]);

  useEffect(() => {
    return () => {
      if (isMobile || mindMapSidebarStateRef.current === null) return;
      setSidebarForMindMap(mindMapSidebarStateRef.current);
      mindMapSidebarStateRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!workspace?.slug || !chatKey) return;
    mergeServerHistory({
      workspaceSlug: workspace.slug,
      threadSlug,
      history: knownHistory,
    });
  }, [workspace?.slug, threadSlug, chatKey, knownHistory, mergeServerHistory]);

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
    setBranchHistory([]);
    setSourceHistory(null);
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
        sourceThreadId: result?.sourceThread?.id || null,
        branchThreadSlug,
        branchThreadId: result?.newThread?.id || null,
        forkedAtMessageId: result?.forkedAtMessageId || lastVisibleChatId,
        sourcePanelVisible: true,
        branchPanelVisible: true,
      });
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
    clearPromptInputDraft(dualThreadFork.branchThreadSlug);
    branchMessageEmit("");
    startStream({
      workspaceSlug: workspace.slug,
      threadSlug: dualThreadFork.branchThreadSlug,
      prompt: currentMessage,
      attachments: parseAttachments(),
      fileAccessMode: branchFileAccessMode(),
      history: branchHistory,
      parseAttachments,
      sendToExistingAgent: !!branchDraft?.isAgentRunning,
    });
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

    clearPromptInputDraft(dualThreadFork.branchThreadSlug);
    branchMessageEmit("");
    startStream({
      workspaceSlug: workspace.slug,
      threadSlug: dualThreadFork.branchThreadSlug,
      prompt: text,
      attachments,
      fileAccessMode: branchFileAccessMode(),
      nodeContext,
      history: history.length > 0 ? history : branchHistory,
      parseAttachments,
      sendToExistingAgent: !!branchDraft?.isAgentRunning,
    });
  };

  function closeSourceThreadPanel() {
    const branchThreadSlug = dualThreadFork.branchThreadSlug;
    resetDualThreadFork();
    if (branchThreadSlug)
      navigate(paths.workspace.thread(workspace.slug, branchThreadSlug));
  }

  function closeBranchThreadPanel() {
    const sourceThreadSlug = dualThreadFork.sourceThreadSlug;
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
        branchMessageEmit(
          `\n> 来自右侧旧线程：\n> ${selectedText}\n`,
          "insert"
        );
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

    if (quizModeActive) {
      await submitQuizMessage(currentMessage);
      return false;
    }

    if (handleMindMapCommand(currentMessage)) {
      clearPromptInputDraft(threadSlug ?? workspace.slug);
      setMessageEmit("");
      return false;
    }

    const attachments = parseAttachments();
    if (await maybeRouteQuizIntent(currentMessage, attachments)) {
      return false;
    }

    // Clear the localStorage draft for this thread/workspace so that if the
    // PromptInput remounts (empty→chat transition), it won't restore stale text
    clearPromptInputDraft(threadSlug ?? workspace.slug);

    if (listening) {
      // Stop the mic if the send button is clicked
      endSTTSession();
    }
    setMessageEmit("");
    startStream({
      workspaceSlug: workspace.slug,
      threadSlug,
      prompt: currentMessage,
      attachments,
      fileAccessMode: currentFileAccessMode(),
      history: knownHistory,
      parseAttachments,
      sendToExistingAgent: !!draft?.isAgentRunning,
    });
  };

  function endSTTSession() {
    SpeechRecognition.stopListening();
    resetTranscript();
  }

  const regenerateAssistantMessage = (chatId) => {
    const assistantIdx = chatItems.findIndex(
      (item) => item.type === "assistant_turn" && item.chatId === chatId
    );
    const assistantTurn = chatItems[assistantIdx];
    const lastUserMessage = chatItems.find(
      (item) => item.id === assistantTurn?.userMessageId
    );
    if (!lastUserMessage?.content) return;
    Workspace.deleteChats(workspace.slug, [chatId])
      .then(() =>
        sendCommand({
          text: lastUserMessage.content,
          autoSubmit: true,
          history: knownHistory,
          attachments: lastUserMessage?.attachments,
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

    if (quizModeActive) {
      await submitQuizMessage(text, nodeContext);
      return false;
    }

    if (handleMindMapCommand(text)) {
      clearPromptInputDraft(threadSlug ?? workspace.slug);
      setMessageEmit("");
      return false;
    }

    if (await maybeRouteQuizIntent(text, attachments)) {
      return false;
    }

    // Clear the localStorage draft so that if the PromptInput remounts
    // (e.g. /reset causing empty→chat or chat→empty transitions),
    // it won't restore stale text.
    clearPromptInputDraft(threadSlug ?? workspace.slug);

    setMessageEmit("");
    startStream({
      workspaceSlug: workspace.slug,
      threadSlug,
      prompt: text,
      attachments,
      fileAccessMode: currentFileAccessMode(),
      nodeContext,
      history: history.length > 0 ? history : knownHistory,
      parseAttachments,
      sendToExistingAgent: !!draft?.isAgentRunning,
    });
  };

  useEffect(() => {
    if (pendingMessageChecked.current || !workspace?.slug) return;
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
  }, [workspace?.slug]);

  const hasMessages = chatItems.length > 0;
  const hasPendingHomeMessage = !!sessionStorage.getItem(PENDING_HOME_MESSAGE);
  const isEmptyThread = !hasMessages && !hasPendingHomeMessage;
  const overviewIsVisible = isEmptyThread && !loadingResponse;

  useEffect(() => {
    return () => {
      clearTimeout(selectionDebounceRef.current);
      lastSelectionSignatureRef.current = "";
      quizIntentResolverRef.current?.(false);
      quizIntentResolverRef.current = null;
    };
  }, []);

  if (dualThreadFork.enabled) {
    return (
      <SourcesSidebarProvider>
        <div
          style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
          className="relative flex gap-4 md:gap-5 md:ml-[2px] md:mr-[16px] md:my-[16px] w-full h-full z-[2] overflow-hidden px-2 py-2 md:px-4 md:py-3"
        >
          <div className="flex-[1.08] min-w-0 motion-hover relative md:rounded-[18px] bg-zinc-900 light:bg-white text-white light:text-slate-900 h-full overflow-hidden border border-white/10 light:border-white/70 shadow-[0_18px_45px_rgba(0,0,0,0.28)] light:shadow-[0_18px_42px_rgba(15,23,42,0.14)] ring-1 ring-white/5 light:ring-slate-200/70">
            {isMobile && <SidebarMobileHeader />}
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
                  quizModeActive={false}
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
                  className="liquid-glass-control group cursor-pointer flex items-center justify-center w-[35px] h-[35px] rounded-full"
                  aria-label="关闭双线程面板"
                >
                  <X
                    size={18}
                    className="text-zinc-200 light:text-slate-600 group-hover:text-white light:group-hover:text-blue-600"
                  />
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
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="motion-hover relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-zinc-900 light:bg-white w-full h-full overflow-hidden border-none light:border-solid light:border light:border-theme-modal-border"
      >
        {isMobile && <SidebarMobileHeader />}
        <TopRightActionZone
          isMindMapOpen={mindMapOpen}
          onMindMap={() => setMindMapOpen(true)}
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
                      paths.workspace.settings.vectorDatabase(workspace.slug)
                    )
                  }
                  onUploadDocument={() =>
                    document.getElementById("dnd-chat-file-uploader")?.click()
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
                  quizModeActive={quizModeActive}
                  onToggleQuizMode={() =>
                    setQuizModeActive((active) => !active)
                  }
                />
                <QuizIntentConfirmation
                  prompt={quizIntentPrompt}
                  onConfirm={() => resolveQuizIntentPrompt(true)}
                  onCancel={() => resolveQuizIntentPrompt(false)}
                />
                <QuickActions
                  hasAvailableWorkspace={!!workspace}
                  onCreateAgent={() => navigate(paths.settings.agentSkills())}
                  onEditWorkspace={() =>
                    navigate(
                      paths.workspace.settings.generalAppearance(workspace.slug)
                    )
                  }
                  onUploadDocument={() =>
                    document.getElementById("dnd-chat-file-uploader")?.click()
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
          onClose={() => setMindMapOpen(false)}
          sendCommand={sendCommand}
          setMessage={(message) => setMessageEmit(message)}
          floating
        />
      </div>
    );
  }

  return (
    <SourcesSidebarProvider>
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative flex md:ml-[2px] md:mr-[16px] md:my-[16px] w-full h-full z-[2]"
      >
        <div className="flex-1 min-w-0 motion-hover relative md:rounded-[16px] bg-zinc-900 light:bg-white text-white light:text-slate-900 h-full overflow-hidden border-none light:border-solid light:border light:border-theme-modal-border">
          {isMobile && <SidebarMobileHeader />}
          <TopRightActionZone
            isMindMapOpen={mindMapOpen}
            onMindMap={() => setMindMapOpen(true)}
            onDualThreadFork={startDualThreadFork}
            dualThreadMode={dualThreadFork.enabled}
            workspaceSlug={workspace.slug}
          />
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
                  />
                </MetricsProvider>
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
                  quizModeActive={quizModeActive}
                  onToggleQuizMode={() =>
                    setQuizModeActive((active) => !active)
                  }
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
        <MindMapPanel
          workspace={workspace}
          threadSlug={threadSlug}
          isOpen={mindMapOpen}
          request={mindMapRequest}
          onClose={() => setMindMapOpen(false)}
          sendCommand={sendCommand}
          setMessage={(message) => setMessageEmit(message)}
        />
        <SourcesSidebar />
      </div>
    </SourcesSidebarProvider>
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
