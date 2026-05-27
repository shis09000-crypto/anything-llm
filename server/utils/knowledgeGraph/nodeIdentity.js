const NODE_KEY_SOURCE = "kg";

const ENTITY_TYPES = new Set([
  "person",
  "concept",
  "school",
  "work",
  "era",
  "question",
  "claim",
  "argument",
  "topic",
  "problem",
  "decision",
  "task",
  "source",
  "note",
  "chapter",
  "method",
  "event",
  "feature",
  "requirement",
  "risk",
  "bug",
  "architecture",
]);

function normalizeNodeKeyPart(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeEntityType(value = "concept") {
  const normalized = normalizeNodeKeyPart(value) || "concept";
  return ENTITY_TYPES.has(normalized) ? normalized : normalized;
}

function normalizeCanonicalKey(value = "") {
  return normalizeNodeKeyPart(value);
}

function buildNodeKey(input = {}, legacyCanonicalKey = undefined) {
  const payload =
    typeof input === "object" && input !== null
      ? input
      : { entityType: input, canonicalKey: legacyCanonicalKey };
  const source = normalizeNodeKeyPart(payload.source || NODE_KEY_SOURCE);
  const entityType = normalizeEntityType(payload.entityType || "concept");
  const canonicalKey = normalizeCanonicalKey(payload.canonicalKey);
  if (!canonicalKey) return null;
  return `${source}:${entityType}:${canonicalKey}`;
}

function buildLegacyNodeKey(input = {}, legacyCanonicalKey = undefined) {
  const payload =
    typeof input === "object" && input !== null
      ? input
      : { entityType: input, canonicalKey: legacyCanonicalKey };
  const entityType = normalizeEntityType(payload.entityType || "concept");
  const canonicalKey = normalizeCanonicalKey(payload.canonicalKey);
  if (!canonicalKey) return null;
  return `${entityType}:${canonicalKey}`;
}

function parseNodeKey(nodeKey = "") {
  const parts = String(nodeKey || "")
    .trim()
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 3) {
    return {
      source: normalizeNodeKeyPart(parts[0]) || NODE_KEY_SOURCE,
      entityType: normalizeEntityType(parts[1]),
      canonicalKey: normalizeCanonicalKey(parts[2]),
      legacy: false,
    };
  }
  if (parts.length === 2) {
    return {
      source: NODE_KEY_SOURCE,
      entityType: normalizeEntityType(parts[0]),
      canonicalKey: normalizeCanonicalKey(parts[1]),
      legacy: true,
    };
  }
  return null;
}

function isStableNodeKey(nodeKey = "") {
  const parsed = parseNodeKey(nodeKey);
  return Boolean(parsed?.source && parsed?.entityType && parsed?.canonicalKey);
}

function nodeKeyCandidates(nodeKey = "") {
  const parsed = parseNodeKey(nodeKey);
  if (!parsed) return [];
  return [
    buildNodeKey(parsed),
    buildLegacyNodeKey(parsed),
    String(nodeKey || "").trim(),
  ].filter(Boolean);
}

module.exports = {
  NODE_KEY_SOURCE,
  ENTITY_TYPES: Array.from(ENTITY_TYPES),
  buildNodeKey,
  buildLegacyNodeKey,
  isStableNodeKey,
  nodeKeyCandidates,
  normalizeCanonicalKey,
  normalizeEntityType,
  normalizeNodeKeyPart,
  parseNodeKey,
};
