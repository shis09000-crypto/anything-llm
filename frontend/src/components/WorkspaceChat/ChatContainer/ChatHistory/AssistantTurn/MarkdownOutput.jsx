import { memo, useEffect, useMemo } from "react";
import StreamingMarkdown from "@/components/Markdown/StreamingMarkdown";
import {
  THOUGHT_REGEX_CLOSE,
  THOUGHT_REGEX_COMPLETE,
  THOUGHT_REGEX_OPEN,
  ThoughtChainComponent,
} from "../ThoughtContainer";

function splitThoughtContent(message = "") {
  if (!message) return { thoughtChain: null, markdown: "" };

  if (
    message.match(THOUGHT_REGEX_OPEN) &&
    !message.match(THOUGHT_REGEX_CLOSE)
  ) {
    return { thoughtChain: message, markdown: "" };
  }

  const completeThoughtChain = message.match(THOUGHT_REGEX_COMPLETE)?.[0];
  if (completeThoughtChain) {
    return {
      thoughtChain: completeThoughtChain,
      markdown: message.replace(THOUGHT_REGEX_COMPLETE, ""),
    };
  }

  return { thoughtChain: null, markdown: message };
}

function MarkdownOutput({
  content = "",
  messageId,
  isStreaming = false,
  onLayoutChange = null,
}) {
  const { thoughtChain, markdown } = useMemo(
    () => splitThoughtContent(content),
    [content]
  );
  useEffect(() => {
    if (!content || typeof onLayoutChange !== "function") return;

    const frame = requestAnimationFrame(() =>
      onLayoutChange("markdown-rendered")
    );
    return () => cancelAnimationFrame(frame);
  }, [content, onLayoutChange]);

  if (!content) return null;

  return (
    <div className="flex flex-col gap-y-1">
      {thoughtChain && (
        <ThoughtChainComponent content={thoughtChain} messageId={messageId} />
      )}
      {markdown && (
        <StreamingMarkdown
          content={markdown}
          isStreaming={isStreaming}
          onRender={onLayoutChange}
          className="markdown break-words flex flex-col gap-y-1 text-white light:text-slate-900"
        />
      )}
    </div>
  );
}

export default memo(MarkdownOutput);
