import { memo, useEffect, useMemo } from "react";
import { Warning } from "@phosphor-icons/react";
import Citations from "../Citation";
import Actions from "../HistoricalMessage/Actions";
import TTSMessage from "../HistoricalMessage/Actions/TTSButton";
import HistoricalOutputs from "../HistoricalMessage/HistoricalOutputs";
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
import DocumentSourceChips from "../../DocumentReader/DocumentSourceChips";
import { useChatThreadDrafts } from "@/contexts/ChatThreadDraftProvider";

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
  const { continueInterruptedAgentTurn } = useChatThreadDrafts();
  const { isEditing } = useEditMessage({
    chatId: turn.chatId,
    role: "assistant",
  });
  const { isDeleted, completeDelete, onEndAnimation } = useWatchDeleteMessage({
    chatId: turn.chatId,
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
  const isRunning = turn.status === "running";
  const isFailed = turn.status === "failed";
  const isReconnectOffer = turn.reconnectState === "offer";
  const isRefusalMessage =
    turn.finalContent === chatQueryRefusalResponse(workspace);

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
    });
  }, [
    approvalEvents.length,
    chatKey,
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
        {errorEvents.map((event) => (
          <ToolEvent key={event.id} event={event} />
        ))}
        {isEditing && !readOnly ? (
          <EditMessageForm
            role="assistant"
            chatId={turn.chatId}
            message={turn.finalContent}
            adjustTextArea={adjustTextArea}
            saveChanges={saveEditedMessage}
          />
        ) : (
          <div className="break-words">
            {turn.finalContent ? (
              <MarkdownOutput
                content={turn.finalContent}
                messageId={turn.id}
                deferEnhancement={!isLastMessage}
                onLayoutChange={onContentLayoutChange}
              />
            ) : isRunning ? (
              <div className="mt-3 ml-1 dot-falling light:invert" />
            ) : null}
            {turn.hydrationStatus === "light" && (
              <div className="mt-3 space-y-2" aria-hidden="true">
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
              outputs={turn.outputs || []}
              workspace={workspace}
              chatKey={chatKey}
              turnId={turn.turnId}
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
        {!readOnly && (
          <div className="flex items-start gap-x-1">
            <TTSMessage
              slug={workspace?.slug}
              chatId={turn.chatId}
              message={turn.finalContent}
            />
            <Actions
              message={turn.finalContent}
              feedbackScore={turn.feedbackScore}
              chatId={turn.chatId}
              slug={workspace?.slug}
              isLastMessage={isLastMessage}
              regenerateMessage={regenerateMessage}
              isEditing={isEditing}
              role="assistant"
              forkThread={forkThread}
              metrics={turn.metrics}
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
