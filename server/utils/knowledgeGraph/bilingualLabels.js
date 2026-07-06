const { lazyDataAccessProperty } = require("../dataAccess/lazyFacade");
const { getTaskConnector } = require("../llmTasks");
const { safeJsonParse } = require("../http");
const KnowledgeGraph = lazyDataAccessProperty("knowledgeGraph", "model");
const { LABEL_TRANSLATION_PROMPT_VERSION } = require("./constants");

function parseLabelJson(raw = "") {
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
      return safeJsonParse(sliced, null);
    }
  }
}

function normalizeAliasPairs(aliases = []) {
  return (Array.isArray(aliases) ? aliases : [])
    .map((alias) => {
      if (alias && typeof alias === "object") {
        return {
          ...(alias.en ? { en: String(alias.en).trim().slice(0, 140) } : {}),
          ...(alias.zh ? { zh: String(alias.zh).trim().slice(0, 140) } : {}),
        };
      }
      const text = String(alias || "")
        .trim()
        .slice(0, 140);
      if (!text) return null;
      return /[\u3400-\u9fff]/.test(text) ? { zh: text } : { en: text };
    })
    .filter((alias) => alias && (alias.en || alias.zh))
    .slice(0, 12);
}

function firstChineseAlias(aliases = []) {
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const value =
      alias && typeof alias === "object" ? alias.zh : String(alias || "");
    if (/[\u3400-\u9fff]/.test(value)) return String(value).trim();
  }
  return null;
}

function normalizeLabelResult(raw, fallbackEn) {
  const parsed = parseLabelJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const displayNameEn = String(parsed.displayNameEn || fallbackEn || "")
    .trim()
    .slice(0, 160);
  const displayNameZh = String(parsed.displayNameZh || "")
    .trim()
    .slice(0, 160);
  return {
    displayNameEn,
    displayNameZh,
    aliases: normalizeAliasPairs(parsed.aliases),
  };
}

async function translateNodeLabels({ workspaceId, node, LLMConnector = null }) {
  if (!workspaceId || !node?.id || !node?.canonicalName) return null;
  if (node.displayNameZh && node.displayNameEn) return node;

  const cacheKey = `node:${KnowledgeGraph.canonicalKey(node.canonicalName)}`;
  const cached = await KnowledgeGraph.findLabelTranslationCache({
    workspaceId,
    cacheKey,
  });
  if (cached) {
    const displayNameZh =
      cached.displayNameZh ||
      firstChineseAlias(cached.aliases) ||
      firstChineseAlias(node.aliases);
    return await KnowledgeGraph.updateNodeDisplayLabels({
      id: node.id,
      displayNameZh,
      displayNameEn: cached.displayNameEn || node.canonicalName,
      aliases: cached.aliases || [],
    });
  }

  const connector =
    LLMConnector ||
    getTaskConnector("knowledge_graph_bilingual_labels").connector;
  const prompt = `Translate this knowledge graph concept label for display only.

Rules:
- Do not change the canonical identity.
- Return strict JSON only.
- Translate only labels and aliases, not evidence or long text.
- Keep displayNameEn as concise English canonical reference text.
- Keep displayNameZh as concise Simplified Chinese.

Input:
${JSON.stringify({
  canonicalName: node.canonicalName,
  entityType: node.entityType,
  summary: node.summary,
  aliases: node.aliases || [],
})}

Output schema:
{
  "displayNameZh": "中文概念名",
  "displayNameEn": "English concept label",
  "aliases": [{ "en": "alias", "zh": "中文别名" }]
}`;

  try {
    const messages = await connector.compressMessages(
      {
        systemPrompt:
          "You generate bilingual display labels for a knowledge graph. Output strict JSON only.",
        userPrompt: prompt,
        contextTexts: [],
        chatHistory: [],
        attachments: [],
      },
      []
    );
    const { textResponse } = await connector.getChatCompletion(messages, {
      temperature: 0,
    });
    const labels = normalizeLabelResult(textResponse, node.canonicalName);
    if (!labels?.displayNameZh && !labels?.displayNameEn) return node;
    const displayNameZh =
      labels.displayNameZh ||
      firstChineseAlias(labels.aliases) ||
      firstChineseAlias(node.aliases);
    await KnowledgeGraph.setLabelTranslationCache({
      workspaceId,
      cacheKey,
      sourceText: node.canonicalName,
      sourceType: "node",
      displayNameZh,
      displayNameEn: labels.displayNameEn || node.canonicalName,
      aliases: labels.aliases || [],
      model,
      promptVersion: LABEL_TRANSLATION_PROMPT_VERSION,
    });
    return await KnowledgeGraph.updateNodeDisplayLabels({
      id: node.id,
      displayNameZh,
      displayNameEn: labels.displayNameEn || node.canonicalName,
      aliases: labels.aliases || [],
    });
  } catch (error) {
    console.warn(
      `[KnowledgeGraph] label translation skipped for ${node.canonicalName}:`,
      error.message
    );
    return node;
  }
}

async function enqueueNodeLabelTranslation(args = {}) {
  setImmediate(() => {
    translateNodeLabels(args).catch((error) =>
      console.warn(
        "[KnowledgeGraph] async label translation failed",
        error.message
      )
    );
  });
}

module.exports = {
  LABEL_TRANSLATION_PROMPT_VERSION,
  normalizeAliasPairs,
  normalizeLabelResult,
  firstChineseAlias,
  translateNodeLabels,
  enqueueNodeLabelTranslation,
};
