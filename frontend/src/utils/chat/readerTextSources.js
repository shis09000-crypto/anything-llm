function textHash(text = "") {
  let hash = 5381;
  const normalized = String(text || "")
    .trim()
    .slice(0, 1000);
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 33) ^ normalized.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isReaderTextSource(source = {}) {
  return source?.delivery === "txt" || source?.mime === "text/plain";
}

export function readerTextSourceIdentity(source = {}) {
  if (!isRecord(source)) return null;
  if (source.sourceKey) return String(source.sourceKey);
  if (!source.selectedText) return null;
  return [
    source.documentTitle || "文档",
    source.locatorLabel || "",
    source.textHash || textHash(source.selectedText || ""),
  ].join(":");
}

function mergeMissingFields(primary = {}, duplicate = {}) {
  const next = { ...primary };
  for (const [key, value] of Object.entries(duplicate || {})) {
    if (next[key] !== undefined && next[key] !== null && next[key] !== "")
      continue;
    next[key] = value;
  }
  return next;
}

export function dedupeReaderTextSources(sources = []) {
  if (!Array.isArray(sources)) return [];

  const result = [];
  const positions = new Map();

  for (const source of sources) {
    if (!isRecord(source)) continue;
    const identity = readerTextSourceIdentity(source);
    if (!identity) {
      result.push(source);
      continue;
    }

    const index = positions.get(identity);
    if (index === undefined) {
      positions.set(identity, result.length);
      result.push(source);
      continue;
    }

    result[index] = mergeMissingFields(result[index], source);
  }

  return result;
}
