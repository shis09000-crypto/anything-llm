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
  if (openFence(value)) return { stable: "", live: value };
  const boundary = value.lastIndexOf("\n\n");
  if (boundary < 0) return { stable: "", live: value };
  return {
    stable: value.slice(0, boundary + 2),
    live: value.slice(boundary + 2),
  };
}
