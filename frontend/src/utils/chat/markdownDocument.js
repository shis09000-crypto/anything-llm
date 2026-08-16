const MARKDOWN_DOCUMENT_FENCE_OPEN =
  /^\s*(`{3,}|~{3,})(?:markdown|md)[ \t]*(?:\r?\n|$)/i;
const FENCE_LINE = /^```[^\r\n]*$/gm;
const BARE_TRAILING_FENCE = /(?:^|\r?\n)```[ \t]*(?:\r?\n)?$/;

function escapeRegExp(value = "") {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Responses providers sometimes wrap an entire Markdown answer in a
 * ```markdown fence. Providers can also use a longer outer fence (for example,
 * four backticks) so the document can contain normal three-backtick code
 * blocks. That makes a normal Markdown renderer display the whole response as
 * source code. Remove only that document-level fence while preserving real
 * nested code blocks. The opening fence is removed as soon as it streams in.
 */
export function unwrapMarkdownDocumentFence(text = "") {
  const value = String(text ?? "");
  const opening = value.match(MARKDOWN_DOCUMENT_FENCE_OPEN);
  if (!opening) return value;

  const inner = value.slice(opening[0].length);
  const outerFence = opening[1];
  const matchingTrailingFence = new RegExp(
    `(?:^|\\r?\\n)${escapeRegExp(outerFence)}[ \\t]*(?:\\r?\\n)?$`
  );

  // A longer outer fence has an unambiguous matching close and can safely
  // contain shorter Markdown code fences.
  if (outerFence.length > 3) {
    return matchingTrailingFence.test(inner)
      ? inner.replace(matchingTrailingFence, "").trimEnd()
      : inner;
  }

  const fenceLines = inner.match(FENCE_LINE) || [];
  const hasOuterClosingFence =
    BARE_TRAILING_FENCE.test(inner) && fenceLines.length % 2 === 1;

  return hasOuterClosingFence
    ? inner.replace(BARE_TRAILING_FENCE, "").trimEnd()
    : inner;
}
