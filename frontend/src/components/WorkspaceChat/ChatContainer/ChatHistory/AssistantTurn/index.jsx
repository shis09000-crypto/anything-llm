import { memo, useEffect, useMemo, useState } from "react";
import { Warning } from "@phosphor-icons/react";
import Citations from "../Citation";
import Actions from "../HistoricalMessage/Actions";
import TTSMessage from "../HistoricalMessage/Actions/TTSButton";
import HistoricalOutputs from "../HistoricalMessage/HistoricalOutputs";
import HistoricalClarifyingQuestions from "../HistoricalMessage/HistoricalClarifyingQuestions";
import {
  EditMessageForm,
  useEditMessage,
} from "../HistoricalMessage/Actions/EditMessage";
import { useWatchDeleteMessage } from "../HistoricalMessage/Actions/DeleteMessage";
import { chatQueryRefusalResponse } from "@/utils/chat";
import paths from "@/utils/paths";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import MarkdownOutput from "./MarkdownOutput";
import ThoughtTimeline from "./ThoughtTimeline";
import ToolEvent from "./ToolEvent";
import { debugChatTurn } from "@/utils/chat/debug";
import DocumentSourceChips from "@/modules/reader/DocumentSourceChips";
import { useChatThreadDrafts } from "@/contexts/ChatThreadDraftProvider";
import { BLOB_KINDS, requestBlob } from "@/lib/communication/blobClient";
import { completedAssistantTurnReadyForActions } from "@/utils/chat/turnActivity";

