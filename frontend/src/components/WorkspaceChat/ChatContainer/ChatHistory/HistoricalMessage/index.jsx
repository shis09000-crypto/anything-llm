import React, {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Info, Warning } from "@phosphor-icons/react";
import Actions from "./Actions";
import renderMarkdown from "@/utils/chat/markdown";
import Citations from "../Citation";
import { v4 } from "uuid";
import DOMPurify from "@/utils/chat/purify";
import { EditMessageForm, useEditMessage } from "./Actions/EditMessage";
import { useWatchDeleteMessage } from "./Actions/DeleteMessage";
import TTSMessage from "./Actions/TTSButton";
import {
  THOUGHT_REGEX_CLOSE,
  THOUGHT_REGEX_COMPLETE,
  THOUGHT_REGEX_OPEN,
  ThoughtChainComponent,
  useThoughtExpansion,
} from "../ThoughtContainer";
import paths from "@/utils/paths";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { chatQueryRefusalResponse } from "@/utils/chat";
import HistoricalOutputs from "./HistoricalOutputs";
import HistoricalClarifyingQuestions from "./HistoricalClarifyingQuestions";
import { openImageLightbox } from "@/components/ImageLightbox";
import ReaderTextSourceCards, {
  readerSourcesForTurn,
} from "../../DocumentReader/ReaderTextSourceCards";
import { useDocumentReader } from "../../DocumentReader/Provider";
import { debugChatTurn } from "@/utils/chat/debug";
import { GlassCard } from "@developer-hub/liquid-glass";

const USER_MESSAGE_GLASS_MOUSE_OFFSET = { x: 0, y: 0 };
const USER_MESSAGE_GLASS_STYLE = {
  "--user-message-glass-tint-light": "rgb(255 255 255 / 0.2)",
  "--user-message-glass-tint-dark": "rgb(15 23 42 / 0.165)",
  "--user-message-glass-shadow": "0 12px 26px rgb(15 23 42 / 0.17)",
  "--user-message-glass-backdrop-blur": "2.2px",
  "--user-message-glass-radius": "15px",
  "--user-message-glass-text-alpha": 0.94,
};

