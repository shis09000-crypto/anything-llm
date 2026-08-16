import {
  useState,
  useEffect,
  forwardRef,
  useImperativeHandle,
  createContext,
  useContext,
  useCallback,
  useRef,
} from "react";
import renderMarkdown from "@/utils/chat/markdown";
import { CaretDown } from "@phosphor-icons/react";
import DOMPurify from "dompurify";
import ThinkingAnimation from "@/media/animations/thinking-animation.webm";
import ThinkingStatic from "@/media/animations/thinking-static.png";
import {
  readChatFoldStates,
  writeChatFoldState,
} from "@/utils/chat/chatScrollMemory";
import { debugChatTurn } from "@/utils/chat/debug";
import { mobileShellRuntimeActive } from "@/utils/mobileRuntime";
import { useTranslation } from "react-i18next";

/**
 * Context to persist thought expansion state across component transitions
 * (e.g., from PromptReply to HistoricalMessage)
 */
const ThoughtExpansionContext = createContext(null);

export function ThoughtExpansionProvider({ chatKey = null, children }) {
  const [expansionStates, setExpansionStates] = useState(() =>
    readChatFoldStates(chatKey)
  );

  useEffect(() => {
    setExpansionStates(readChatFoldStates(chatKey));
  }, [chatKey]);

  const getExpanded = useCallback(
    (messageId) => {
      if (!messageId) return false;
      return expansionStates[messageId] ?? false;
    },
    [expansionStates]
  );

  const setExpanded = useCallback(
    (messageId, expanded) => {
      if (!messageId) return;
      setExpansionStates((prev) => {
        const next = {
          ...prev,
          [messageId]: expanded,
        };
        writeChatFoldState(chatKey, messageId, expanded);
        return next;
      });
    },
    [chatKey]
  );

  return (
    <ThoughtExpansionContext.Provider value={{ getExpanded, setExpanded }}>
      {children}
    </ThoughtExpansionContext.Provider>
  );
}

export function useThoughtExpansion(messageId) {
  const context = useContext(ThoughtExpansionContext);
  if (!context) {
    // Fallback when used outside provider - use local state only
    return { expanded: false, setExpanded: () => {} };
  }
  return {
    expanded: context.getExpanded(messageId),
    setExpanded: (value) => context.setExpanded(messageId, value),
  };
}

const THOUGHT_KEYWORDS = ["thought", "thinking", "think", "thought_chain"];
const CLOSING_TAGS = [...THOUGHT_KEYWORDS, "response", "answer"];
export const THOUGHT_REGEX_OPEN = new RegExp(
  THOUGHT_KEYWORDS.map((keyword) => `<${keyword}\\s*(?:[^>]*?)?\\s*>`).join("|")
);
export const THOUGHT_REGEX_CLOSE = new RegExp(
  CLOSING_TAGS.map((keyword) => `</${keyword}\\s*(?:[^>]*?)?>`).join("|")
);
export const THOUGHT_REGEX_COMPLETE = new RegExp(
  THOUGHT_KEYWORDS.map(
    (keyword) =>
      `<${keyword}\\s*(?:[^>]*?)?\\s*>[\\s\\S]*?<\\/${keyword}\\s*(?:[^>]*?)?>`
  ).join("|")
);
const THOUGHT_PREVIEW_LENGTH = mobileShellRuntimeActive() ? 25 : 50;

/**
 * Checks if the content has readable content.
 * @param {string} content - The content to check.
 * @returns {boolean} - Whether the content has readable content.
 */
function contentIsNotEmpty(content = "") {
  return (
    content
      ?.trim()
      ?.replace(THOUGHT_REGEX_OPEN, "")
      ?.replace(THOUGHT_REGEX_CLOSE, "")
      ?.replace(/[\n\s]/g, "")?.length > 0
  );
}

/**
 * Component to render a thought chain.
 * @param {string} content - The content of the thought chain.
 * @param {string} messageId - The unique ID for this message (used to persist expansion state).
 * @returns {JSX.Element}
 */
