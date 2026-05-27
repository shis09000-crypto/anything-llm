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

function lastAssistantTurn(items = []) {
  return [...items].reverse().find((item) => isAssistantTurn(item));
}

const OVERVIEW_ANIMATION_MS = 700;
const OVERVIEW_SHOW_DEBOUNCE_MS = 300;
const QUIZ_INTENT_PATTERN =
  /(出|生成|来|做|练|考|测).{0,8}(题|测试|测验|quiz|question)|(?:quiz|test)\s*(me|questions?)|(?:单选|多选|填空|选择题|练习题|测试题|测验题|考考我|自测)/i;
const NON_QUIZ_TEST_PATTERN =
  /(测试连接|测试接口|测试功能|测试代码|test connection|unit test|integration test|e2e test|jest|vitest|pytest)/i;
const EMPTY_COMPOSE_STATE = {
  hasDraftInput: false,
  isComposing: false,
  slashMenuOpen: false,
  hasAttachments: false,
  isVoiceInputActive: false,
  isStreaming: false,
};

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
  const { files, dragging, parseAttachments } = useContext(DndUploaderContext);
  const { chatHistoryRef } = useChatContainerQuickScroll();
  const pendingMessageChecked = useRef(false);
  const mindMapSidebarStateRef = useRef(null);
  const overviewShowTimerRef = useRef(null);
  const overviewHideTimerRef = useRef(null);
  const quizIntentResolverRef = useRef(null);
  const [composeState, setComposeState] = useState(EMPTY_COMPOSE_STATE);
  const [overviewVisible, setOverviewVisible] = useState(true);
  const [overviewVisibilityHidden, setOverviewVisibilityHidden] =
    useState(false);

  const { listening, resetTranscript } = useSpeechRecognition({
    clearTranscriptOnListen: true,
  });

  /**
   * Emit an update to the state of the prompt input without directly
   * passing a prop in so that it does not re-render constantly.
   * @param {string} messageContent - The message content to set
   * @param {'replace' | 'append'} writeMode - Replace current text or append to existing text (default: replace)
   */
  function setMessageEmit(messageContent = "", writeMode = "replace") {
    window.dispatchEvent(
      new CustomEvent(PROMPT_INPUT_EVENT, {
        detail: { messageContent, writeMode },
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

  const handleComposeStateChange = useCallback((nextState = {}) => {
    setComposeState((previous) => {
      const next = { ...previous, ...nextState };
      return Object.keys(EMPTY_COMPOSE_STATE).every(
        (key) => previous[key] === next[key]
      )
        ? previous
        : next;
    });
  }, []);

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
  const hasAttachments =
    (files?.length || 0) > 0 || Boolean(composeState.hasAttachments);
  const isDraggingFile = Boolean(dragging);
  const shouldShowOverview =
    isEmptyThread &&
    !composeState.isComposing &&
    !composeState.hasDraftInput &&
    !composeState.slashMenuOpen &&
    !hasAttachments &&
    !composeState.isVoiceInputActive &&
    !loadingResponse;
  const overviewIsVisible =
    shouldShowOverview &&
    !isDraggingFile &&
    overviewVisible &&
    !overviewVisibilityHidden;

  useEffect(() => {
    return () => {
      clearTimeout(overviewShowTimerRef.current);
      clearTimeout(overviewHideTimerRef.current);
      quizIntentResolverRef.current?.(false);
      quizIntentResolverRef.current = null;
    };
  }, []);

  useEffect(() => {
    clearTimeout(overviewShowTimerRef.current);
    clearTimeout(overviewHideTimerRef.current);

    if (!isEmptyThread || loadingResponse) {
      setOverviewVisible(false);
      setOverviewVisibilityHidden(true);
      return;
    }

    if (!shouldShowOverview || isDraggingFile) {
      setOverviewVisible(false);
      setOverviewVisibilityHidden(false);
      overviewHideTimerRef.current = setTimeout(() => {
        setOverviewVisibilityHidden(true);
      }, OVERVIEW_ANIMATION_MS);
      return;
    }

    overviewShowTimerRef.current = setTimeout(() => {
      setOverviewVisibilityHidden(false);
      requestAnimationFrame(() => setOverviewVisible(true));
    }, OVERVIEW_SHOW_DEBOUNCE_MS);
  }, [isDraggingFile, isEmptyThread, loadingResponse, shouldShowOverview]);

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
          workspaceSlug={workspace.slug}
        />
        <WorkspaceModelPicker workspaceSlug={workspace.slug} />
        <DnDFileUploaderWrapper>
          <div className="flex flex-col h-full w-full">
            <div className="flex-1 min-h-0 overflow-hidden">
              <div
                className={`h-full transform-gpu transition-[opacity,transform,filter] ease-[cubic-bezier(0.22,1,0.36,1)] ${
                  overviewVisible && !isDraggingFile
                    ? "translate-y-0 scale-100 opacity-100 blur-0"
                    : "translate-y-8 scale-[0.985] opacity-0 blur-[5px]"
                } ${
                  overviewIsVisible
                    ? "visible pointer-events-auto"
                    : overviewVisibilityHidden
                      ? "invisible pointer-events-none"
                      : "visible pointer-events-none"
                }`}
              >
                <WorkspaceOverview
                  workspace={workspace}
                  threadSlug={threadSlug}
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
                  onComposeStateChange={handleComposeStateChange}
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
