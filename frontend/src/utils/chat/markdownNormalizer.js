const STRONG_SENTINEL = "\ue000";

function isStrongDelimiter(segment = "", index = 0) {
  return (
    segment.slice(index, index + 2) === "**" &&
    segment[index - 1] !== "*" &&
    segment[index + 2] !== "*"
  );
}

function findStrongDelimiter(segment = "", fromIndex = 0) {
  for (let index = fromIndex; index < segment.length - 1; index += 1) {
    if (isStrongDelimiter(segment, index)) return index;
  }
  return -1;
}

function repairStrongDelimiters(segment = "") {
  let output = "";
  let cursor = 0;

  while (cursor < segment.length) {
    const open = findStrongDelimiter(segment, cursor);
    if (open === -1) {
      output += segment.slice(cursor);
      break;
    }

    const close = findStrongDelimiter(segment, open + 2);
    if (close === -1) {
      output += segment.slice(cursor);
      break;
    }

    const content = segment.slice(open + 2, close);
    if (!content.trim()) {
      output += segment.slice(cursor, close + 2);
      cursor = close + 2;
      continue;
    }

    output += `${segment.slice(cursor, open + 2)}${STRONG_SENTINEL}${content}${STRONG_SENTINEL}**`;
    cursor = close + 2;
  }

  return output;
}

function transformOutsideInlineCode(segment = "") {
  let output = "";
  let cursor = 0;

  while (cursor < segment.length) {
    const tickStart = segment.indexOf("`", cursor);
    if (tickStart === -1) {
      output += repairStrongDelimiters(segment.slice(cursor));
      break;
    }

    output += repairStrongDelimiters(segment.slice(cursor, tickStart));
    let tickEnd = tickStart;
    while (segment[tickEnd] === "`") tickEnd += 1;

    const marker = segment.slice(tickStart, tickEnd);
    const closing = segment.indexOf(marker, tickEnd);
    if (closing === -1) {
      output += segment.slice(tickStart);
      break;
    }

    output += segment.slice(tickStart, closing + marker.length);
    cursor = closing + marker.length;
  }

  return output;
}

export function normalizeMarkdownStrongDelimiters(text = "") {
  const lines = String(text || "").split("\n");
  let inFence = false;
  let fenceChar = null;
  let fenceLength = 0;

  return lines
    .map((line, index) => {
      const newline = index < lines.length - 1 ? "\n" : "";
      const lineWithNewline = `${line}${newline}`;
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);

      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!inFence) {
          inFence = true;
          fenceChar = marker[0];
          fenceLength = marker.length;
        } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
          inFence = false;
          fenceChar = null;
          fenceLength = 0;
        }

        return lineWithNewline;
      }

      if (inFence) return lineWithNewline;
      return `${transformOutsideInlineCode(line)}${newline}`;
    })
    .join("");
}

export function stripMarkdownStrongSentinel(html = "") {
  return String(html || "")
    .split(STRONG_SENTINEL)
    .join("");
}
