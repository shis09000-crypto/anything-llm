import React, { memo, useState } from "react";
import useCopyText from "@/hooks/useCopyText";
import {
  Check,
  ThumbsUp,
  ArrowsClockwise,
  Copy,
  GitFork,
} from "@phosphor-icons/react";
import Workspace from "@/models/workspace";
import { EditMessageAction } from "./EditMessage";
import RenderMetrics from "./RenderMetrics";
import ActionMenu from "./ActionMenu";
import { useTranslation } from "react-i18next";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";

const Actions = ({
  message,
  feedbackScore,
  chatId,
  publicChatId = null,
  slug,
  isLastMessage,
  regenerateMessage,
  forkThread,
  isEditing,
  role,
  metrics = {},
  onGenerateMindMap,
}) => {
  const { t } = useTranslation();
  const [selectedFeedback, setSelectedFeedback] = useState(feedbackScore);
  const actionChatId = publicChatId || chatId;
  const handleFeedback = async (newFeedback) => {
    const previousFeedback = selectedFeedback;
    const updatedFeedback =
      selectedFeedback === newFeedback ? null : newFeedback;
    const action = optimisticActionCenter.run({
      type: "chat.message.feedback",
      scope: {
        route: "workspace-chat",
        workspaceSlug: slug,
        chatId: actionChatId,
        surface: "chat-history",
      },
      priority: "P1",
      policy: "visible",
      intentRank: 0,
      protected: true,
      abortable: false,
      label: "optimistic:chat-message-feedback",
      dedupeKey: `optimistic:chat-feedback:${slug}:${actionChatId}`,
      optimisticPatch: () => setSelectedFeedback(updatedFeedback),
      rollbackPatch: () => setSelectedFeedback(previousFeedback),
      serverCall: async ({ signal }) => {
        const ok = await Workspace.updateChatFeedback(
          actionChatId,
          slug,
          updatedFeedback,
          {
            signal,
            task: false,
          }
        );
        if (!ok) throw new Error("Feedback update failed");
        return true;
      },
    });
    await action.promise;
  };

  return (
    <div
      className={`flex w-full flex-wrap items-center gap-y-1 ${role === "user" ? "justify-end" : "justify-between"}`}
    >
      <div className="flex justify-start items-center gap-x-[8px]">
        <div className="md:group-hover:opacity-100 motion-hover md:opacity-0 flex justify-start items-center gap-x-[8px]">
          <div
            className={`flex justify-start items-center gap-x-[8px] ${role === "user" ? "flex-row-reverse" : ""}`}
          >
            <CopyMessage message={message} />
            <EditMessageAction
              chatId={chatId}
              role={role}
              isEditing={isEditing}
            />
          </div>
          {isLastMessage && !isEditing && (
            <RegenerateMessage
              regenerateMessage={regenerateMessage}
              slug={slug}
              chatId={chatId}
              publicChatId={publicChatId}
            />
          )}
          {chatId && role !== "user" && !isEditing && (
            <MindMapButton
              message={message}
              chatId={chatId}
              onGenerateMindMap={onGenerateMindMap}
            />
          )}
          {chatId && role !== "user" && !isEditing && (
            <FeedbackButton
              isSelected={selectedFeedback === true}
              handleFeedback={() => handleFeedback(true)}
              tooltipId="feedback-button"
              tooltipContent={t("chat_window.good_response")}
              IconComponent={ThumbsUp}
            />
          )}
          <ActionMenu
            chatId={chatId}
            publicChatId={publicChatId}
            forkThread={forkThread}
            isEditing={isEditing}
            role={role}
          />
        </div>
      </div>
      <RenderMetrics metrics={metrics} />
    </div>
  );
};

function FeedbackButton({
  isSelected,
  handleFeedback,
  tooltipContent,
  IconComponent,
}) {
  return (
    <div className="mt-3 relative">
      <button
        onClick={handleFeedback}
        data-tooltip-id="feedback-button"
        data-tooltip-content={tooltipContent}
        className="text-zinc-300 light:text-slate-500"
        aria-label={tooltipContent}
      >
        <IconComponent
          size={20}
          className="mb-1"
          weight={isSelected ? "fill" : "regular"}
        />
      </button>
    </div>
  );
}

function MindMapButton({ message, chatId, onGenerateMindMap }) {
  if (!onGenerateMindMap || !message) return null;
  return (
    <div className="mt-3 relative">
      <button
        onClick={() =>
          onGenerateMindMap({
            sourceType: "chat",
            chatId,
            selectedText: selectedTextWithinMessage(message),
          })
        }
        data-tooltip-id="generate-mind-map"
        data-tooltip-content="生成思维导图"
        className="text-zinc-300 light:text-slate-500"
        aria-label="生成思维导图"
      >
        <GitFork size={20} className="mb-1" />
      </button>
    </div>
  );
}

function selectedTextWithinMessage(message = "") {
  const selected = window.getSelection?.().toString?.().trim?.() || "";
  if (!selected) return "";
  return message.includes(selected) ? selected : "";
}

function CopyMessage({ message }) {
  const { copied, copyText } = useCopyText();
  const { t } = useTranslation();

  return (
    <>
      <div className="mt-3 relative">
        <button
          onClick={() => copyText(message)}
          data-tooltip-id="copy-assistant-text"
          data-tooltip-content={t("chat_window.copy")}
          className="text-zinc-300 light:text-slate-500"
          aria-label={t("chat_window.copy")}
        >
          {copied ? (
            <Check size={20} className="mb-1" />
          ) : (
            <Copy size={20} className="mb-1" />
          )}
        </button>
      </div>
    </>
  );
}

function RegenerateMessage({ regenerateMessage, chatId, publicChatId = null }) {
  const { t } = useTranslation();
  if (!chatId) return null;
  return (
    <div className="mt-3 relative">
      <button
        onClick={() => regenerateMessage(chatId, publicChatId)}
        data-tooltip-id="regenerate-assistant-text"
        data-tooltip-content={t("chat_window.regenerate_response")}
        className="border-none text-zinc-300 light:text-slate-500"
        aria-label={t("chat_window.regenerate")}
      >
        <ArrowsClockwise size={20} className="mb-1" weight="fill" />
      </button>
    </div>
  );
}

export default memo(Actions);
