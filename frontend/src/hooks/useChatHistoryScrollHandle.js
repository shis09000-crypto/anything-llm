import { useImperativeHandle } from "react";

/**
 * Exposes scroll control methods (scrollToTop, scrollToBottom) via a forwarded ref.
 * This allows parent components to programmatically scroll the chat history.
 *
 * @param {React.Ref} ref - The forwarded ref from the parent component
 * @param {Object} options - Configuration options
 * @param {Function} options.setIsUserScrolling - Setter to mark user-initiated scrolling
 * @param {boolean} options.isStreaming - Whether chat is currently streaming a response
 * @param {Function} options.scrollToBottom - Internal scroll to bottom function
 * @param {Function} options.scrollToTop - Internal scroll to top function
 * @param {Function} options.beginLayoutTransition - Capture current anchor before layout changes
 */
export default function useChatHistoryScrollHandle(
  ref,
  {
    setIsUserScrolling,
    isStreaming,
    scrollToBottom,
    scrollToTop,
    beginLayoutTransition = null,
  }
) {
  useImperativeHandle(
    ref,
    () => ({
      scrollToTop() {
        setIsUserScrolling(true);
        scrollToTop(true);
      },
      scrollToBottom() {
        setIsUserScrolling(false);
        scrollToBottom(isStreaming ? false : true, {
          reason: "imperative-bottom",
          resetSavedPosition: true,
        });
      },
      beginLayoutTransition(signal = {}) {
        beginLayoutTransition?.(signal);
      },
    }),
    [
      beginLayoutTransition,
      isStreaming,
      scrollToBottom,
      scrollToTop,
      setIsUserScrolling,
    ]
  );
}
