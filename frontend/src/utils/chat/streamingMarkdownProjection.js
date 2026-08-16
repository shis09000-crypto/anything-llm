function unescapedMatches(value, expression) {
  return [...String(value || "").matchAll(expression)].filter((match) => {
    let escapes = 0;
    for (let index = match.index - 1; index >= 0; index -= 1) {
      if (value[index] !== "\\") break;
      escapes += 1;
    }
    return escapes % 2 === 0;
  });
}

function openFence(value = "") {
  const fences = unescapedMatches(value, /^\s*(```+|~~~+)/gm);
  if (fences.length % 2 === 0) return null;
  return fences.at(-1)?.[1]?.startsWith("~") ? "~~~" : "```";
}

function maskCodeFences(value = "") {
  let inFence = false;
  let marker = null;
  return String(value || "")
    .split("\n")
    .map((line) => {
      const fence = line.match(/^\s*(`{3,}|~{3,})/);
      const isFenceLine = Boolean(fence);
      if (isFenceLine && !inFence) {
        inFence = true;
        marker = fence[1][0];
      } else if (isFenceLine && inFence && fence[1][0] === marker) {
        inFence = false;
        marker = null;
      }
      return inFence || isFenceLine ? line.replace(/[^\s]/g, " ") : line;
    })
    .join("\n");
}

function maskInlineCode(value = "") {
  return String(value || "").replace(/`[^`\n]*`/g, (match) =>
    match.replace(/[^\s]/g, " ")
  );
}

/**
 * Derives a display-only Markdown string for an incomplete provider stream.
 * The raw model output remains authoritative and is never changed or stored.
 */
export function stabilizeStreamingMarkdown(raw = "") {
  let display = String(raw || "");
  const fence = openFence(display);
  if (fence) return `${display}\n${fence}`;

  let syntax = maskCodeFences(display);
  const inlineCode = unescapedMatches(syntax, /(?<!`)`(?!`)/g);
  if (inlineCode.length % 2 === 1) {
    const openIndex = inlineCode.at(-1).index;
    syntax = `${syntax.slice(0, openIndex)}${syntax
      .slice(openIndex)
      .replace(/[^\s]/g, " ")}`;
    display += "`";
  }
  syntax = maskInlineCode(syntax);

  const emphasisPairs = [
    [/(?<!\*)\*\*(?!\*)/g, "**"],
    [/(?<!_)__(?!_)/g, "__"],
    [/(?<!~)~~(?!~)/g, "~~"],
    [/(?<!\*)\*(?!\*)/g, "*"],
    [/(?<!_)_(?!_)/g, "_"],
  ];
  for (const [expression, delimiter] of emphasisPairs) {
    if (unescapedMatches(syntax, expression).length % 2 === 1)
      display += delimiter;
  }

  const openLinkTarget = syntax.match(/\[[^\]\n]+\]\([^\s)\n]*$/);
  if (openLinkTarget) display += ")";
  else {
    const lastOpenBracket = syntax.lastIndexOf("[");
    const lastCloseBracket = syntax.lastIndexOf("]");
    if (lastOpenBracket > lastCloseBracket) display += "]";
  }
  return display;
}

export function streamingMarkdownSegments(raw = "") {
  const value = String(raw || "");
  if (!value) return { stable: "", live: "" };
  const boundary = streamingMarkdownStableBoundary(value);
  if (boundary < 0) return { stable: "", live: value };
  return {
    stable: value.slice(0, boundary),
    live: value.slice(boundary),
  };
}

export function streamingMarkdownStableBoundary(raw = "") {
  const value = String(raw || "");
  let inFence = false;
  let marker = null;
  let lastBoundary = -1;
  let lineStart = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index < value.length && value[index] !== "\n") continue;
    const line = value.slice(lineStart, index);
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence && !inFence) {
      inFence = true;
      marker = fence[1][0];
    } else if (fence && inFence && fence[1][0] === marker) {
      inFence = false;
      marker = null;
    }
    if (!inFence && line.trim() === "") lastBoundary = index + 1;
    lineStart = index + 1;
  }
  return lastBoundary;
}

export function closedStreamingMarkdownChunks(raw = "", offset = 0) {
  const value = String(raw || "");
  const chunks = [];
  let cursor = 0;
  let inFence = false;
  let marker = null;
  let lineStart = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index < value.length && value[index] !== "\n") continue;
    const line = value.slice(lineStart, index);
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence && !inFence) {
      inFence = true;
      marker = fence[1][0];
    } else if (fence && inFence && fence[1][0] === marker) {
      inFence = false;
      marker = null;
    }
    if (!inFence && line.trim() === "") {
      const end = index + 1;
      const content = value.slice(cursor, end);
      if (content.trim())
        chunks.push({ content, start: offset + cursor, end: offset + end });
      cursor = end;
    }
    lineStart = index + 1;
  }
  if (cursor < value.length) {
    const content = value.slice(cursor);
    if (content.trim())
      chunks.push({
        content,
        start: offset + cursor,
        end: offset + value.length,
      });
  }
  return chunks;
}

export function advanceStreamingMarkdownProjection(previous = {}, raw = "") {
  const source = String(raw || "");
  const canAppend = source.startsWith(previous.source || "");
  const priorOffset = canAppend ? Number(previous.stableOffset || 0) : 0;
  const boundary = Math.max(0, streamingMarkdownStableBoundary(source));
  const stableOffset = Math.max(priorOffset, boundary);
  const appended = source.slice(priorOffset, stableOffset);
  return {
    source,
    stableOffset,
    reset: !canAppend,
    appendedStable: closedStreamingMarkdownChunks(appended, priorOffset),
    live: source.slice(stableOffset),
  };
}

function tableCells(line = "") {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function streamingTableProjection(raw = "") {
  const lines = String(raw || "").split("\n");
  if (lines.length < 2 || !/^\s*\|?.+\|.+/.test(lines[0])) return null;
  const delimiter = tableCells(lines[1]);
  if (!delimiter.length || delimiter.some((cell) => !/^:?-{3,}:?$/.test(cell)))
    return null;
  const completeLineCount = raw.endsWith("\n")
    ? lines.length
    : lines.length - 1;
  const rows = lines
    .slice(2, completeLineCount)
    .filter((line) => line.trim())
    .map(tableCells);
  const pending = raw.endsWith("\n") ? null : tableCells(lines.at(-1));
  return { headers: tableCells(lines[0]), rows, pending };
}

export function streamingListProjection(raw = "") {
  const lines = String(raw || "").split("\n");
  const matches = lines.map((line) =>
    line.match(/^\s*(?:(\d+)[.)]|[-+*])\s+(.+)$/)
  );
  if (
    !matches[0] ||
    matches.some(
      (match, index) =>
        index < lines.length - 1 && lines[index].trim() && !match
    )
  )
    return null;
  const ordered = Boolean(matches[0][1]);
  const completeLineCount = raw.endsWith("\n")
    ? lines.length
    : lines.length - 1;
  const items = matches
    .slice(0, completeLineCount)
    .filter(Boolean)
    .map((match) => match[2]);
  const pending =
    raw.endsWith("\n") || !matches.at(-1) ? null : matches.at(-1)[2];
  return { ordered, items, pending };
}

export function streamingCodeProjection(raw = "") {
  const match = String(raw || "").match(
    /^\s*(`{3,}|~{3,})([^\n]*)\n?([\s\S]*)$/
  );
  if (!match) return null;
  const marker = match[1][0];
  const body = match[3] || "";
  const closed = new RegExp(`(?:^|\\n)\\s*${marker}{3,}\\s*$`).test(body);
  if (closed) return null;
  return { language: match[2].trim(), code: body };
}
