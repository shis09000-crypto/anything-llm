import { memo, useEffect, useMemo, useState } from "react";
import { runIdleTask } from "@/utils/chat/idleChunk";
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

function hasHeavyMarkdown(content = "") {
  return /```|\|.+\||<table|!\[/.test(content);
}

function MarkdownOutput({
  content = "",
  messageId,
  isStreaming = false,
  deferEnhancement = false,
  onLayoutChange = null,
}) {
  const shouldDefer =
    !isStreaming && deferEnhancement && hasHeavyMarkdown(content);
  const [enhanced, setEnhanced] = useState(!shouldDefer);
  useEffect(() => {
    if (!shouldDefer) {
      setEnhanced(true);
      return;
    }
    setEnhanced(false);
    return runIdleTask(() => setEnhanced(true), { timeout: 900 });
  }, [content, shouldDefer]);

  const { thoughtChain, markdown } = useMemo(
    () => splitThoughtContent(content),
    [content]
  );
  useEffect(() => {
    if (!content || typeof onLayoutChange !== "function") return;

    const frame = requestAnimationFrame(() =>
      onLayoutChange(enhanced ? "markdown-enhanced" : "markdown-plain")
    );
    return () => cancelAnimationFrame(frame);
  }, [content, enhanced, onLayoutChange]);

  if (!content) return null;

  return (
    <div className="flex flex-col gap-y-1">
      {thoughtChain && (
        <ThoughtChainComponent content={thoughtChain} messageId={messageId} />
      )}
      {markdown && (isStreaming || enhanced) && (
        <StreamingMarkdown
          content={markdown}
          isStreaming={isStreaming}
          onRender={onLayoutChange}
          className="markdown break-words flex flex-col gap-y-1 text-white light:text-slate-900"
        />
      )}
      {markdown && !isStreaming && !enhanced && (
        <div className="whitespace-pre-wrap break-words text-white light:text-slate-900">
          {markdown}
        </div>
      )}
    </div>
  );
}

export default memo(MarkdownOutput);
