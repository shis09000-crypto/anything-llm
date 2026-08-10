import { memo, useEffect, useMemo, useRef, useState } from "react";
import renderMarkdown from "@/utils/chat/markdown";
import DOMPurify from "@/utils/chat/purify";
import { renderStreamingMarkdownSegments } from "@/utils/chat/streamingMarkdown";

const EMPTY_SEGMENTS = Object.freeze({ stableHtml: "", liveHtml: "" });

function StreamingMarkdown({
  content = "",
  isStreaming = false,
  className = "",
  onRender = null,
}) {
  const latestContent = useRef(content);
  const scheduledFrame = useRef(null);
  const scheduledTimer = useRef(null);
  const lastRenderedAt = useRef(0);
  const [segments, setSegments] = useState(() =>
    isStreaming ? renderStreamingMarkdownSegments(content) : EMPTY_SEGMENTS
  );

  useEffect(() => {
    latestContent.current = content;
  }, [content]);
  const finalHtml = useMemo(
    () =>
      isStreaming ? null : DOMPurify.sanitize(renderMarkdown(content || "")),
    [content, isStreaming]
  );

  useEffect(() => {
    if (!isStreaming) {
      if (scheduledTimer.current) clearTimeout(scheduledTimer.current);
      if (scheduledFrame.current) cancelAnimationFrame(scheduledFrame.current);
      scheduledTimer.current = null;
      scheduledFrame.current = null;
      return;
    }
    if (scheduledTimer.current || scheduledFrame.current) return;
    const elapsed = performance.now() - lastRenderedAt.current;
    const waitMs = Math.max(0, 50 - elapsed);
    scheduledTimer.current = setTimeout(() => {
      scheduledTimer.current = null;
      scheduledFrame.current = requestAnimationFrame(() => {
        scheduledFrame.current = null;
        lastRenderedAt.current = performance.now();
        setSegments(renderStreamingMarkdownSegments(latestContent.current));
        onRender?.("streaming-markdown");
      });
    }, waitMs);
  }, [content, isStreaming, onRender]);

  useEffect(
    () => () => {
      if (scheduledTimer.current) clearTimeout(scheduledTimer.current);
      if (scheduledFrame.current) cancelAnimationFrame(scheduledFrame.current);
    },
    []
  );

  if (!content) return null;
  if (!isStreaming)
    return (
      <div
        className={className}
        dangerouslySetInnerHTML={{ __html: finalHtml }}
      />
    );

  return (
    <div className={className} aria-live="polite">
      {segments.stableHtml && (
        <div dangerouslySetInnerHTML={{ __html: segments.stableHtml }} />
      )}
      {segments.liveHtml && (
        <div dangerouslySetInnerHTML={{ __html: segments.liveHtml }} />
      )}
    </div>
  );
}

export default memo(StreamingMarkdown);
