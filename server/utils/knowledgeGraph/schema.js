const { safeJsonParse } = require("../http");

const MAX_ENTITIES_PER_CHUNK = 20;
const MAX_RELATIONS_PER_CHUNK = 30;
const MAX_EXTRACTION_CHARS = 8_000;

function clamp(value, min = 0, max = 1) {
  const num = Number(value);
  if (Number.isNaN(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function cleanText(value = "", max = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function parseExtractionJson(raw = "") {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  const sliced =
    firstBrace >= 0 && lastBrace > firstBrace
      ? candidate.slice(firstBrace, lastBrace + 1)
      : candidate;

  try {
    return JSON.parse(sliced);
  } catch {
    try {
      const { jsonrepair } = require("jsonrepair");
      return JSON.parse(jsonrepair(sliced));
    } catch {
      const parsed = safeJsonParse(sliced, null);
      if (!parsed) throw new Error("knowledge_graph_invalid_json");
      return parsed;
    }
  }
}

function normalizeExtractionResult(raw = "") {
  const parsed = parseExtractionJson(raw);
  if (!parsed || typeof parsed !== "object")
    throw new Error("knowledge_graph_invalid_json");

  const entities = (Array.isArray(parsed.entities) ? parsed.entities : [])
    .slice(0, MAX_ENTITIES_PER_CHUNK)
    .map((entity) => ({
      name: cleanText(entity?.name, 140),
      type: cleanText(entity?.type || "concept", 80).toLowerCase(),
      summary: cleanText(entity?.summary, 700),
      aliases: Array.isArray(entity?.aliases)
        ? entity.aliases.map((alias) => cleanText(alias, 140)).filter(Boolean)
        : [],
    }))
    .filter((entity) => entity.name);

  const entityNames = new Set(entities.map((entity) => entity.name));
  const relations = (Array.isArray(parsed.relations) ? parsed.relations : [])
    .slice(0, MAX_RELATIONS_PER_CHUNK)
    .map((relation) => ({
      source: cleanText(relation?.source, 140),
      target: cleanText(relation?.target, 140),
      relation: cleanText(relation?.relation || relation?.type, 100),
      confidence: clamp(relation?.confidence, 0, 1),
      snippet: cleanText(relation?.snippet || relation?.evidence, 1_000),
    }))
    .filter(
      (relation) =>
        relation.source &&
        relation.target &&
        relation.source !== relation.target &&
        entityNames.has(relation.source) &&
        entityNames.has(relation.target)
    );

  return { entities, relations };
}

function clipChunkText(text = "") {
  return String(text || "").slice(0, MAX_EXTRACTION_CHARS);
}

module.exports = {
  MAX_ENTITIES_PER_CHUNK,
  MAX_RELATIONS_PER_CHUNK,
  MAX_EXTRACTION_CHARS,
  clamp,
  cleanText,
  parseExtractionJson,
  normalizeExtractionResult,
  clipChunkText,
};
