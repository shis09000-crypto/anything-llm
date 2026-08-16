import { encode as HTMLEncode } from "he";
import markdownIt from "markdown-it";
import DOMPurify from "./purify";
import {
  stabilizeStreamingMarkdown,
  streamingMarkdownSegments,
} from "./streamingMarkdownProjection";

const streamingMarkdown = markdownIt({
  html: false,
  typographer: true,
  linkify: true,
  highlight(code, language) {
    const label = language
      ? `<div class="streaming-code-language">${HTMLEncode(language)}</div>`
      : "";
    return `<div class="streaming-code-block">${label}<pre class="whitespace-pre-wrap"><code>${HTMLEncode(code)}</code></pre></div>`;
  },
});

streamingMarkdown.renderer.rules.strong_open = () =>
  '<strong class="text-white light:text-slate-900">';
streamingMarkdown.renderer.rules.strong_close = () => "</strong>";
streamingMarkdown.renderer.rules.link_open = (tokens, index) => {
  const href = tokens[index].attrGet("href") || "#";
  return `<a href="${HTMLEncode(href)}" target="_blank" rel="noopener noreferrer">`;
};

export function renderStreamingMarkdown(raw = "") {
  return DOMPurify.sanitize(
    streamingMarkdown.render(stabilizeStreamingMarkdown(raw))
  );
}

export function renderStreamingMarkdownInline(raw = "") {
  return DOMPurify.sanitize(
    streamingMarkdown.renderInline(stabilizeStreamingMarkdown(raw))
  );
}

export function renderStreamingMarkdownSegments(raw = "") {
  const { stable, live } = streamingMarkdownSegments(raw);
  return {
    stableHtml: stable ? renderStreamingMarkdown(stable) : "",
    liveHtml: live ? renderStreamingMarkdown(live) : "",
  };
}
