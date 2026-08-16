import { memo, useEffect, useMemo, useState } from "react";
import { renderAssistantMarkdown } from "@/utils/chat/markdown";
import DOMPurify from "@/utils/chat/purify";
import { runIdleTask } from "@/utils/chat/idleChunk";
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
  // Render every streamed revision through the same sanitized Markdown -> HTML
  // pipeline as the final message. Markdown-it tolerates incomplete blocks, so
  // headings, lists, code and tables can progressively take shape without ever
  // exposing raw provider HTML.
  const html = useMemo(
    () =>
      enhanced ? DOMPurify.sanitize(renderAssistantMarkdown(markdown)) : null,
    [enhanced, markdown]
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
      {markdown && enhanced && (
        <div
          className="break-words flex flex-col gap-y-1 text-white light:text-slate-900"
          dangerouslySetInnerHTML={{
            __html: html,
          }}
        />
      )}
      {markdown && !enhanced && (
        <div className="whitespace-pre-wrap break-words text-white light:text-slate-900">
          {markdown}
        </div>
      )}
    </div>
  );
}

export default memo(MarkdownOutput);