const HistoricalMessage = ({
  uuid: uuidProp,
  message,
  role,
  workspace,
  chatKey = null,
  turnId = null,
  sources = [],
  attachments = [],
  readerTextSources = [],
  error = false,
  feedbackScore = null,
  chatId = null,
  publicChatId = null,
  isLastMessage = false,
  regenerateMessage,
  saveEditedMessage,
  forkThread,
  metrics = {},
  outputs = [],
  clarifyingQuestions = [],
  hydrationStatus = null,
  readOnly = false,
  onContentLayoutChange = null,
}) => {
  // Freeze uuid on first render. User messages arrive without a uuid and this value
  // is used as the wrapper div's `key` — a default param fallback would regenerate
  // on every render and remount the subtree, wiping TruncatableContent state.
  const [uuid] = useState(() => uuidProp ?? v4());
  const { t } = useTranslation();
  const readerContext = useDocumentReader();
  const { isEditing } = useEditMessage({ chatId, role });
  const { isDeleted, completeDelete, onEndAnimation } = useWatchDeleteMessage({
    chatId,
    publicChatId,
    role,
  });
  const adjustTextArea = (event) => {
    const element = event.target;
    element.style.height = "auto";
    element.style.height = element.scrollHeight + "px";
  };

  const isRefusalMessage =
    role === "assistant" && message === chatQueryRefusalResponse(workspace);
  const documentReaderTextSources =
    readerTextSources.length > 0
      ? readerTextSources
      : readerSourcesForTurn(readerContext?.sourcesByTurn, chatKey, {
          turnId,
          chatId,
        });

  if (completeDelete) return null;

  if (!!error) {
    return (
      <div key={uuid} className="flex justify-start w-full">
        <div className="py-4 pl-0 pr-4 flex flex-col md:max-w-[80%]">
          <div className="p-2 rounded-lg bg-red-50 text-red-500">
            <span className="inline-block">
              <Warning className="h-4 w-4 mb-1 inline-block" /> Could not
              respond to message.
            </span>
            <p className="text-xs font-mono mt-2 border-l-2 border-red-300 pl-2 bg-red-200 p-2 rounded-sm">
              {error}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (role === "user") {
    if (isEditing && !readOnly) {
      return (
        <div key={uuid} className="flex justify-end w-full py-4 px-4">
          <EditMessageForm
            role={role}
            chatId={chatId}
            publicChatId={publicChatId}
            message={message}
            attachments={attachments}
            adjustTextArea={adjustTextArea}
            saveChanges={saveEditedMessage}
          />
        </div>
      );
    }

    return (
      <div
        key={uuid}
        onAnimationEnd={onEndAnimation}
        className={`${isDeleted ? "animate-remove" : ""} flex justify-end w-full group`}
      >
        <div className="py-4 px-4 flex flex-col items-end">
          <GlassCard
            className="liquid-glass-user-message-bubble pointer-events-auto relative z-10"
            displacementScale={35}
            blurAmount={0}
            cornerRadius={15}
            padding="0px"
            shadowMode={false}
            mouseOffset={USER_MESSAGE_GLASS_MOUSE_OFFSET}
            style={USER_MESSAGE_GLASS_STYLE}
          >
            <div className="liquid-glass-user-message-content px-4 py-3.5 [&_p]:m-0">
              <TruncatableContent
                stateId={`${uuid}:truncatable`}
                messageId={uuid}
                onContentLayoutChange={onContentLayoutChange}
              >
                <ReaderTextSourceCards
                  sources={documentReaderTextSources}
                  className="mb-3 max-w-[540px]"
                  itemClassName="bg-white/95 light:bg-white"
                />
                <RenderChatContent
                  role={role}
                  message={message}
                  messageId={uuid}
                  onContentLayoutChange={onContentLayoutChange}
                />
                <ChatAttachments attachments={attachments} />
              </TruncatableContent>
            </div>
          </GlassCard>
          {!readOnly && (
            <Actions
              message={message}
              feedbackScore={feedbackScore}
              chatId={chatId}
              publicChatId={publicChatId}
              slug={workspace?.slug}
              isLastMessage={isLastMessage}
              regenerateMessage={regenerateMessage}
              isEditing={isEditing}
              role={role}
              forkThread={forkThread}
              metrics={metrics}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      key={uuid}
      onAnimationEnd={onEndAnimation}
      className={`${isDeleted ? "animate-remove" : ""} flex justify-start w-full group`}
    >
      <div className="py-4 px-4 md:pl-0 flex flex-col w-full">
        {isEditing && !readOnly ? (
          <EditMessageForm
            role={role}
            chatId={chatId}
            publicChatId={publicChatId}
            message={message}
            attachments={attachments}
            adjustTextArea={adjustTextArea}
            saveChanges={saveEditedMessage}
          />
        ) : (
          <div className="break-words">
            <RenderChatContent
              role={role}
              message={message}
              messageId={uuid}
              onContentLayoutChange={onContentLayoutChange}
            />
            {isRefusalMessage && (
              <Link
                data-tooltip-id="query-refusal-info"
                data-tooltip-content={`${t("chat.refusal.tooltip-description")}`}
                className="!no-underline group !flex w-fit"
                to={paths.chatModes()}
                target="_blank"
              >
                <div className="flex flex-row items-center gap-x-1 group-hover:opacity-100 opacity-60 w-fit">
                  <Info className="text-theme-text-secondary" />
                  <p className="!m-0 !p-0 text-theme-text-secondary !no-underline text-xs cursor-pointer">
                    {t("chat.refusal.tooltip-title")}
                  </p>
                </div>
              </Link>
            )}
            <ChatAttachments attachments={attachments} />
            {hydrationStatus === "light" && (
              <div className="mt-3 space-y-2" aria-hidden="true">
                <div className="motion-skeleton h-3 w-1/2 rounded" />
                <div className="motion-skeleton h-3 w-1/3 rounded" />
              </div>
            )}
            <HistoricalOutputs outputs={outputs} workspace={workspace} />
            <HistoricalClarifyingQuestions surveys={clarifyingQuestions} />
          </div>
        )}
        {!readOnly && (
          <div className="flex items-start gap-x-1">
            <TTSMessage
              slug={workspace?.slug}
              chatId={chatId}
              publicChatId={publicChatId}
              message={message}
            />
            <Actions
              message={message}
              feedbackScore={feedbackScore}
              chatId={chatId}
              publicChatId={publicChatId}
              slug={workspace?.slug}
              isLastMessage={isLastMessage}
              regenerateMessage={regenerateMessage}
              isEditing={isEditing}
              role={role}
              forkThread={forkThread}
              metrics={metrics}
            />
          </div>
        )}
        {role === "assistant" && <Citations sources={sources} />}
      </div>
    </div>
  );
};

export default memo(
  HistoricalMessage,
  // Skip re-render the historical message:
  // - if the content is the exact same
  // - AND (not streaming)
  // - the lastMessage status is the same (regen icon)
  // - the chatID matches between renders. (feedback icons)
  // - the metrics are the same (metrics are updated in real time)
  (prevProps, nextProps) => {
    return (
      prevProps.message === nextProps.message &&
      prevProps.isLastMessage === nextProps.isLastMessage &&
      prevProps.chatId === nextProps.chatId &&
      prevProps.publicChatId === nextProps.publicChatId &&
      JSON.stringify(prevProps.metrics) === JSON.stringify(nextProps.metrics) &&
      JSON.stringify(prevProps.sources) === JSON.stringify(nextProps.sources) &&
      JSON.stringify(prevProps.readerTextSources) ===
        JSON.stringify(nextProps.readerTextSources) &&
      JSON.stringify(prevProps.clarifyingQuestions) ===
        JSON.stringify(nextProps.clarifyingQuestions) &&
      prevProps.hydrationStatus === nextProps.hydrationStatus &&
      prevProps.readOnly === nextProps.readOnly
    );
  }
);

/**
 * Currently only renders image attachments as clickable thumbnails that open in the lightbox.
 * Other attachment types may be supported here in the future.
 */
function ChatAttachments({ attachments = [] }) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-4 mt-4">
      {attachments.map((item, index) => (
        <button
          type="button"
          key={item.name}
          onClick={() => openImageLightbox(attachments, index)}
          className="p-0 border-none bg-transparent cursor-pointer hover:opacity-80 motion-hover"
        >
          <img
            alt={`Attachment: ${item.name}`}
            src={item.contentString}
            className="w-[120px] h-[120px] object-cover rounded-lg"
          />
        </button>
      ))}
    </div>
  );
}

function TruncatableContent({
  children,
  stateId = null,
  messageId,
  onContentLayoutChange = null,
}) {
  const contentRef = useRef(null);
  const { expanded: persistedExpanded, setExpanded: setPersistedExpanded } =
    useThoughtExpansion(stateId);
  const [localExpanded, setLocalExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const initialLayoutRef = useRef(true);
  const { t } = useTranslation();
  const isExpanded = stateId ? persistedExpanded : localExpanded;
  const setIsExpanded = stateId ? setPersistedExpanded : setLocalExpanded;

  // useLayoutEffect (not useEffect) so collapse applies before paint — avoids a
  // one-frame flash of uncollapsed content on mount.
  useLayoutEffect(() => {
    if (contentRef.current) {
      setIsOverflowing(contentRef.current.scrollHeight > 250);
    }
  }, []);

  useEffect(() => {
    if (initialLayoutRef.current) {
      initialLayoutRef.current = false;
      return;
    }

    onContentLayoutChange?.("truncatable-content-toggle");
    debugChatTurn("TruncatableContent:layoutChange", {
      messageId,
      stateId,
      isExpanded,
      isOverflowing,
    });
  }, [isExpanded, isOverflowing, messageId, onContentLayoutChange, stateId]);

  const showTruncation = !isExpanded && isOverflowing;

  return (
    <>
      <div className="relative">
        <div
          ref={contentRef}
          className={showTruncation ? "max-h-[250px] overflow-hidden" : ""}
        >
          {children}
        </div>
        {showTruncation && (
          <>
            <div
              className="absolute bottom-0 left-0 right-0 h-[36px] light:hidden pointer-events-none"
              style={{
                background:
                  "linear-gradient(180deg, rgb(15 23 42 / 0) 0%, rgb(15 23 42 / 0.36) 54%, rgb(15 23 42 / 0.58) 100%)",
              }}
            />
            <div
              className="absolute bottom-0 left-0 right-0 h-[36px] hidden light:block pointer-events-none"
              style={{
                background:
                  "linear-gradient(180deg, rgb(255 255 255 / 0) 0%, rgb(255 255 255 / 0.44) 54%, rgb(255 255 255 / 0.68) 100%)",
              }}
            />
          </>
        )}
      </div>
      {isOverflowing && (
        <button
          onClick={() => {
            debugChatTurn("TruncatableContent:toggle", {
              messageId,
              stateId,
              nextExpanded: !isExpanded,
            });
            setIsExpanded(!isExpanded);
          }}
          className="text-zinc-300 light:text-slate-700 hover:text-white light:hover:text-slate-900 text-xs font-medium leading-4 mt-2"
        >
          {isExpanded ? t("chat_window.see_less") : t("chat_window.see_more")}
        </button>
      )}
    </>
  );
}

const RenderChatContent = memo(
  ({ role, message, messageId, onContentLayoutChange = null }) => {
    // If the message is not from the assistant, we can render it directly
    // as normal since the user cannot think (lol)
    if (role !== "assistant")
      return (
        <div
          className="flex flex-col gap-y-1 text-white light:text-slate-900"
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(renderMarkdown(message)),
          }}
        />
      );
    let thoughtChain = null;
    let msgToRender = message;
    if (!message) return null;

    // If the message is a perfect thought chain, we can render it directly
    // Complete == open and close tags match perfectly.
    if (message.match(THOUGHT_REGEX_COMPLETE)) {
      thoughtChain = message.match(THOUGHT_REGEX_COMPLETE)?.[0];
      msgToRender = message.replace(THOUGHT_REGEX_COMPLETE, "");
    }

    // If the message is a thought chain but not a complete thought chain (matching opening tags but not closing tags),
    // we can render it as a thought chain if we can at least find a closing tag
    // This can occur when the assistant starts with <thinking> and then <response>'s later.
    if (
      message.match(THOUGHT_REGEX_OPEN) &&
      !message.match(THOUGHT_REGEX_CLOSE)
    ) {
      thoughtChain = message;
      msgToRender = "";
    }

    return (
      <>
        {thoughtChain && (
          <ThoughtChainComponent
            content={thoughtChain}
            messageId={messageId}
            onContentLayoutChange={onContentLayoutChange}
          />
        )}
        <div
          className="flex flex-col gap-y-1 text-white light:text-slate-900"
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(renderMarkdown(msgToRender)),
          }}
        />
      </>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.role === nextProps.role &&
      prevProps.message === nextProps.message &&
      prevProps.messageId === nextProps.messageId
    );
  }
);
