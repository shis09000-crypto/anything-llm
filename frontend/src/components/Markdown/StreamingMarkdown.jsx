import { memo, useCallback, useEffect, useRef, useState } from "react";
import renderMarkdown from "@/utils/chat/markdown";
import DOMPurify from "@/utils/chat/purify";
import { runIdleTask } from "@/utils/chat/idleChunk";
import {
  renderStreamingMarkdown,
  renderStreamingMarkdownInline,
} from "@/utils/chat/streamingMarkdown";
import {
  advanceStreamingMarkdownProjection,
  streamingCodeProjection,
  streamingListProjection,
  streamingTableProjection,
} from "@/utils/chat/streamingMarkdownProjection";

function initialView(content = "") {
  const projection = advanceStreamingMarkdownProjection({}, content);
  return {
    projection,
    stableParts: projection.appendedStable.map((part) => ({
      id: `markdown:${part.start}:${part.end}`,
      html: renderStreamingMarkdown(part.content),
    })),
    live: projection.live,
  };
}

const StreamingTableCell = memo(function StreamingTableCell({
  cell,
  header = false,
}) {
  const Tag = header ? "th" : "td";
  return (
    <Tag
      dangerouslySetInnerHTML={{
        __html: renderStreamingMarkdownInline(cell),
      }}
    />
  );
});

const StreamingListItem = memo(function StreamingListItem({ item }) {
  return (
    <li
      dangerouslySetInnerHTML={{
        __html: renderStreamingMarkdownInline(item),
      }}
    />
  );
});

function StreamingTable({ projection }) {
  const rows = projection.pending
    ? [...projection.rows, projection.pending]
    : projection.rows;
  return (
    <div className="overflow-x-auto">
      <table>
        <thead>
          <tr>
            {projection.headers.map((cell, index) => (
              <StreamingTableCell key={`header:${index}`} cell={cell} header />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`row:${rowIndex}:${row.join("|")}`}>
              {row.map((cell, cellIndex) => (
                <StreamingTableCell key={`cell:${cellIndex}`} cell={cell} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StreamingList({ projection }) {
  const Tag = projection.ordered ? "ol" : "ul";
  const items = projection.pending
    ? [...projection.items, projection.pending]
    : projection.items;
  return (
    <Tag>
      {items.map((item, index) => (
        <StreamingListItem key={`item:${index}:${item}`} item={item} />
      ))}
    </Tag>
  );
}

function LiveMarkdownBlock({ content = "" }) {
  const table = streamingTableProjection(content);
  if (table) return <StreamingTable projection={table} />;
  const list = streamingListProjection(content);
  if (list) return <StreamingList projection={list} />;
  const code = streamingCodeProjection(content);
  if (code) {
    return (
      <div className="streaming-code-block">
        {code.language && (
          <div className="streaming-code-language">{code.language}</div>
        )}
        <pre className="whitespace-pre-wrap">
          <code>{code.code}</code>
        </pre>
      </div>
    );
  }
  if (!content) return null;
  return (
    <div
      dangerouslySetInnerHTML={{ __html: renderStreamingMarkdown(content) }}
    />
  );
}

function StreamingMarkdown({
  content = "",
  isStreaming = false,
  className = "",
  onRender = null,
}) {
  const latestContent = useRef(content);
  const scheduledFrame = useRef(null);
  const scheduledTimer = useRef(null);
  const layoutFrame = useRef(null);
  const lastRenderedAt = useRef(0);
  const [view, setView] = useState(() => initialView(content));
  const viewRef = useRef(view);
  const [finalHtml, setFinalHtml] = useState(() =>
    isStreaming ? null : DOMPurify.sanitize(renderMarkdown(content || ""))
  );

  const notifyRender = useCallback(
    (reason) => {
      if (layoutFrame.current) return;
      layoutFrame.current = requestAnimationFrame(() => {
        layoutFrame.current = null;
        onRender?.(reason);
      });
    },
    [onRender]
  );

  const commitStreamingView = useCallback(
    (nextContent) => {
      const projection = advanceStreamingMarkdownProjection(
        viewRef.current.projection,
        nextContent
      );
      const appendedParts = projection.appendedStable.map((part) => ({
        id: `markdown:${part.start}:${part.end}`,
        html: renderStreamingMarkdown(part.content),
      }));
      const next = {
        projection,
        stableParts: projection.reset
          ? appendedParts
          : [...viewRef.current.stableParts, ...appendedParts],
        live: projection.live,
      };
      viewRef.current = next;
      setView(next);
      notifyRender("streaming-markdown");
    },
    [notifyRender]
  );

  useEffect(() => {
    latestContent.current = content;
    if (!isStreaming) return;
    setFinalHtml(null);
    if (scheduledTimer.current || scheduledFrame.current) return;
    const elapsed = performance.now() - lastRenderedAt.current;
    scheduledTimer.current = setTimeout(
      () => {
        scheduledTimer.current = null;
        scheduledFrame.current = requestAnimationFrame(() => {
          scheduledFrame.current = null;
          lastRenderedAt.current = performance.now();
          commitStreamingView(latestContent.current);
        });
      },
      Math.max(0, 50 - elapsed)
    );
  }, [commitStreamingView, content, isStreaming]);

  useEffect(() => {
    if (isStreaming) return undefined;
    if (scheduledTimer.current) clearTimeout(scheduledTimer.current);
    if (scheduledFrame.current) cancelAnimationFrame(scheduledFrame.current);
    scheduledTimer.current = null;
    scheduledFrame.current = null;

    // Preserve the last rendered streaming frame while the formal renderer is
    // prepared. The completed DOM replaces it atomically; raw Markdown is
    // never mounted during this transition.
    commitStreamingView(content);
    return runIdleTask(
      () => {
        const html = DOMPurify.sanitize(renderMarkdown(content || ""));
        setFinalHtml(html);
        notifyRender("markdown-final");
      },
      { timeout: 250 }
    );
  }, [commitStreamingView, content, isStreaming, notifyRender]);

  useEffect(
    () => () => {
      if (scheduledTimer.current) clearTimeout(scheduledTimer.current);
      if (scheduledFrame.current) cancelAnimationFrame(scheduledFrame.current);
      if (layoutFrame.current) cancelAnimationFrame(layoutFrame.current);
    },
    []
  );

  if (!content) return null;
  if (finalHtml !== null) {
    return (
      <div
        className={className}
        dangerouslySetInnerHTML={{ __html: finalHtml }}
      />
    );
  }

  return (
    <div className={className} aria-live="polite">
      {view.stableParts.map((part) => (
        <div key={part.id} dangerouslySetInnerHTML={{ __html: part.html }} />
      ))}
      <LiveMarkdownBlock content={view.live} />
    </div>
  );
}

export default memo(StreamingMarkdown);
