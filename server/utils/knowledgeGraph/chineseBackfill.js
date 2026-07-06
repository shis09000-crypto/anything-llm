const { lazyDataAccessProperty } = require("../dataAccess/lazyFacade");
const { getTaskConnector, resolveTaskProviderModel } = require("../llmTasks");
const KnowledgeGraph = lazyDataAccessProperty("knowledgeGraph", "model");
const { invalidateGraphRetrievalCache } = require("./retrievalCache");
const { normalizeAliasPairs, firstChineseAlias } = require("./bilingualLabels");
const { safeJsonParse } = require("../http");

const activeBackfillKeys = new Set();
const MAX_NODES_PER_BATCH = 30;
const BACKFILL_MODEL = resolveTaskProviderModel(
  "knowledge_graph_chinese_backfill"
).model;

function hasChinese(value = "") {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function needsChineseNodeBackfill(node = {}) {
  if (!node?.id || !node?.canonicalName) return false;
  if (!hasChinese(node.displayNameZh || "")) return true;
  const summary = String(node.summary || "").trim();
  return summary.length > 0 && !hasChinese(summary);
}

function parseBackfillJson(raw = "") {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
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

function normalizeBackfillItems(raw = "") {
  const parsed = parseBackfillJson(raw);
  if (!parsed || typeof parsed !== "object") return [];
  return (Array.isArray(parsed.items) ? parsed.items : [])
    .map((item) => ({
      id: Number(item?.id),
      displayNameZh: String(item?.displayNameZh || "")
        .trim()
        .slice(0, 160),
      summaryZh: String(item?.summaryZh || "")
        .trim()
        .slice(0, 700),
      aliases: normalizeAliasPairs(item?.aliases || []),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.id) &&
        (hasChinese(item.displayNameZh) || hasChinese(item.summaryZh))
    );
}

function backfillPrompt(nodes = []) {
  return `请把这些知识图谱节点补齐为简体中文显示数据。

要求：
- 只返回 JSON，不要 markdown。
- 保留 id，不要新增节点，不要修改节点身份。
- displayNameZh 是适合图谱卡片标题的简短中文名。
- summaryZh 是自然中文短解释，不超过 60 个汉字。
- 只基于输入的 canonicalName、summary、aliases 改写，不要添加输入之外的新知识。
- 人名、经典术语按中文常用译名；没有常用译名时可音译或意译。
- aliases 可返回少量中英别名对象，但不要删除原有英文原名。

输入：
${JSON.stringify(
  nodes.map((node) => ({
    id: node.id,
    canonicalName: node.canonicalName,
    displayNameZh: node.displayNameZh || null,
    displayNameEn: node.displayNameEn || null,
    entityType: node.entityType || null,
    summary: node.summary || "",
    aliases: node.aliases || [],
  })),
  null,
  2
)}

输出格式：
{
  "items": [
    {
      "id": 123,
      "displayNameZh": "中文概念名",
      "summaryZh": "中文短解释",
      "aliases": [{ "en": "English alias", "zh": "中文别名" }]
    }
  ]
}`;
}

async function backfillChineseNodeFields({ workspaceId, nodes = [] }) {
  const targets = nodes.filter(needsChineseNodeBackfill);
  if (!workspaceId || targets.length === 0) return { updated: 0, total: 0 };

  const { connector } = getTaskConnector("knowledge_graph_chinese_backfill");
  let updated = 0;
  for (let i = 0; i < targets.length; i += MAX_NODES_PER_BATCH) {
    const batch = targets.slice(i, i + MAX_NODES_PER_BATCH);
    const messages = await connector.compressMessages(
      {
        systemPrompt:
          "你负责把知识图谱节点显示数据补齐为简体中文。只输出严格 JSON。",
        userPrompt: backfillPrompt(batch),
        contextTexts: [],
        chatHistory: [],
        attachments: [],
      },
      []
    );
    const { textResponse } = await connector.getChatCompletion(messages, {
      temperature: 0,
      responseFormat: { type: "json_object" },
    });
    const items = normalizeBackfillItems(textResponse);
    const byId = new Map(items.map((item) => [Number(item.id), item]));
    for (const node of batch) {
      const item = byId.get(Number(node.id));
      if (!item) continue;
      const displayNameZh =
        hasChinese(item.displayNameZh) || !hasChinese(node.displayNameZh || "")
          ? item.displayNameZh || firstChineseAlias(item.aliases)
          : null;
      const summary =
        hasChinese(item.summaryZh) &&
        String(node.summary || "").trim() !== item.summaryZh
          ? item.summaryZh
          : null;
      if (!displayNameZh && !summary && item.aliases.length === 0) continue;
      await KnowledgeGraph.updateNodeChineseFields({
        id: node.id,
        displayNameZh,
        summary,
        aliases: item.aliases,
      });
      updated += 1;
    }
  }

  if (updated > 0) await invalidateGraphRetrievalCache(workspaceId);
  return { updated, total: targets.length };
}

function enqueueChineseNodeBackfill({ workspaceId, nodes = [], reason = "" }) {
  if (!workspaceId || !Array.isArray(nodes) || nodes.length === 0) return;
  const targets = nodes.filter(needsChineseNodeBackfill).filter((node) => {
    const key = `${workspaceId}:${node.id}`;
    if (activeBackfillKeys.has(key)) return false;
    activeBackfillKeys.add(key);
    return true;
  });
  if (targets.length === 0) return;

  setImmediate(async () => {
    try {
      const result = await backfillChineseNodeFields({
        workspaceId,
        nodes: targets,
      });
      if (result.updated > 0) {
        console.log(
          `[KnowledgeGraph] Chinese node backfill updated ${result.updated}/${result.total} nodes for workspace ${workspaceId}${reason ? ` (${reason})` : ""}`
        );
      }
    } catch (error) {
      console.warn(
        `[KnowledgeGraph] Chinese node backfill skipped for workspace ${workspaceId}:`,
        error.message
      );
    } finally {
      for (const node of targets)
        activeBackfillKeys.delete(`${workspaceId}:${node.id}`);
    }
  });
}

module.exports = {
  BACKFILL_MODEL,
  MAX_NODES_PER_BATCH,
  hasChinese,
  needsChineseNodeBackfill,
  normalizeBackfillItems,
  backfillChineseNodeFields,
  enqueueChineseNodeBackfill,
};