export const ThoughtChainComponent = forwardRef(
  (
    { content: initialContent, messageId, onContentLayoutChange = null },
    ref
  ) => {
    const { t } = useTranslation();
    const [content, setContent] = useState(initialContent);
    const [hasReadableContent, setHasReadableContent] = useState(
      contentIsNotEmpty(initialContent)
    );
    const initialLayoutRef = useRef(true);
    const { expanded: persistedExpanded, setExpanded: setPersistedExpanded } =
      useThoughtExpansion(messageId);
    const [localExpanded, setLocalExpanded] = useState(false);

    // Use persisted state if messageId is provided, otherwise use local state
    const isExpanded = messageId ? persistedExpanded : localExpanded;
    const setIsExpanded = messageId ? setPersistedExpanded : setLocalExpanded;

    // Sync content state with prop changes (for streaming through HistoricalMessage)
    useEffect(() => {
      if (initialContent !== content) {
        setContent(initialContent);
        setHasReadableContent(contentIsNotEmpty(initialContent));
      }
    }, [initialContent]);

    useImperativeHandle(ref, () => ({
      updateContent: (newContent) => {
        setContent(newContent);
        setHasReadableContent(contentIsNotEmpty(newContent));
      },
    }));

    const isThinking =
      content.match(THOUGHT_REGEX_OPEN) && !content.match(THOUGHT_REGEX_CLOSE);
    const isComplete =
      content.match(THOUGHT_REGEX_COMPLETE) ||
      content.match(THOUGHT_REGEX_CLOSE);
    const tagStrippedContent = content
      .replace(THOUGHT_REGEX_OPEN, "")
      .replace(THOUGHT_REGEX_CLOSE, "");
    const canExpand = tagStrippedContent.length > THOUGHT_PREVIEW_LENGTH;

    useEffect(() => {
      if (initialLayoutRef.current) {
        initialLayoutRef.current = false;
        return;
      }

      onContentLayoutChange?.("thoughtchain-layout");
      debugChatTurn("ThoughtChain:layoutChange", {
        messageId,
        isExpanded,
        canExpand,
      });
    }, [isExpanded, canExpand, messageId, onContentLayoutChange]);

    if (!content || !content.length || !hasReadableContent) return null;

    function handleExpandClick() {
      if (!canExpand) return;
      setIsExpanded(!isExpanded);
    }

    return (
      <div className="flex justify-center w-full">
        <div className="w-full flex flex-col">
          <div className="w-full">
            <div
              style={{
                transition: "all 0.1s",
                borderRadius: "16px",
              }}
              className="relative bg-zinc-800 light:bg-slate-100 p-4"
            >
              <div className="absolute top-4 left-4 w-[18px] h-[18px]">
                {isThinking || isComplete ? (
                  <>
                    <video
                      autoPlay
                      loop
                      muted
                      playsInline
                      className={`w-[18px] h-[18px] scale-[115%] motion-hover light:invert light:opacity-50 ${isThinking ? "opacity-100" : "opacity-0 hidden"}`}
                      data-tooltip-id="cot-thinking"
                      data-tooltip-content={t(
                        "chat_window.toolTimeline.modelThinking"
                      )}
                      aria-label={t("chat_window.toolTimeline.modelThinking")}
                    >
                      <source src={ThinkingAnimation} type="video/webm" />
                    </video>
                    <img
                      src={ThinkingStatic}
                      alt={t("chat_window.toolTimeline.modelComplete")}
                      className={`w-[18px] h-[18px] motion-hover light:invert light:opacity-50 ${!isThinking && isComplete ? "opacity-100" : "opacity-0 hidden"}`}
                      data-tooltip-id="cot-thinking"
                      data-tooltip-content={t(
                        "chat_window.toolTimeline.modelComplete"
                      )}
                      aria-label={t("chat_window.toolTimeline.modelComplete")}
                    />
                  </>
                ) : null}
              </div>
              {canExpand && (
                <button
                  onClick={handleExpandClick}
                  className="absolute top-4 right-4 border-none text-zinc-200 light:text-slate-800 motion-hover"
                  data-tooltip-id="expand-cot"
                  data-tooltip-content={
                    isExpanded
                      ? t("chat_window.toolTimeline.hideThoughtChain")
                      : t("chat_window.toolTimeline.showThoughtChain")
                  }
                  aria-label={
                    isExpanded
                      ? t("chat_window.toolTimeline.hideThoughtChain")
                      : t("chat_window.toolTimeline.showThoughtChain")
                  }
                >
                  <CaretDown
                    className={`w-4 h-4 transform motion-hover ${isExpanded ? "rotate-180" : ""}`}
                  />
                </button>
              )}
              <div
                className={`ml-[28px] mr-[26px] transition-[max-height] origin-top ${isExpanded ? "" : "overflow-hidden max-h-[18px]"}`}
              >
                <div className="text-zinc-200 light:text-slate-800 font-mono text-sm leading-[18px] [&_p]:m-0">
                  <span
                    className={`block w-full ${!isExpanded ? "truncate" : ""}`}
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(
                        isExpanded
                          ? renderMarkdown(tagStrippedContent)
                          : tagStrippedContent
                      ),
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
ThoughtChainComponent.displayName = "ThoughtChainComponent";