function AssistantTurn({
  turn,
  workspace,
  chatKey,
  approvalState = null,
  onToolApprovalResponse,
  onGenerateMindMap,
  regenerateMessage,
  saveEditedMessage,
  forkThread,
  isLastMessage = false,
  readOnly = false,
  onContentLayoutChange = null,
}) {
  const { t } = useTranslation();
  const { continueInterruptedAgentTurn, respondToClarification } =
    useChatThreadDrafts();
  const [fullContent, setFullContent] = useState(null);
  const [contentLoadState, setContentLoadState] = useState("idle");
  const displayContent = fullContent ?? turn.finalContent;
  useEffect(() => {
    setFullContent(null);
    setContentLoadState("idle");
  }, [turn.textRef?.refId]);

  const loadFullContent = async () => {
    if (!turn.textRef?.contentUrl || contentLoadState === "loading") return;
    setContentLoadState("loading");
    try {
      const { blob } = await requestBlob(turn.textRef.contentUrl, {
        blobKind: BLOB_KINDS.chatContent,
        communicationScene: "workspace-chat-content",
      });
      setFullContent(await blob.text());
      setContentLoadState("loaded");
    } catch {
      setContentLoadState("failed");
    }
  };
  const { isEditing } = useEditMessage({
    chatId: turn.chatId,
    role: "assistant",
  });
  const { isDeleted, completeDelete, onEndAnimation } = useWatchDeleteMessage({
    chatId: turn.chatId,
    publicChatId: turn.publicChatId,
    role: "assistant",
  });
  const thoughtEvents = useMemo(
    () =>
      (turn.timeline || []).filter((event) =>
        ["thought", "markdown_delta"].includes(event.type)
      ),
    [turn.timeline]
  );
  const normalToolEvents = useMemo(
    () =>
      (turn.timeline || []).filter((event) =>
        ["tool_call", "tool_result"].includes(event.type)
      ),
    [turn.timeline]
  );
  const approvalEvents = useMemo(
    () =>
      (turn.timeline || []).filter(
        (event) => event.type === "approval_request"
      ),
    [turn.timeline]
  );
  const errorEvents = useMemo(
    () => (turn.timeline || []).filter((event) => event.type === "error"),
    [turn.timeline]
  );
  const approvalResults = useMemo(
    () =>
      new Map(
        (turn.timeline || [])
          .filter((event) => event.type === "approval_result")
          .map((event) => [event.requestId, event])
      ),
    [turn.timeline]
  );
  const clarificationResults = useMemo(
    () =>
      new Map(
        (turn.timeline || [])
          .filter((event) => event.type === "clarification_result")
          .map((event) => [event.requestId, event])
      ),
    [turn.timeline]
  );
  const isRunning = turn.status === "running";
  const clarificationEvents = useMemo(
    () =>
      (turn.timeline || []).filter(
        (event) =>
          event.type === "clarification_request" &&
          isRunning &&
          !clarificationResults.has(event.requestId)
      ),
    [clarificationResults, isRunning, turn.timeline]
  );
  const isFailed = turn.status === "failed";
  const isReconnectOffer = turn.reconnectState === "offer";
  const isRefusalMessage =
    turn.finalContent === chatQueryRefusalResponse(workspace);
  const turnOutputs = useMemo(
    () => (Array.isArray(turn.outputs) ? turn.outputs : []),
    [turn.outputs]
  );
  const quizOutputs = useMemo(
    () => turnOutputs.filter((output) => output?.type === "QuizCard"),
    [turnOutputs]
  );
  const nonQuizOutputs = useMemo(
    () => turnOutputs.filter((output) => output?.type !== "QuizCard"),
    [turnOutputs]
  );
  const isLightPlaceholder =
    turn.hydrationStatus === "light" && !turn.finalContent && !isRunning;
  const showCompletedActions = completedAssistantTurnReadyForActions(turn);

  useEffect(() => {
    debugChatTurn("AssistantTurn:renderState", {
      chatKey,
      turnId: turn.turnId,
      chatId: turn.chatId || null,
      status: turn.status,
      isRunning,
      dotLoaderVisible: isRunning && !turn.finalContent,
      finalContentLength: turn.finalContent?.length || 0,
      timelineEventCount: turn.timeline?.length || 0,
      thoughtCount: thoughtEvents.length,
      toolEventCount: normalToolEvents.length,
      approvalEventCount: approvalEvents.length,
      clarificationEventCount: clarificationEvents.length,
    });
  }, [
    approvalEvents.length,
    chatKey,
    clarificationEvents.length,
    isRunning,
    normalToolEvents.length,
    thoughtEvents.length,
    turn.chatId,
    turn.finalContent,
    turn.status,
    turn.timeline,
    turn.turnId,
  ]);

  if (completeDelete) return null;

  function adjustTextArea(event) {
    const element = event.target;
    element.style.height = "auto";
    element.style.height = element.scrollHeight + "px";
  }

  return (
    <div
      onAnimationEnd={onEndAnimation}
      className={`${isDeleted ? "animate-remove" : ""} flex justify-start w-full group`}
    >
      <div className="py-4 px-4 md:pl-0 flex flex-col w-full">
        <ThoughtTimeline
          events={thoughtEvents}
          toolEvents={normalToolEvents}
          isRunning={isRunning}
          stateId={`${turn.id}:timeline`}
        />
        {approvalEvents.map((event) => (
          <ToolEvent
            key={event.id}
            event={event}
            approvalResult={approvalResults.get(event.requestId)}
            approvalState={approvalState}
            chatKey={chatKey}
            onToolApprovalResponse={onToolApprovalResponse}
          />
        ))}
        {clarificationEvents.map((event) => (
          <ToolEvent
            key={event.id}
            event={event}
            chatKey={chatKey}
            onClarificationResponse={respondToClarification}
          />
        ))}
        {errorEvents.map((event) => (
          <ToolEvent key={event.id} event={event} />
        ))}
        {isEditing && !readOnly ? (
          <EditMessageForm
            role="assistant"
            chatId={turn.chatId}
            publicChatId={turn.publicChatId}
            message={displayContent}
            adjustTextArea={adjustTextArea}
            saveChanges={saveEditedMessage}
          />
        ) : (
          <div className="break-words">
            <HistoricalOutputs
              outputs={quizOutputs}
              workspace={workspace}
              chatKey={chatKey}
              turnId={turn.turnId}
              className="flex flex-col gap-2 mb-4"
            />
            {displayContent ? (
              <MarkdownOutput
                content={displayContent}
                messageId={turn.id}
                isStreaming={isRunning}
                deferEnhancement={isRunning || isLastMessage}
                onLayoutChange={onContentLayoutChange}
              />
            ) : isRunning ? (
              <div className="mt-3 ml-1 dot-falling light:invert" />
            ) : null}
            {isRunning && turn.streamConnectionState === "reconnecting" && (
              <p className="mt-2 text-xs text-theme-text-secondary">
                正在重连…
              </p>
            )}
            {turn.truncated && fullContent === null && (
              <button
                type="button"
                onClick={loadFullContent}
                disabled={contentLoadState === "loading"}
                className="mt-3 px-3 py-1.5 rounded-md border border-theme-sidebar-border bg-theme-bg-secondary text-theme-text-primary text-xs disabled:opacity-60"
              >
                {contentLoadState === "loading"
                  ? "Loading full response…"
                  : contentLoadState === "failed"
                    ? "Retry full response"
                    : "Load full response"}
              </button>
            )}
            {turn.hydrationStatus === "light" && (
              <div
                className="mt-3 space-y-2 min-h-[44px]"
                aria-label="正在加载对话内容"
              >
                <div className="motion-skeleton h-3 w-1/2 rounded" />
                <div className="motion-skeleton h-3 w-1/3 rounded" />
              </div>
            )}
            {isRefusalMessage && (
              <Link
                data-tooltip-id="query-refusal-info"
                data-tooltip-content={`${t("chat.refusal.tooltip-description")}`}
                className="!no-underline group !flex w-fit"
                to={paths.chatModes()}
                target="_blank"
              >
                <div className="flex flex-row items-center gap-x-1 group-hover:opacity-100 opacity-60 w-fit">
                  <p className="!m-0 !p-0 text-theme-text-secondary !no-underline text-xs cursor-pointer">
                    {t("chat.refusal.tooltip-title")}
                  </p>
                </div>
              </Link>
            )}
            <HistoricalOutputs
              outputs={nonQuizOutputs}
              workspace={workspace}
              chatKey={chatKey}
              turnId={turn.turnId}
            />
            <HistoricalClarifyingQuestions
              surveys={turn.clarifyingQuestions || []}
            />
          </div>
        )}
        {isFailed && (
          <div className="mt-2 p-2 rounded-lg bg-red-50 text-red-500 w-fit">
            <span className="inline-flex items-center gap-1">
              <Warning className="h-4 w-4" /> Could not respond to message.
            </span>
            {turn.error && (
              <p className="text-xs font-mono mt-2 border-l-2 border-red-300 pl-2 bg-red-200 p-2 rounded-sm">
                {turn.error}
              </p>
            )}
          </div>
        )}
        {isReconnectOffer && !readOnly && (
          <div className="mt-3 p-3 rounded-lg bg-theme-bg-secondary border border-theme-sidebar-border w-fit max-w-full">
            <p className="text-sm text-theme-text-primary m-0">
              Agent connection reached the reconnect limit. Continue using the
              recorded tool results and partial answer?
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  continueInterruptedAgentTurn(chatKey, turn.turnId, true)
                }
                className="px-3 py-1.5 rounded-md bg-primary-button text-white text-xs font-medium"
              >
                Reconnect
              </button>
              <button
                type="button"
                onClick={() =>
                  continueInterruptedAgentTurn(chatKey, turn.turnId, false)
                }
                className="px-3 py-1.5 rounded-md bg-theme-bg-primary text-theme-text-primary border border-theme-sidebar-border text-xs font-medium"
              >
                Keep interrupted
              </button>
            </div>
          </div>
        )}
        {!readOnly && !isLightPlaceholder && showCompletedActions && (
          <div className="flex items-start gap-x-1">
            <TTSMessage
              slug={workspace?.slug}
              chatId={turn.chatId}
              publicChatId={turn.publicChatId}
              message={displayContent}
            />
            <Actions
              message={displayContent}
              feedbackScore={turn.feedbackScore}
              chatId={turn.chatId}
              publicChatId={turn.publicChatId}
              slug={workspace?.slug}
              isLastMessage={isLastMessage}
              regenerateMessage={regenerateMessage}
              isEditing={isEditing}
              role="assistant"
              forkThread={forkThread}
              metrics={turn.metrics}
              execution={turn.execution}
              onGenerateMindMap={onGenerateMindMap}
            />
          </div>
        )}
        <Citations sources={turn.sources} />
        <DocumentSourceChips chatKey={chatKey} turn={turn} />
      </div>
    </div>
  );
}

export default memo(AssistantTurn);
