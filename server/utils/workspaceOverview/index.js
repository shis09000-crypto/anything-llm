const crypto = require("crypto");
const { safeJsonParse } = require("../http");
const { healthBeacon, unknownBeacon } = require("../workspaceHealth/beacon");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const { buildNodeKey } = require("../knowledgeGraph/nodeKey");
const {
  buildWorkspaceKnowledgeProfile,
} = require("../knowledgeGraph/workspaceProfileBuilder");
const { keyPathsForNode } = require("../knowledgeGraph/pathResolver");
const {
  buildKnowledgeEngineRecommendations,
} = require("../knowledgeGraph/recommendationAdapter");
const { getOrScheduleWorkspaceOverviewNarrative } = require("./narrative");
const {
  decryptWorkspaceChatRecordsAsync,
} = require("../security/chatHistoryEncryption");

const WorkspaceOverviewData = lazyDataAccessFacade("workspaceOverview");
const workspaceOverviewDb = WorkspaceOverviewData.db;
const NodeSupplement = WorkspaceOverviewData.nodeSupplement;
const WorkspaceSupplement = WorkspaceOverviewData.workspaceSupplement;
const WorkspaceVisualAsset = WorkspaceOverviewData.workspaceVisualAsset;

const FORMULA_VERSION = "overview-rec-v1";
const DAY_MS = 86_400_000;
const DISMISS_COOLDOWN_DAYS = 7;
const MAX_RECOMMENDATIONS = 18;
const OVERVIEW_CACHE_TTL_MS = 60_000;
const OVERVIEW_ERROR_CACHE_TTL_MS = 5_000;
const CURRENT_FOCUS_MIN_DWELL_MS = 10 * 60_000;
const CURRENT_FOCUS_SWITCH_THRESHOLD = 12;
const CURRENT_FOCUS_CATEGORIES = new Set(["continue", "focus"]);
const NODE_TARGET_TYPES = new Set(["node", "concept"]);
const NODE_TYPE_LABELS = {
  person: "人物",
  concept: "概念",
  school: "学派",
  work: "著作",
  era: "时代",
  question: "问题",
  claim: "论断",
  argument: "论证",
  topic: "主题",
  problem: "问题",
  decision: "决策",
  task: "任务",
  source: "来源",
  note: "笔记",
};
const RELATION_TYPE_LABELS = {
  influences: "影响",
  influenced_by: "影响",
  references: "引用",
  cites: "引用",
  includes: "包含",
  contains: "包含",
  proposes: "提出",
  proposed: "提出",
  "belongs to school": "所属学派",
  belongs_to_school: "所属学派",
  criticizes: "批判",
  develops: "发展",
  introduces_concept: "提出",
  answers_question: "回答",
  contrasts_with: "对比",
  prerequisite_of: "前置",
  often_confused_with: "易混淆",
  supports_claim: "支持",
  refutes_claim: "反驳",
  related_to: "关联",
  part_of: "组成",
  depends_on: "依赖",
  leads_to: "因果",
  open_question_for: "开放问题",
  evidence_for: "证据",
};
const RELATION_LABEL_ALIASES = {
  reference: "引用",
  references: "引用",
  cites: "引用",
  cite: "引用",
  includes: "包含",
  include: "包含",
  contains: "包含",
  contain: "包含",
  proposes: "提出",
  propose: "提出",
  proposed: "提出",
  "belongs to school": "所属学派",
  belongs_to_school: "所属学派",
  "belongs-to-school": "所属学派",
  "belongs to": "属于",
  belongs_to: "属于",
  "part of": "组成",
  part_of: "组成",
  leads_to: "因果",
  "leads to": "因果",
  depends_on: "依赖",
  "depends on": "依赖",
};
const CONTRAST_RELATION_TYPES = new Set([
  "contrasts_with",
  "often_confused_with",
]);
const MAIN_AXIS_PATH_TYPES = new Set([
  "historical_lineage",
  "conceptual_development",
  "influence_chain",
  "prerequisite_path",
  "evidence_to_conclusion_path",
  "chapter_or_topic_path",
]);
const RELATION_SEMANTIC_KEYWORDS = {
  influences: ["影响", "继承", "启发"],
  influenced_by: ["影响", "继承", "启发"],
  criticizes: ["批判", "反驳", "质疑"],
  develops: ["发展", "推进", "演变"],
  introduces_concept: ["提出", "概念", "引入"],
  belongs_to_school: ["属于", "学派", "传统"],
  answers_question: ["回答", "问题", "回应"],
  contrasts_with: ["对比", "相反", "差异", "张力"],
  prerequisite_of: ["前置", "基础", "先于"],
  often_confused_with: ["混淆", "易混", "区别"],
  supports_claim: ["支持", "论证", "证明"],
  refutes_claim: ["反驳", "批判", "否定"],
  part_of: ["组成", "部分", "包含"],
  depends_on: ["依赖", "前提", "基础"],
  leads_to: ["导致", "因果", "引发"],
  evidence_for: ["证据", "支持", "证明"],
};

const overviewCache = new Map();
const overviewInflight = new Map();
const overviewFocusState = new Map();
const FOCUS_STATE_SYMBOL = Symbol("workspaceOverviewFocusState");

function safeJSONStringify(value, fallback = "{}") {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function toSqliteDateTime(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function countFrom(rows) {
  return Number(rows?.[0]?.count || 0);
}

function isSqliteLocked(error) {
  return (
    error?.code === "P2010" &&
    (error?.meta?.code === "5" ||
      String(error?.meta?.message || error.message || "").includes(
        "database is locked"
      ))
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSqliteBusyRetry(fn, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isSqliteLocked(error) || attempt >= attempts) throw error;
      await sleep(150 * attempt);
    }
  }
  throw lastError;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function daysSince(value) {
  if (!value) return 999;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return 999;
  return Math.max(0, (Date.now() - time) / DAY_MS);
}

function decay(value, halfLifeDays = 7) {
  const age = typeof value === "number" ? value : daysSince(value);
  return Math.pow(0.5, age / halfLifeDays);
}

function displayName(node = {}) {
  return node.displayNameZh || node.displayNameEn || node.canonicalName || "";
}

function nodeTypeLabel(entityType = "concept") {
  return NODE_TYPE_LABELS[entityType] || "节点";
}

function compactText(value = "", max = 120) {
  const text = String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~[\]()-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function firstSentence(value = "", max = 120) {
  const text = compactText(value, Math.max(max * 2, 160));
  if (!text) return "";
  const match = text.match(/^(.+?[。！？!?；;])/);
  return compactText(match?.[1] || text, max);
}

function relationTypeLabel(edge = {}) {
  const candidates = [
    edge.relationLabelZh,
    edge.relationLabel,
    edge.relationType,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const normalized = normalizeRelationLabel(candidate);
    if (RELATION_LABEL_ALIASES[normalized])
      return RELATION_LABEL_ALIASES[normalized];
    if (RELATION_TYPE_LABELS[normalized])
      return RELATION_TYPE_LABELS[normalized];
  }
  const zhLabel = candidates.find((candidate) => containsCjk(candidate));
  return zhLabel ? compactText(zhLabel, 16) : "关联";
}

function normalizeRelationLabel(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function containsCjk(value = "") {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function relationDisplayLabel(edge = {}, max = 18) {
  const rawLabel = edge.relationLabelZh || edge.relationLabel || "";
  if (rawLabel && containsCjk(rawLabel)) return compactText(rawLabel, max);
  return relationTypeLabel(edge);
}

function relationSemanticKeywords(edge = {}) {
  const keywords = new Set([
    relationTypeLabel(edge),
    ...(RELATION_SEMANTIC_KEYWORDS[edge.relationType] || []),
  ]);
  const label = compactText(
    edge.relationLabelZh || edge.relationLabel || "",
    24
  );
  if (label) {
    keywords.add(label);
    for (const part of label.split(/[、，,/\s]+/).filter(Boolean))
      keywords.add(part);
  }
  return [...keywords].filter((item) => item && item !== "关联");
}

function cleanEvidenceSnippet(value = "") {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/第?\s*\d+\s*[页頁]/g, " ")
    .replace(/\b[pP]\.?\s*\d+\b/g, " ")
    .replace(/[「」『』《》“”"']/g, "")
    .replace(/^[>\s\-—–·•]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function relationSnippetMatches(edge = {}, snippet = "") {
  const text = cleanEvidenceSnippet(snippet);
  if (!text) return false;
  const source = displayName({
    displayNameZh: edge.sourceDisplayNameZh,
    displayNameEn: edge.sourceDisplayNameEn,
    canonicalName: edge.sourceName,
  });
  const target = displayName({
    displayNameZh: edge.targetDisplayNameZh,
    displayNameEn: edge.targetDisplayNameEn,
    canonicalName: edge.targetName,
  });
  const hasEndpoint = [source, target]
    .filter(Boolean)
    .some((name) => text.includes(name));
  const hasSemanticMatch = relationSemanticKeywords(edge).some((keyword) =>
    text.includes(keyword)
  );
  return hasEndpoint && hasSemanticMatch;
}

function relationSummaryLimit(value = "", max = 110) {
  const text = compactText(value, Math.max(max + 20, 140));
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function sourceTargetLabels(edge = {}) {
  const sourceNode = {
    displayNameZh: edge.sourceDisplayNameZh,
    displayNameEn: edge.sourceDisplayNameEn,
    canonicalName: edge.sourceName,
  };
  const targetNode = {
    displayNameZh: edge.targetDisplayNameZh,
    displayNameEn: edge.targetDisplayNameEn,
    canonicalName: edge.targetName,
  };
  return {
    sourceNodeLabel: displayName(sourceNode),
    targetNodeLabel: displayName(targetNode),
  };
}

function buildRelationTitle(edge = {}) {
  const { sourceNodeLabel, targetNodeLabel } = sourceTargetLabels(edge);
  const label = relationDisplayLabel(edge, 18);
  if (!sourceNodeLabel || !targetNodeLabel) return label || "关键关联";
  const connector = CONTRAST_RELATION_TYPES.has(edge.relationType) ? "↔" : "→";
  const suffix =
    CONTRAST_RELATION_TYPES.has(edge.relationType) && label === "对比"
      ? "对比关系"
      : label;
  return `${sourceNodeLabel} ${connector} ${targetNodeLabel}：${suffix}`;
}

function relationSummaryFromSupplement({
  edge = {},
  workspaceSupplements = [],
}) {
  const { sourceNodeLabel, targetNodeLabel } = sourceTargetLabels(edge);
  if (!sourceNodeLabel || !targetNodeLabel) return "";
  const strongKinds = new Set(["timeline", "person_map", "concept_index"]);
  const matched = workspaceSupplements.find((supplement) => {
    if (!strongKinds.has(supplement.supplementKind)) return false;
    const parsed = supplement.metadata?.parsedStructure || {};
    const text = JSON.stringify(parsed);
    return text.includes(sourceNodeLabel) && text.includes(targetNodeLabel);
  });
  if (!matched) return "";
  return `${sourceNodeLabel}与${targetNodeLabel}同时出现在高权重全书补充中，可作为理解${relationTypeLabel(edge)}关系的结构线索。`;
}

function buildRelationSummary({
  edge = {},
  evidenceSnippet = "",
  workspaceSupplements = [],
}) {
  const { sourceNodeLabel, targetNodeLabel } = sourceTargetLabels(edge);
  const evidence = firstSentence(cleanEvidenceSnippet(evidenceSnippet), 110);
  if (evidence && relationSnippetMatches(edge, evidence)) {
    return {
      relationSummary: relationSummaryLimit(evidence),
      summarySource: "edge_evidence",
    };
  }

  const relationLabel = relationDisplayLabel(edge, 36);
  if (relationLabel && sourceNodeLabel && targetNodeLabel) {
    return {
      relationSummary: relationSummaryLimit(
        `${sourceNodeLabel}与${targetNodeLabel}的关系被标注为「${relationLabel}」，可用来理解两者在当前知识结构中的${relationTypeLabel(edge)}脉络。`
      ),
      summarySource: "edge_description",
    };
  }

  const sourceSummary = firstSentence(edge.sourceSummary, 48);
  const targetSummary = firstSentence(edge.targetSummary, 48);
  if ((sourceSummary || targetSummary) && sourceNodeLabel && targetNodeLabel) {
    return {
      relationSummary: relationSummaryLimit(
        `${sourceNodeLabel}侧重${sourceSummary || "相关问题"}，${targetNodeLabel}侧重${targetSummary || "相邻主题"}，两者构成${relationTypeLabel(edge)}关系。`
      ),
      summarySource: "node_summary",
    };
  }

  const supplementSummary = relationSummaryFromSupplement({
    edge,
    workspaceSupplements,
  });
  if (supplementSummary) {
    return {
      relationSummary: relationSummaryLimit(supplementSummary),
      summarySource: "supplement",
    };
  }

  return {
    relationSummary: relationSummaryLimit(
      `${sourceNodeLabel || "起点节点"}与${targetNodeLabel || "终点节点"}通过${relationTypeLabel(edge)}关系连接，适合查看证据来确认这条关联在当前主题中的作用。`
    ),
    summarySource: "template",
  };
}

function isHighConfidencePathRecommendation(recommendation = {}, edge = {}) {
  if (recommendation.type !== "continue_path") return false;
  if (recommendation.target?.edgeId) return false;
  const confidence = Number(edge.confidence || 0);
  const weight = Number(edge.weight || 0);
  const pathType = recommendation.target?.pathType;
  return (
    (pathType && MAIN_AXIS_PATH_TYPES.has(pathType)) ||
    confidence >= 0.78 ||
    weight >= 3
  );
}

function buildPathSummary({ edge = {}, relatedLabels = [] }) {
  const { sourceNodeLabel, targetNodeLabel } = sourceTargetLabels(edge);
  const middle = relatedLabels.find(
    (label) => label && label !== sourceNodeLabel && label !== targetNodeLabel
  );
  const nodes = [sourceNodeLabel, middle, targetNodeLabel].filter(Boolean);
  if (nodes.length < 2) return "";
  return nodes.slice(0, 3).join(" → ");
}

function buildRelationNextAction({ cardType, edge = {}, pathSummary = "" }) {
  const { sourceNodeLabel, targetNodeLabel } = sourceTargetLabels(edge);
  if (cardType === "path" && pathSummary)
    return `沿“${pathSummary}”查看证据，梳理这条路径如何推进当前主线。`;
  if (Number(edge.evidenceCount || 0) > 0)
    return `查看${sourceNodeLabel || "起点"}与${targetNodeLabel || "终点"}的证据片段，确认这条${relationTypeLabel(edge)}关系。`;
  return `先补充或核对原文证据，再判断这条${relationTypeLabel(edge)}关系是否稳定。`;
}

function recommendationId({ workspaceId, type, targetType, targetId }) {
  return crypto
    .createHash("sha256")
    .update(
      [
        type || "",
        targetType || "",
        targetId || "",
        String(workspaceId || ""),
        FORMULA_VERSION,
      ].join("|")
    )
    .digest("hex");
}

function canonicalText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function optionalQuery(query, ...params) {
  try {
    return await workspaceOverviewDb.$queryRawUnsafe(query, ...params);
  } catch (error) {
    if (process.env.NODE_ENV === "development")
      console.warn("[WorkspaceOverview] optional query failed:", error.message);
    return [];
  }
}

function overviewCacheKey({ workspaceId, userId = 0, threadSlug = null }) {
  return [workspaceId, userId || 0, threadSlug || "default"].join(":");
}

function invalidateWorkspaceOverviewCache({ workspaceId, userId = null } = {}) {
  if (!workspaceId) return;
  const prefix =
    userId === null || userId === undefined
      ? `${workspaceId}:`
      : `${workspaceId}:${userId || 0}:`;
  for (const key of overviewCache.keys()) {
    if (key.startsWith(prefix)) overviewCache.delete(key);
  }
  for (const key of overviewFocusState.keys()) {
    if (key.startsWith(prefix)) overviewFocusState.delete(key);
  }
}

function focusCandidates(recommendations = []) {
  return recommendations
    .filter((item) => CURRENT_FOCUS_CATEGORIES.has(item.category))
    .sort((a, b) => focusRankScore(b) - focusRankScore(a));
}

function focusRankScore(item = {}) {
  return Number(item.score || 0) + (item.hasSupplement ? 3 : 0);
}

function selectStableCurrentFocus({
  candidates = [],
  previousState = null,
  now = Date.now(),
  minDwellMs = CURRENT_FOCUS_MIN_DWELL_MS,
  switchThreshold = CURRENT_FOCUS_SWITCH_THRESHOLD,
} = {}) {
  const eligible = focusCandidates(candidates);
  if (eligible.length === 0) return { focus: [], state: null };

  const best = eligible[0];
  const previousId = previousState?.recommendationId;
  const previous = previousId
    ? eligible.find((item) => item.recommendationId === previousId)
    : null;

  if (!previous) {
    return {
      focus: eligible.slice(0, 3),
      state: {
        recommendationId: best.recommendationId,
        selectedAt: now,
      },
    };
  }

  const selectedAt = Number(previousState.selectedAt || now);
  const withinDwell = now - selectedAt < minDwellMs;
  const bestLeadsBy = focusRankScore(best) - focusRankScore(previous);
  const shouldKeepPrevious =
    best.recommendationId === previous.recommendationId ||
    (withinDwell && bestLeadsBy < switchThreshold);
  const selected = shouldKeepPrevious ? previous : best;
  const rest = eligible.filter(
    (item) => item.recommendationId !== selected.recommendationId
  );

  return {
    focus: [selected, ...rest].slice(0, 3),
    state: {
      recommendationId: selected.recommendationId,
      selectedAt: shouldKeepPrevious ? selectedAt : now,
    },
  };
}

function buildCurrentFocusDetail({ focus = null, nodeBackground = null } = {}) {
  if (!focus) return null;
  const target = focus.target || {};
  const displayName =
    target.displayName || target.concept || focus.title || "当前研究焦点";
  const knowledgeBits = [
    focus.mainlinePath,
    focus.whyRecommended,
    focus.nextAction,
  ].filter(Boolean);
  return {
    recommendationId: focus.recommendationId,
    title: focus.title,
    displayName,
    nodeKey: target.nodeKey || null,
    nodeId: target.nodeId || target.targetId || null,
    nodeType: target.nodeType || target.targetType || null,
    nodeTypeLabel: focus.nodeTypeLabel || nodeTypeLabel(target.nodeType),
    summary: focus.nodeSummary || focus.relationSummary || "",
    mainlinePath: focus.mainlinePath || focus.pathSummary || "",
    whyRecommended: focus.whyRecommended || "",
    nextAction: focus.nextAction || "",
    evidenceCount: Number(focus.evidenceCount || 0),
    relationCount: Number(focus.relationCount || 0),
    supplementCount: Number(
      focus.supplementCount || target.supplementCount || 0
    ),
    knowledgeBits,
    backgroundImageUrl: nodeBackground?.url || null,
    backgroundAsset: nodeBackground || null,
    backgroundSource: nodeBackground ? "node" : "default",
  };
}

async function getNodes(workspaceId) {
  const rows = await optionalQuery(
    `SELECT
      n."id", n."canonicalName", n."canonicalKey", n."displayNameZh", n."displayNameEn",
      n."aliases", n."entityType", n."summary",
      n."workspaceImportanceScore", n."recentImportanceScore",
      n."usageCount", n."recentUsageCount", n."lastReferencedAt",
      n."createdAt", n."updatedAt",
      COALESCE(m."evidenceStrength", 0) AS "evidenceStrength",
      COALESCE(m."bridgeValue", 0) AS "bridgeValue",
      COALESCE(m."traversalImportance", 0) AS "traversalImportance",
      COALESCE(m."conflictSafety", 100) AS "conflictSafety",
      COALESCE(m."warning", '') AS "metricsWarning",
      COALESCE(edge_stats."edgeCount", 0) AS "edgeCount",
      COALESCE(edge_stats."relationTypeCount", 0) AS "relationTypeCount",
      COALESCE(evidence_stats."evidenceCount", 0) AS "evidenceCount",
      COALESCE(evidence_stats."documentCount", 0) AS "documentCount",
      COALESCE(evidence_stats."recentEvidenceCount", 0) AS "recentEvidenceCount",
      COALESCE(map_stats."chunkCount", 0) AS "chunkCount"
    FROM "KnowledgeNode" n
    LEFT JOIN "KnowledgeNodeMetrics" m
      ON m."workspaceId" = n."workspaceId" AND m."nodeId" = n."id"
    LEFT JOIN (
      SELECT "workspaceId", "nodeId", COUNT(*) AS "edgeCount",
        COUNT(DISTINCT "relationType") AS "relationTypeCount"
      FROM (
        SELECT "workspaceId", "sourceNodeId" AS "nodeId", "relationType"
        FROM "KnowledgeEdge"
        UNION ALL
        SELECT "workspaceId", "targetNodeId" AS "nodeId", "relationType"
        FROM "KnowledgeEdge"
      ) relation_nodes
      GROUP BY "workspaceId", "nodeId"
    ) edge_stats ON edge_stats."workspaceId" = n."workspaceId"
      AND edge_stats."nodeId" = n."id"
    LEFT JOIN (
      SELECT e."workspaceId", x."nodeId",
        COUNT(ev."id") AS "evidenceCount",
        COUNT(DISTINCT ev."documentId") AS "documentCount",
        SUM(CASE WHEN ev."createdAt" >= ? THEN 1 ELSE 0 END) AS "recentEvidenceCount"
      FROM "KnowledgeEdge" e
      JOIN (
        SELECT "id", "sourceNodeId" AS "nodeId" FROM "KnowledgeEdge"
        UNION ALL
        SELECT "id", "targetNodeId" AS "nodeId" FROM "KnowledgeEdge"
      ) x ON x."id" = e."id"
      LEFT JOIN "EdgeEvidence" ev ON ev."edgeId" = e."id"
      GROUP BY e."workspaceId", x."nodeId"
    ) evidence_stats ON evidence_stats."workspaceId" = n."workspaceId"
      AND evidence_stats."nodeId" = n."id"
    LEFT JOIN (
      SELECT "workspaceId", "nodeId", COUNT(DISTINCT "chunkId") AS "chunkCount"
      FROM "ConceptChunkMap"
      GROUP BY "workspaceId", "nodeId"
    ) map_stats ON map_stats."workspaceId" = n."workspaceId"
      AND map_stats."nodeId" = n."id"
    WHERE n."workspaceId" = ?
    ORDER BY (n."recentImportanceScore" * 0.55 + n."workspaceImportanceScore" * 0.45) DESC
    LIMIT 200`,
    new Date(Date.now() - 7 * 24 * 60 * 60_000),
    Number(workspaceId)
  );

  return rows.map((row) => ({
    ...row,
    nodeKey: buildNodeKey(row.entityType, row.canonicalKey),
    aliases: safeJsonParse(row.aliases, []),
    workspaceImportanceScore: Number(row.workspaceImportanceScore || 0),
    recentImportanceScore: Number(row.recentImportanceScore || 0),
    usageCount: Number(row.usageCount || 0),
    recentUsageCount: Number(row.recentUsageCount || 0),
    evidenceStrength: Number(row.evidenceStrength || 0),
    bridgeValue: Number(row.bridgeValue || 0),
    traversalImportance: Number(row.traversalImportance || 0),
    conflictSafety: Number(row.conflictSafety ?? 100),
    edgeCount: Number(row.edgeCount || 0),
    relationTypeCount: Number(row.relationTypeCount || 0),
    evidenceCount: Number(row.evidenceCount || 0),
    documentCount: Number(row.documentCount || 0),
    recentEvidenceCount: Number(row.recentEvidenceCount || 0),
    chunkCount: Number(row.chunkCount || 0),
  }));
}

async function getUsage(workspaceId) {
  const rows = await optionalQuery(
    `SELECT * FROM "KnowledgeGraphEvidenceUsage"
    WHERE "workspaceId" = ?
    ORDER BY "lastUsedAt" DESC LIMIT 200`,
    Number(workspaceId)
  );
  return rows.map((row) => ({
    ...row,
    count: Number(row.count || 0),
    decayedScore: Number(row.count || 0) * decay(row.lastUsedAt, 7),
  }));
}

async function getRecentEdges(workspaceId) {
  const rows = await optionalQuery(
    `SELECT e."id", e."relationType", e."relationLabel", e."relationLabelZh",
      e."confidence", e."weight", e."createdAt", e."updatedAt",
      s."id" AS "sourceNodeId", s."canonicalName" AS "sourceName",
      s."displayNameZh" AS "sourceNameZh", s."displayNameEn" AS "sourceNameEn",
      t."id" AS "targetNodeId", t."canonicalName" AS "targetName",
      t."displayNameZh" AS "targetNameZh", t."displayNameEn" AS "targetNameEn",
      COUNT(ev."id") AS "evidenceCount"
    FROM "KnowledgeEdge" e
    JOIN "KnowledgeNode" s ON s."id" = e."sourceNodeId"
    JOIN "KnowledgeNode" t ON t."id" = e."targetNodeId"
    LEFT JOIN "EdgeEvidence" ev ON ev."edgeId" = e."id"
    WHERE e."workspaceId" = ?
    GROUP BY e."id"
    ORDER BY e."createdAt" DESC, e."confidence" DESC
    LIMIT 50`,
    Number(workspaceId)
  );
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
    sourceNodeId: Number(row.sourceNodeId),
    targetNodeId: Number(row.targetNodeId),
    confidence: Number(row.confidence || 0),
    weight: Number(row.weight || 0),
    evidenceCount: Number(row.evidenceCount || 0),
  }));
}

async function getRecentDocuments(workspaceId) {
  return await optionalQuery(
    `SELECT "id", "docId", "filename", "docpath", "embeddingStatus",
      "createdAt", "lastUpdatedAt"
    FROM "workspace_documents"
    WHERE "workspaceId" = ?
    ORDER BY "lastUpdatedAt" DESC LIMIT 12`,
    Number(workspaceId)
  );
}

async function getRecentChats(workspaceId, userId = 0, threadSlug = null) {
  const threadRows = threadSlug
    ? await optionalQuery(
        `SELECT "id", "slug", "name" FROM "workspace_threads"
        WHERE "workspace_id" = ? AND "slug" = ? LIMIT 1`,
        Number(workspaceId),
        String(threadSlug)
      )
    : [];
  const threadId = threadRows?.[0]?.id || null;
  const params = [Number(workspaceId)];
  let userClause = "";
  if (userId) {
    userClause = `AND ("user_id" = ? OR "user_id" IS NULL)`;
    params.push(Number(userId));
  }
  let threadClause = "";
  if (threadId) {
    threadClause = `AND "thread_id" = ?`;
    params.push(Number(threadId));
  }
  const rows = await optionalQuery(
    `SELECT "id", "prompt", "response", "thread_id", "createdAt", "lastUpdatedAt"
    FROM "workspace_chats"
    WHERE "workspaceId" = ? AND "include" = TRUE ${userClause} ${threadClause}
    ORDER BY "lastUpdatedAt" DESC LIMIT 20`,
    ...params
  );
  return {
    chats: await decryptWorkspaceChatRecordsAsync(rows),
    activeThread: threadRows?.[0] || null,
  };
}

async function getActivity(workspaceId) {
  const [jobs, repairRuns, metricRuns] = await Promise.all([
    optionalQuery(
      `SELECT "status", "documentId", "chunkId", "updatedAt", "errorMessage"
      FROM "GraphExtractionJob"
      WHERE "workspaceId" = ? ORDER BY "updatedAt" DESC LIMIT 8`,
      Number(workspaceId)
    ),
    optionalQuery(
      `SELECT "repaired", "failed", "skipped", "durationMs", "createdAt"
      FROM "KnowledgeGraphRepairRun"
      WHERE "workspaceId" = ? ORDER BY "createdAt" DESC LIMIT 4`,
      Number(workspaceId)
    ),
    optionalQuery(
      `SELECT "trigger", "processed", "succeeded", "failed", "durationMs", "createdAt"
      FROM "KnowledgeNodeMetricsRecomputeRun"
      WHERE "workspaceId" = ? ORDER BY "createdAt" DESC LIMIT 4`,
      Number(workspaceId)
    ),
  ]);
  return [
    ...jobs.map((job) => ({
      type: "kg",
      title:
        job.status === "completed"
          ? "完成 KG extraction"
          : "KG extraction 更新",
      detail: `${job.documentId || "未知文档"} / ${job.chunkId || "未知 chunk"}`,
      severity: job.status === "failed" ? "critical" : "info",
      createdAt: job.updatedAt,
    })),
    ...repairRuns.map((run) => ({
      type: "repair",
      title: "Graph repair 巡检",
      detail: `修复 ${run.repaired || 0} 个，失败 ${run.failed || 0} 个`,
      severity: Number(run.failed || 0) > 0 ? "warning" : "info",
      createdAt: run.createdAt,
    })),
    ...metricRuns.map((run) => ({
      type: "metrics",
      title: "重新计算 node metrics",
      detail: `处理 ${run.processed || 0} 个，成功 ${run.succeeded || 0} 个`,
      severity: Number(run.failed || 0) > 0 ? "warning" : "info",
      createdAt: run.createdAt,
    })),
  ]
    .filter((item) => item.createdAt)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10);
}

async function getFeedback(workspaceId, userId = 0) {
  const rows = await optionalQuery(
    `SELECT "id", "workspaceId", "userId", "recommendationId", "type",
      "targetType", "targetId", "formulaVersion", "impressionCount",
      "clickCount", "dismissCount", "continueCount",
      CAST("lastShownAt" AS TEXT) AS "lastShownAt",
      CAST("lastInteractedAt" AS TEXT) AS "lastInteractedAt",
      CAST("cooldownUntil" AS TEXT) AS "cooldownUntil",
      "metadata", CAST("createdAt" AS TEXT) AS "createdAt",
      CAST("updatedAt" AS TEXT) AS "updatedAt"
    FROM "WorkspaceOverviewRecommendationUsage"
    WHERE "workspaceId" = ? AND "userId" = ?`,
    Number(workspaceId),
    Number(userId || 0)
  );
  const map = new Map();
  rows.forEach((row) => {
    map.set(row.recommendationId, {
      ...row,
      metadata: safeJsonParse(row.metadata, {}),
      impressionCount: Number(row.impressionCount || 0),
      clickCount: Number(row.clickCount || 0),
      dismissCount: Number(row.dismissCount || 0),
      continueCount: Number(row.continueCount || 0),
    });
  });
  return map;
}

function nodeTarget(node) {
  return {
    targetType: "concept",
    targetId: String(node.id),
    nodeId: node.id,
    nodeKey: node.nodeKey || null,
    canonicalKey: node.canonicalKey || null,
    nodeType: node.entityType || "concept",
    concept: node.canonicalName,
    displayName: displayName(node),
    hasSupplement: Boolean(node.hasSupplement),
    supplementCount: Number(node.supplementCount || 0),
    supplementTitles: node.supplementTitles || [],
    supplementDocumentIds: node.supplementDocumentIds || [],
  };
}

function attachNodeSupplements(nodes = [], supplementsByNodeKey = new Map()) {
  return nodes.map((node) => {
    const supplements = node.nodeKey
      ? supplementsByNodeKey.get(node.nodeKey) || []
      : [];
    return {
      ...node,
      hasSupplement: supplements.length > 0,
      supplementCount: supplements.length,
      supplementTitles: supplements
        .map((item) => item.documentName)
        .slice(0, 5),
      supplementDocumentIds: supplements
        .map((item) => item.documentId)
        .slice(0, 12),
    };
  });
}

function nodeIdFromRecommendation(recommendation = {}) {
  const target = recommendation.target || {};
  if (
    target.nodeId !== undefined &&
    target.nodeId !== null &&
    String(target.nodeId).trim() !== "" &&
    Number.isFinite(Number(target.nodeId))
  )
    return Number(target.nodeId);
  if (
    NODE_TARGET_TYPES.has(target.targetType) &&
    target.targetId !== undefined &&
    target.targetId !== null &&
    String(target.targetId).trim() !== "" &&
    Number.isFinite(Number(target.targetId))
  )
    return Number(target.targetId);
  return null;
}

function collectHydrationNodeIds(recommendations = []) {
  return [
    ...new Set(
      recommendations
        .map(nodeIdFromRecommendation)
        .filter((id) => id !== null && Number.isFinite(Number(id)))
        .map(Number)
    ),
  ];
}

function edgeIdFromRecommendation(recommendation = {}) {
  const target = recommendation.target || {};
  if (
    target.edgeId !== undefined &&
    target.edgeId !== null &&
    Number.isFinite(Number(target.edgeId))
  )
    return Number(target.edgeId);
  const ref = (recommendation.refs || []).find(
    (item) => item?.type === "edge" && Number.isFinite(Number(item.id))
  );
  if (ref) return Number(ref.id);
  const pathId = String(target.targetId || "");
  const pathMatch = pathId.match(/^path-\d+-(\d+)$/);
  if (pathMatch) return Number(pathMatch[1]);
  return null;
}

function collectHydrationEdgeIds(recommendations = []) {
  return [
    ...new Set(
      recommendations
        .map(edgeIdFromRecommendation)
        .filter((id) => id !== null && Number.isFinite(Number(id)))
        .map(Number)
    ),
  ];
}

function placeholders(values = []) {
  return values.map(() => "?").join(",");
}

function buildNodeSummary({ node, evidenceSnippet = "", neighbors = [] }) {
  if (!node) return "";
  const name = displayName(node);
  const typeLabel = nodeTypeLabel(node.entityType);
  const summary = firstSentence(node.summary, 120);
  if (summary) return summary;

  const evidence = firstSentence(evidenceSnippet, 120);
  if (evidence) return `${name}：${evidence}`;

  const neighborNames = neighbors
    .map((item) => item.neighborName)
    .filter(Boolean)
    .slice(0, 3);
  if (neighborNames.length)
    return `${name}是当前知识图谱中的${typeLabel}节点，重点关联 ${neighborNames.join("、")}。`;

  return `${name}是当前工作区知识图谱中的${typeLabel}节点。`;
}

function buildMainlinePath({ node, neighbors = [] }) {
  if (!node || neighbors.length === 0) return "";
  const names = [
    displayName(node),
    ...neighbors.map((item) => item.neighborName).filter(Boolean),
  ].slice(0, 3);
  if (names.length < 2) return "";
  return `主线关联：${names.join(" → ")}`;
}

function buildWhyRecommended({
  recommendation = {},
  node,
  neighbors = [],
  learningState,
}) {
  const typeLabel = nodeTypeLabel(node?.entityType);
  const hasSupplement =
    Number(recommendation.supplementCount || node?.supplementCount || 0) > 0;
  const hasPath = neighbors.length > 0;
  if (recommendation.type === "repair_node")
    return `该${typeLabel}存在学习薄弱信号，适合优先修复。`;
  if (recommendation.type === "deep_dive_node" || hasSupplement)
    return `该${typeLabel}已有补充资料，可进入证据层深挖。`;
  if (recommendation.type === "review_node" || learningState?.viewedCount > 0)
    return hasPath
      ? `该${typeLabel}处在当前主线的高关联区域，适合继续巩固。`
      : `该${typeLabel}已有学习记录，适合复习并补齐关键证据。`;
  if (recommendation.category === "gap")
    return `该${typeLabel}的结构价值较高，适合补齐证据和定义。`;
  if (recommendation.category === "focus")
    return `该${typeLabel}在工作区知识结构中连接了多个关键主题。`;
  if (recommendation.category === "continue")
    return `该${typeLabel}适合沿当前知识路径继续推进。`;
  return `该${typeLabel}在当前知识图谱中具有继续整理价值。`;
}

function buildNextAction({ recommendation = {}, node, mainlinePath = "" }) {
  const typeLabel = nodeTypeLabel(node?.entityType);
  const hasSupplement =
    Number(recommendation.supplementCount || node?.supplementCount || 0) > 0;
  const evidenceCount = Number(
    recommendation.evidenceCount || node?.evidenceCount || 0
  );
  if (mainlinePath)
    return `沿“${mainlinePath.replace(/^主线关联：/, "")}”查看原文证据，并整理一句节点总结。`;
  if (hasSupplement) return "先阅读补充资料，再生成节点测试或对比相邻节点。";
  if (evidenceCount <= 2)
    return `补充或核对原文证据，确认该${typeLabel}的关键定义。`;
  return `查看证据片段，梳理该${typeLabel}的核心含义和相邻关系。`;
}

function buildRecommendationDisplayFields({
  recommendation = {},
  node,
  neighbors = [],
  evidenceSnippet = "",
  evidenceCount = 0,
  relationCount = 0,
  chunkCount = 0,
  supplementCount = 0,
  learningState = null,
}) {
  if (!node) return {};
  const sortedNeighbors = [...neighbors]
    .sort(
      (a, b) =>
        Number(b.confidence || 0) - Number(a.confidence || 0) ||
        Number(b.weight || 0) - Number(a.weight || 0)
    )
    .slice(0, 3);
  const mainlinePath = buildMainlinePath({ node, neighbors: sortedNeighbors });
  const visibleEvidenceCount = Math.max(
    Number(evidenceCount || 0),
    Number(chunkCount || 0)
  );
  const fields = {
    nodeSummary: buildNodeSummary({
      node,
      evidenceSnippet,
      neighbors: sortedNeighbors,
    }),
    mainlinePath,
    whyRecommended: buildWhyRecommended({
      recommendation,
      node,
      neighbors: sortedNeighbors,
      learningState,
    }),
    nextAction: buildNextAction({ recommendation, node, mainlinePath }),
    nodeTypeLabel: nodeTypeLabel(node.entityType),
  };
  if (visibleEvidenceCount > 0) fields.evidenceCount = visibleEvidenceCount;
  if (Number(relationCount || 0) > 0)
    fields.relationCount = Number(relationCount);
  if (Number(supplementCount || 0) > 0)
    fields.supplementCount = Number(supplementCount);
  return fields;
}

async function hydrateRecommendationCards({
  workspaceId,
  userId = 0,
  recommendations = [],
  workspaceSupplements = [],
}) {
  const nodeIds = collectHydrationNodeIds(recommendations);
  const edgeIds = collectHydrationEdgeIds(recommendations);
  if (!nodeIds.length && !edgeIds.length) return recommendations;

  try {
    const nodeRows = nodeIds.length
      ? await workspaceOverviewDb.$queryRawUnsafe(
          `SELECT "id", "canonicalName", "canonicalKey", "displayNameZh",
            "displayNameEn", "entityType", "summary"
          FROM "KnowledgeNode"
          WHERE "workspaceId" = ? AND "id" IN (${placeholders(nodeIds)})`,
          Number(workspaceId),
          ...nodeIds
        )
      : [];
    const nodesById = new Map(
      nodeRows.map((row) => [
        Number(row.id),
        {
          ...row,
          id: Number(row.id),
          nodeKey: buildNodeKey(row.entityType || "concept", row.canonicalKey),
        },
      ])
    );
    const nodeKeys = [...nodesById.values()].map((node) => node.nodeKey);

    const [
      relationCounts,
      relationRows,
      evidenceCounts,
      evidenceSnippets,
      chunkCounts,
      supplementCounts,
      learningRows,
    ] = await Promise.all([
      nodeIds.length
        ? workspaceOverviewDb.$queryRawUnsafe(
            `SELECT "nodeId", COUNT(*) AS "relationCount"
        FROM (
          SELECT "sourceNodeId" AS "nodeId" FROM "KnowledgeEdge"
          WHERE "workspaceId" = ?
          UNION ALL
          SELECT "targetNodeId" AS "nodeId" FROM "KnowledgeEdge"
          WHERE "workspaceId" = ?
        ) edge_nodes
        WHERE "nodeId" IN (${placeholders(nodeIds)})
        GROUP BY "nodeId"`,
            Number(workspaceId),
            Number(workspaceId),
            ...nodeIds
          )
        : [],
      nodeIds.length
        ? workspaceOverviewDb.$queryRawUnsafe(
            `SELECT e."sourceNodeId", e."targetNodeId", e."confidence", e."weight",
          s."canonicalName" AS "sourceName",
          s."displayNameZh" AS "sourceDisplayNameZh",
          s."displayNameEn" AS "sourceDisplayNameEn",
          t."canonicalName" AS "targetName",
          t."displayNameZh" AS "targetDisplayNameZh",
          t."displayNameEn" AS "targetDisplayNameEn"
        FROM "KnowledgeEdge" e
        JOIN "KnowledgeNode" s ON s."id" = e."sourceNodeId"
        JOIN "KnowledgeNode" t ON t."id" = e."targetNodeId"
        WHERE e."workspaceId" = ?
          AND (e."sourceNodeId" IN (${placeholders(nodeIds)})
            OR e."targetNodeId" IN (${placeholders(nodeIds)}))
        ORDER BY e."confidence" DESC, e."weight" DESC
        LIMIT ?`,
            Number(workspaceId),
            ...nodeIds,
            ...nodeIds,
            Math.max(30, nodeIds.length * 8)
          )
        : [],
      nodeIds.length
        ? workspaceOverviewDb.$queryRawUnsafe(
            `SELECT x."nodeId", COUNT(ev."id") AS "evidenceCount"
        FROM "KnowledgeEdge" e
        JOIN (
          SELECT "id", "sourceNodeId" AS "nodeId" FROM "KnowledgeEdge"
          UNION ALL
          SELECT "id", "targetNodeId" AS "nodeId" FROM "KnowledgeEdge"
        ) x ON x."id" = e."id"
        LEFT JOIN "EdgeEvidence" ev ON ev."edgeId" = e."id"
        WHERE e."workspaceId" = ? AND x."nodeId" IN (${placeholders(nodeIds)})
        GROUP BY x."nodeId"`,
            Number(workspaceId),
            ...nodeIds
          )
        : [],
      nodeIds.length
        ? workspaceOverviewDb.$queryRawUnsafe(
            `SELECT x."nodeId", ev."snippet", ev."confidence", ev."createdAt"
        FROM "KnowledgeEdge" e
        JOIN (
          SELECT "id", "sourceNodeId" AS "nodeId" FROM "KnowledgeEdge"
          UNION ALL
          SELECT "id", "targetNodeId" AS "nodeId" FROM "KnowledgeEdge"
        ) x ON x."id" = e."id"
        JOIN "EdgeEvidence" ev ON ev."edgeId" = e."id"
        WHERE e."workspaceId" = ?
          AND x."nodeId" IN (${placeholders(nodeIds)})
          AND ev."snippet" IS NOT NULL
          AND trim(ev."snippet") != ''
        ORDER BY ev."confidence" DESC, ev."createdAt" DESC
        LIMIT ?`,
            Number(workspaceId),
            ...nodeIds,
            Math.max(20, nodeIds.length * 4)
          )
        : [],
      nodeIds.length
        ? workspaceOverviewDb.$queryRawUnsafe(
            `SELECT "nodeId", COUNT(DISTINCT "chunkId") AS "chunkCount"
        FROM "ConceptChunkMap"
        WHERE "workspaceId" = ? AND "nodeId" IN (${placeholders(nodeIds)})
        GROUP BY "nodeId"`,
            Number(workspaceId),
            ...nodeIds
          )
        : [],
      nodeKeys.length
        ? workspaceOverviewDb.$queryRawUnsafe(
            `SELECT "nodeKey", COUNT(*) AS "supplementCount"
            FROM "NodeSupplement"
            WHERE "workspaceId" = ? AND "nodeKey" IN (${placeholders(nodeKeys)})
            GROUP BY "nodeKey"`,
            Number(workspaceId),
            ...nodeKeys
          )
        : [],
      nodeKeys.length
        ? workspaceOverviewDb.$queryRawUnsafe(
            `SELECT * FROM "NodeLearningState"
            WHERE "workspaceId" = ? AND "userId" = ?
              AND "nodeKey" IN (${placeholders(nodeKeys)})`,
            Number(workspaceId),
            Number(userId || 0),
            ...nodeKeys
          )
        : [],
    ]);

    const relationDisplayByEdgeId = new Map();
    if (edgeIds.length) {
      const edgeRows = await workspaceOverviewDb.$queryRawUnsafe(
        `SELECT e."id", e."sourceNodeId", e."targetNodeId",
          e."relationType", e."relationLabel", e."relationLabelZh",
          e."confidence", e."weight",
          s."canonicalName" AS "sourceName",
          s."displayNameZh" AS "sourceDisplayNameZh",
          s."displayNameEn" AS "sourceDisplayNameEn",
          s."summary" AS "sourceSummary",
          t."canonicalName" AS "targetName",
          t."displayNameZh" AS "targetDisplayNameZh",
          t."displayNameEn" AS "targetDisplayNameEn",
          t."summary" AS "targetSummary"
        FROM "KnowledgeEdge" e
        JOIN "KnowledgeNode" s ON s."id" = e."sourceNodeId"
        JOIN "KnowledgeNode" t ON t."id" = e."targetNodeId"
        WHERE e."workspaceId" = ? AND e."id" IN (${placeholders(edgeIds)})`,
        Number(workspaceId),
        ...edgeIds
      );
      const [edgeEvidenceCounts, edgeEvidenceSnippets] = await Promise.all([
        workspaceOverviewDb.$queryRawUnsafe(
          `SELECT "edgeId", COUNT(*) AS "evidenceCount"
          FROM "EdgeEvidence"
          WHERE "workspaceId" = ? AND "edgeId" IN (${placeholders(edgeIds)})
          GROUP BY "edgeId"`,
          Number(workspaceId),
          ...edgeIds
        ),
        workspaceOverviewDb.$queryRawUnsafe(
          `SELECT "edgeId", "snippet", "confidence", "createdAt"
          FROM "EdgeEvidence"
          WHERE "workspaceId" = ?
            AND "edgeId" IN (${placeholders(edgeIds)})
            AND "snippet" IS NOT NULL
            AND trim("snippet") != ''
          ORDER BY "confidence" DESC, "createdAt" DESC
          LIMIT ?`,
          Number(workspaceId),
          ...edgeIds,
          Math.max(20, edgeIds.length * 4)
        ),
      ]);
      const evidenceCountByEdge = new Map(
        edgeEvidenceCounts.map((row) => [
          Number(row.edgeId),
          Number(row.evidenceCount || 0),
        ])
      );
      const snippetByEdge = new Map();
      for (const row of edgeEvidenceSnippets) {
        const id = Number(row.edgeId);
        if (!snippetByEdge.has(id)) snippetByEdge.set(id, row.snippet);
      }
      const endpointIds = [
        ...new Set(
          edgeRows
            .flatMap((row) => [
              Number(row.sourceNodeId),
              Number(row.targetNodeId),
            ])
            .filter((id) => Number.isFinite(id))
        ),
      ];
      const endpointNeighborRows = endpointIds.length
        ? await workspaceOverviewDb.$queryRawUnsafe(
            `SELECT e."sourceNodeId", e."targetNodeId", e."confidence", e."weight",
              s."displayNameZh" AS "sourceDisplayNameZh",
              s."displayNameEn" AS "sourceDisplayNameEn",
              s."canonicalName" AS "sourceName",
              t."displayNameZh" AS "targetDisplayNameZh",
              t."displayNameEn" AS "targetDisplayNameEn",
              t."canonicalName" AS "targetName"
            FROM "KnowledgeEdge" e
            JOIN "KnowledgeNode" s ON s."id" = e."sourceNodeId"
            JOIN "KnowledgeNode" t ON t."id" = e."targetNodeId"
            WHERE e."workspaceId" = ?
              AND (e."sourceNodeId" IN (${placeholders(endpointIds)})
                OR e."targetNodeId" IN (${placeholders(endpointIds)}))
            ORDER BY e."confidence" DESC, e."weight" DESC
            LIMIT ?`,
            Number(workspaceId),
            ...endpointIds,
            ...endpointIds,
            Math.max(40, endpointIds.length * 8)
          )
        : [];
      const neighborLabelsByEndpoint = new Map();
      for (const row of endpointNeighborRows) {
        for (const id of [Number(row.sourceNodeId), Number(row.targetNodeId)]) {
          if (!endpointIds.includes(id)) continue;
          const isSource = Number(row.sourceNodeId) === id;
          const neighborId = isSource
            ? Number(row.targetNodeId)
            : Number(row.sourceNodeId);
          const neighborLabel =
            (isSource ? row.targetDisplayNameZh : row.sourceDisplayNameZh) ||
            (isSource ? row.targetDisplayNameEn : row.sourceDisplayNameEn) ||
            (isSource ? row.targetName : row.sourceName);
          if (!neighborLabelsByEndpoint.has(id))
            neighborLabelsByEndpoint.set(id, new Map());
          if (neighborLabel)
            neighborLabelsByEndpoint.get(id).set(neighborId, neighborLabel);
        }
      }

      for (const row of edgeRows) {
        const edge = {
          ...row,
          id: Number(row.id),
          sourceNodeId: Number(row.sourceNodeId),
          targetNodeId: Number(row.targetNodeId),
          confidence: Number(row.confidence || 0),
          weight: Number(row.weight || 0),
          evidenceCount: evidenceCountByEdge.get(Number(row.id)) || 0,
        };
        const sourceNeighbors =
          neighborLabelsByEndpoint.get(edge.sourceNodeId) || new Map();
        const targetNeighbors =
          neighborLabelsByEndpoint.get(edge.targetNodeId) || new Map();
        const relatedLabels = [
          ...new Set([
            ...sourceNeighbors.values(),
            ...targetNeighbors.values(),
          ]),
        ].filter((label) => {
          const { sourceNodeLabel, targetNodeLabel } = sourceTargetLabels(edge);
          return (
            label && label !== sourceNodeLabel && label !== targetNodeLabel
          );
        });
        const summary = buildRelationSummary({
          edge,
          evidenceSnippet: snippetByEdge.get(edge.id) || "",
          workspaceSupplements,
        });
        relationDisplayByEdgeId.set(edge.id, {
          ...sourceTargetLabels(edge),
          relationTypeLabel: relationTypeLabel(edge),
          relationTitle: buildRelationTitle(edge),
          ...summary,
          pathSummary: buildPathSummary({ edge, relatedLabels }),
          evidenceCount:
            edge.evidenceCount > 0 ? edge.evidenceCount : undefined,
          relatedNodeCount:
            relatedLabels.length > 0 ? relatedLabels.length : undefined,
          _edge: edge,
        });
      }
    }

    const relationCountByNode = new Map(
      relationCounts.map((row) => [
        Number(row.nodeId),
        Number(row.relationCount || 0),
      ])
    );
    const evidenceCountByNode = new Map(
      evidenceCounts.map((row) => [
        Number(row.nodeId),
        Number(row.evidenceCount || 0),
      ])
    );
    const chunkCountByNode = new Map(
      chunkCounts.map((row) => [
        Number(row.nodeId),
        Number(row.chunkCount || 0),
      ])
    );
    const supplementCountByNodeKey = new Map(
      supplementCounts.map((row) => [
        row.nodeKey,
        Number(row.supplementCount || 0),
      ])
    );
    const learningByNodeKey = new Map(
      learningRows.map((row) => [row.nodeKey, row])
    );
    const snippetsByNode = new Map();
    for (const row of evidenceSnippets) {
      const id = Number(row.nodeId);
      if (!snippetsByNode.has(id)) snippetsByNode.set(id, row.snippet);
    }
    const relationRowsByNode = new Map();
    for (const row of relationRows) {
      for (const id of [Number(row.sourceNodeId), Number(row.targetNodeId)]) {
        if (!nodeIds.includes(id)) continue;
        const isSource = Number(row.sourceNodeId) === id;
        if (!relationRowsByNode.has(id)) relationRowsByNode.set(id, []);
        relationRowsByNode.get(id).push({
          neighborId: isSource
            ? Number(row.targetNodeId)
            : Number(row.sourceNodeId),
          neighborName:
            (isSource ? row.targetDisplayNameZh : row.sourceDisplayNameZh) ||
            (isSource ? row.targetDisplayNameEn : row.sourceDisplayNameEn) ||
            (isSource ? row.targetName : row.sourceName),
          confidence: Number(row.confidence || 0),
          weight: Number(row.weight || 0),
        });
      }
    }

    return recommendations.map((recommendation) => {
      const nodeId = nodeIdFromRecommendation(recommendation);
      const node = nodesById.get(Number(nodeId));
      const edgeId = edgeIdFromRecommendation(recommendation);
      const relationDisplay = relationDisplayByEdgeId.get(Number(edgeId));
      let hydrated = recommendation;
      if (node) {
        if (!recommendation.target?.nodeKey) {
          console.debug(
            "[WorkspaceOverview] recommendation_nodekey_missing_fixed",
            {
              recommendationId: recommendation.recommendationId,
              nodeId: node.id,
              identitySource: "nodeId",
            }
          );
        }
        const supplementCount =
          supplementCountByNodeKey.get(node.nodeKey) ||
          Number(
            recommendation.supplementCount ||
              recommendation.target?.supplementCount ||
              0
          );
        const displayFields = buildRecommendationDisplayFields({
          recommendation: {
            ...recommendation,
            supplementCount,
            evidenceCount: evidenceCountByNode.get(node.id),
          },
          node: {
            ...node,
            evidenceCount: evidenceCountByNode.get(node.id),
            supplementCount,
          },
          neighbors: relationRowsByNode.get(node.id) || [],
          evidenceSnippet: snippetsByNode.get(node.id) || "",
          evidenceCount: evidenceCountByNode.get(node.id) || 0,
          relationCount: relationCountByNode.get(node.id) || 0,
          chunkCount: chunkCountByNode.get(node.id) || 0,
          supplementCount,
          learningState: learningByNodeKey.get(node.nodeKey) || null,
        });
        hydrated = {
          ...hydrated,
          ...displayFields,
          target: {
            ...hydrated.target,
            nodeId: node.id,
            nodeKey: node.nodeKey,
            canonicalKey: node.canonicalKey,
            nodeType: node.entityType,
            displayName: displayName(node),
            supplementCount,
            hasSupplement:
              Boolean(hydrated.target?.hasSupplement) || supplementCount > 0,
          },
          hasSupplement: Boolean(hydrated.hasSupplement) || supplementCount > 0,
          supplementCount,
        };
      }
      if (!relationDisplay) return hydrated;
      const cardType = isHighConfidencePathRecommendation(
        recommendation,
        relationDisplay._edge
      )
        ? "path"
        : "relation";
      const pathSummary =
        cardType === "path" ? relationDisplay.pathSummary : "";
      const nextAction = buildRelationNextAction({
        cardType,
        edge: relationDisplay._edge,
        pathSummary,
      });
      const {
        _edge,
        pathSummary: _pathSummary,
        ...visibleRelationDisplay
      } = relationDisplay;
      return {
        ...hydrated,
        ...visibleRelationDisplay,
        cardType,
        pathSummary,
        nextAction,
      };
    });
  } catch (error) {
    console.error(
      "[WorkspaceOverview] recommendation card hydration failed:",
      error
    );
    return recommendations;
  }
}

function buildCandidate({
  workspaceId,
  type,
  title,
  target,
  components,
  reasonCodes,
  reasonZh,
  refs,
  confidence = 0.75,
  category,
}) {
  const targetType = target?.targetType || "concept";
  const targetId = String(target?.targetId || target?.nodeId || title);
  const normalizedInputs = {
    workspaceImportance: round(components.workspaceImportance),
    personalFocus: round(components.personalFocus),
    recentInterest: round(components.recentInterest),
    unfinishedExploration: round(components.unfinishedExploration),
    novelty: round(components.novelty),
    curiosity: round(components.curiosity),
    supplementBoost: round(components.supplementBoost || 0),
    ...(components.extra || {}),
  };
  const score =
    normalizedInputs.workspaceImportance * 0.2 +
    normalizedInputs.personalFocus * 0.25 +
    normalizedInputs.recentInterest * 0.2 +
    normalizedInputs.unfinishedExploration * 0.15 +
    normalizedInputs.novelty * 0.1 +
    normalizedInputs.curiosity * 0.1;
  const supplementScoreBoost = Math.min(
    4,
    Math.round(clamp(normalizedInputs.supplementBoost) * 4)
  );
  return {
    recommendationId: recommendationId({
      workspaceId,
      type,
      targetType,
      targetId,
    }),
    formulaVersion: FORMULA_VERSION,
    type,
    category: category || type,
    title,
    target: { ...target, targetType, targetId },
    score: Math.min(100, Math.round(clamp(score) * 100) + supplementScoreBoost),
    confidence: Math.round(clamp(confidence) * 100),
    reasonCodes,
    reasonZh,
    normalizedInputs,
    hasSupplement: Boolean(target?.hasSupplement),
    supplementCount: Number(target?.supplementCount || 0),
    supplementTitles: target?.supplementTitles || [],
    supplementDocumentIds: target?.supplementDocumentIds || [],
    refs: refs || [],
  };
}

function applyFeedback(candidate, feedback) {
  const item = feedback.get(candidate.recommendationId);
  if (!item) return { candidate, hidden: false };
  const hidden =
    item.cooldownUntil && new Date(item.cooldownUntil).getTime() > Date.now();
  const clickBoost = Math.min(8, item.clickCount * 2 + item.continueCount * 3);
  const ignorePenalty =
    item.impressionCount > 3 && item.clickCount === 0
      ? Math.min(10, item.impressionCount)
      : 0;
  return {
    hidden,
    candidate: {
      ...candidate,
      score: Math.max(
        0,
        Math.min(100, candidate.score + clickBoost - ignorePenalty)
      ),
      feedback: {
        impressionCount: item.impressionCount,
        clickCount: item.clickCount,
        dismissCount: item.dismissCount,
        continueCount: item.continueCount,
        cooldownUntil: item.cooldownUntil,
      },
    },
  };
}

function conceptsFromChats(chats, nodes) {
  const texts = chats
    .map(
      (chat) =>
        `${chat.prompt || ""} ${String(chat.response || "").slice(0, 2000)}`
    )
    .join("\n")
    .toLowerCase();
  if (!texts.trim()) return [];
  return nodes
    .map((node) => {
      const labels = [
        node.canonicalName,
        node.displayNameZh,
        node.displayNameEn,
        ...(node.aliases || []).map((alias) =>
          typeof alias === "object"
            ? `${alias.en || ""} ${alias.zh || ""}`
            : alias
        ),
      ]
        .filter(Boolean)
        .map(canonicalText);
      const hits = labels.reduce((sum, label) => {
        if (!label || label.length < 2) return sum;
        return sum + (texts.includes(label) ? 1 : 0);
      }, 0);
      return { node, hits };
    })
    .filter((item) => item.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 8)
    .map((item) => ({
      nodeId: item.node.id,
      concept: item.node.canonicalName,
      displayName: displayName(item.node),
      hits: item.hits,
    }));
}

function usageForNode(usageRows, nodeId) {
  return usageRows
    .filter(
      (row) =>
        row.targetType === "node" && String(row.targetId) === String(nodeId)
    )
    .reduce((sum, row) => sum + row.decayedScore, 0);
}

function buildRecommendations({
  workspaceId,
  nodes,
  usageRows,
  recentEdges,
  feedback,
}) {
  const candidates = [];
  const sortedByFocus = [...nodes].sort((a, b) => {
    const aScore =
      a.recentImportanceScore * 0.4 +
      a.workspaceImportanceScore * 0.25 +
      usageForNode(usageRows, a.id) * 0.2 +
      (a.recentEvidenceCount > 0 ? 0.15 : 0);
    const bScore =
      b.recentImportanceScore * 0.4 +
      b.workspaceImportanceScore * 0.25 +
      usageForNode(usageRows, b.id) * 0.2 +
      (b.recentEvidenceCount > 0 ? 0.15 : 0);
    return bScore - aScore;
  });

  for (const node of sortedByFocus.slice(0, 6)) {
    const usage = usageForNode(usageRows, node.id);
    candidates.push(
      buildCandidate({
        workspaceId,
        type: "current_focus",
        category: "focus",
        title: `继续关注 ${displayName(node)}`,
        target: nodeTarget(node),
        components: {
          workspaceImportance: clamp(node.workspaceImportanceScore),
          personalFocus: clamp(usage / 6),
          recentInterest: clamp(node.recentImportanceScore + usage / 8),
          unfinishedExploration: 0.15,
          novelty: clamp(node.recentEvidenceCount / 8),
          curiosity: clamp((node.bridgeValue || 0) / 100),
          supplementBoost: node.hasSupplement ? 1 : 0,
          extra: {
            evidenceCount: node.evidenceCount,
            edgeCount: node.edgeCount,
            recentEvidenceCount: node.recentEvidenceCount,
          },
        },
        reasonCodes: ["recent_focus", "workspace_importance"],
        reasonZh: [
          "它与当前 workspace 的核心知识结构关系较强。",
          usage > 0
            ? "你最近查看过这个概念或相关证据。"
            : "它在知识图谱中近期重要性较高。",
        ],
        refs: [{ type: "node", id: node.id }],
      })
    );
  }

  for (const node of nodes
    .filter(
      (node) => node.workspaceImportanceScore >= 0.45 && node.evidenceCount <= 3
    )
    .slice(0, 5)) {
    candidates.push(
      buildCandidate({
        workspaceId,
        type: "evidence_gap",
        category: "gap",
        title: `${displayName(node)} 的证据还比较薄`,
        target: nodeTarget(node),
        components: {
          workspaceImportance: clamp(node.workspaceImportanceScore),
          personalFocus: clamp(usageForNode(usageRows, node.id) / 6),
          recentInterest: clamp(node.recentImportanceScore),
          unfinishedExploration: 0.3,
          novelty: clamp(1 - node.evidenceCount / 5),
          curiosity: 0.85,
          supplementBoost: node.hasSupplement ? 1 : 0,
          extra: {
            evidenceCount: node.evidenceCount,
            documentCount: node.documentCount,
            edgeCount: node.edgeCount,
          },
        },
        reasonCodes: ["high_importance_low_evidence"],
        reasonZh: [
          "该概念重要性较高，但证据片段和文档覆盖偏少。",
          "继续追踪它可以帮助补齐知识缺口。",
        ],
        refs: [{ type: "node", id: node.id }],
      })
    );
  }

  for (const node of nodes
    .filter(
      (node) =>
        node.bridgeValue >= 55 ||
        (node.edgeCount >= 5 && node.relationTypeCount >= 3)
    )
    .slice(0, 5)) {
    candidates.push(
      buildCandidate({
        workspaceId,
        type: "bridge_concept",
        category: "curiosity",
        title: `${displayName(node)} 可能是隐藏桥接点`,
        target: nodeTarget(node),
        components: {
          workspaceImportance: clamp(node.workspaceImportanceScore),
          personalFocus: clamp(usageForNode(usageRows, node.id) / 6),
          recentInterest: clamp(node.recentImportanceScore),
          unfinishedExploration: 0.2,
          novelty: clamp(node.recentEvidenceCount / 6),
          curiosity: clamp(
            (node.bridgeValue || 0) / 100 || node.relationTypeCount / 6
          ),
          supplementBoost: node.hasSupplement ? 1 : 0,
          extra: {
            bridgeValue: node.bridgeValue,
            relationTypeCount: node.relationTypeCount,
            edgeCount: node.edgeCount,
          },
        },
        reasonCodes: ["bridge_value"],
        reasonZh: [
          "它连接了多个关系类型或知识区域。",
          "探索它可能帮助你从当前主题跳到相关机制或结构。",
        ],
        refs: [{ type: "node", id: node.id }],
      })
    );
  }

  for (const node of nodes
    .filter((node) => node.metricsWarning || node.conflictSafety < 55)
    .slice(0, 5)) {
    candidates.push(
      buildCandidate({
        workspaceId,
        type: "conflict_area",
        category: "conflict",
        title: `${displayName(node)} 附近存在需要观察的关系`,
        target: nodeTarget(node),
        components: {
          workspaceImportance: clamp(node.workspaceImportanceScore),
          personalFocus: clamp(usageForNode(usageRows, node.id) / 6),
          recentInterest: clamp(node.recentImportanceScore),
          unfinishedExploration: 0.2,
          novelty: 0.35,
          curiosity: clamp(1 - node.conflictSafety / 100),
          supplementBoost: node.hasSupplement ? 1 : 0,
          extra: {
            conflictSafety: node.conflictSafety,
            warning: node.metricsWarning || null,
          },
        },
        reasonCodes: ["conflict_or_metric_warning"],
        reasonZh: [
          "该区域存在指标波动或冲突风险。",
          "建议查看证据来源，确认关系是否稳定。",
        ],
        refs: [{ type: "node", id: node.id }],
        confidence: 0.65,
      })
    );
  }

  for (const edge of recentEdges.slice(0, 6)) {
    const targetId = `${edge.sourceNodeId}-${edge.targetNodeId}-${edge.id}`;
    candidates.push(
      buildCandidate({
        workspaceId,
        type: "new_relation",
        category: "change",
        title: `新增关系：${edge.sourceNameZh || edge.sourceName} → ${edge.targetNameZh || edge.targetName}`,
        target: {
          targetType: "path",
          targetId,
          sourceConcept: edge.sourceName,
          targetConcept: edge.targetName,
          edgeId: edge.id,
        },
        components: {
          workspaceImportance: clamp(Number(edge.weight || 0) / 3),
          personalFocus: 0.2,
          recentInterest: clamp(Number(edge.confidence || 0)),
          unfinishedExploration: 0.15,
          novelty: decay(edge.createdAt, 7),
          curiosity: clamp(Number(edge.evidenceCount || 0) / 5),
          extra: {
            confidence: Number(edge.confidence || 0),
            weight: Number(edge.weight || 0),
            evidenceCount: Number(edge.evidenceCount || 0),
            relationType: edge.relationType,
          },
        },
        reasonCodes: ["recent_relation"],
        reasonZh: [
          "这是最近进入知识图谱的重要关系。",
          Number(edge.evidenceCount || 0) > 0
            ? "该关系已有 evidence 支持。"
            : "该关系仍需要更多证据支持。",
        ],
        refs: [
          { type: "edge", id: edge.id },
          { type: "node", id: edge.sourceNodeId },
          { type: "node", id: edge.targetNodeId },
        ],
      })
    );
  }

  const deduped = new Map();
  for (const candidate of candidates) {
    const withFeedback = applyFeedback(candidate, feedback);
    if (withFeedback.hidden) continue;
    const existing = deduped.get(candidate.recommendationId);
    if (!existing || withFeedback.candidate.score > existing.score)
      deduped.set(candidate.recommendationId, withFeedback.candidate);
  }
  return [...deduped.values()].sort((a, b) => b.score - a.score);
}

function diversityPick(candidates) {
  const required = ["focus", "change", "gap", "conflict", "curiosity"];
  const picked = [];
  const used = new Set();
  for (const category of required) {
    const item = candidates.find(
      (candidate) =>
        candidate.category === category && !used.has(candidate.recommendationId)
    );
    if (item) {
      picked.push(item);
      used.add(item.recommendationId);
    }
  }
  for (const item of candidates) {
    if (picked.length >= MAX_RECOMMENDATIONS) break;
    if (used.has(item.recommendationId)) continue;
    picked.push(item);
    used.add(item.recommendationId);
  }
  return picked;
}

function buildUnfinishedExplorations({
  workspaceId,
  nodes,
  usageRows,
  feedback,
}) {
  const nodeUsage = usageRows
    .filter((row) => row.targetType === "node" && row.action === "view")
    .sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt));
  return nodeUsage
    .map((row) =>
      nodes.find((node) => String(node.id) === String(row.targetId))
    )
    .filter(Boolean)
    .slice(0, 5)
    .map((node) =>
      applyFeedback(
        buildCandidate({
          workspaceId,
          type: "continue_research",
          category: "continue",
          title: `继续研究 ${displayName(node)}`,
          target: nodeTarget(node),
          components: {
            workspaceImportance: clamp(node.workspaceImportanceScore),
            personalFocus: 1,
            recentInterest: clamp(
              node.recentImportanceScore + usageForNode(usageRows, node.id) / 6
            ),
            unfinishedExploration: 0.9,
            novelty: clamp(node.recentEvidenceCount / 6),
            curiosity: clamp((node.bridgeValue || 0) / 100),
            supplementBoost: node.hasSupplement ? 1 : 0,
            extra: {
              lastViewedAt: usageRows.find(
                (row) => String(row.targetId) === String(node.id)
              )?.lastUsedAt,
              evidenceCount: node.evidenceCount,
              edgeCount: node.edgeCount,
            },
          },
          reasonCodes: ["unfinished_exploration", "recent_node_view"],
          reasonZh: [
            "你最近查看过这个概念，但还可以继续展开相关关系或证据。",
            node.edgeCount > 0
              ? "它还有可继续探索的关联节点。"
              : "它目前关系较少，适合继续补证据或查看原文。",
          ],
          refs: [{ type: "node", id: node.id }],
        }),
        feedback
      )
    )
    .filter((item) => !item.hidden)
    .map((item) => item.candidate);
}

function buildDocumentFallbackRecommendations({
  workspaceId,
  recentDocuments,
  chatData,
  feedback,
}) {
  const chatRecency = chatData?.chats?.[0]?.lastUpdatedAt
    ? decay(chatData.chats[0].lastUpdatedAt, 3)
    : 0;
  return recentDocuments
    .slice(0, 8)
    .map((doc, index) =>
      applyFeedback(
        buildCandidate({
          workspaceId,
          type: "document_resume",
          category: index === 0 ? "continue" : "focus",
          title: `继续查看 ${doc.filename || doc.docpath || "最近文档"}`,
          target: {
            targetType: "document",
            targetId: String(doc.docId || doc.id),
            documentId: doc.docId,
            filename: doc.filename,
            docpath: doc.docpath,
          },
          components: {
            workspaceImportance:
              doc.embeddingStatus === "completed" ? 0.45 : 0.25,
            personalFocus: index === 0 ? 0.45 : 0.25,
            recentInterest: clamp(
              decay(doc.lastUpdatedAt || doc.createdAt, 7) + chatRecency * 0.2
            ),
            unfinishedExploration: index === 0 ? 0.55 : 0.25,
            novelty: decay(doc.createdAt || doc.lastUpdatedAt, 14),
            curiosity: 0.25,
            extra: {
              docId: doc.docId,
              filename: doc.filename,
              embeddingStatus: doc.embeddingStatus,
              lastUpdatedAt: doc.lastUpdatedAt,
            },
          },
          reasonCodes: ["recent_document", "workspace_fallback"],
          reasonZh: [
            "知识图谱信号不足时，先根据已有文档和最近活动生成研究入口。",
            doc.embeddingStatus === "completed"
              ? "该文档已完成向量化，可作为继续研究的起点。"
              : "该文档最近有更新，适合检查处理状态或补充索引。",
          ],
          refs: [{ type: "document", id: doc.docId || doc.id }],
          confidence: 0.55,
        }),
        feedback
      )
    )
    .filter((item) => !item.hidden)
    .map((item) => item.candidate);
}

async function buildWorkspaceOverviewUncached({
  workspace,
  user = null,
  threadSlug = null,
  focusState = null,
  now = Date.now(),
}) {
  const workspaceId = Number(workspace.id);
  const userId = Number(user?.id || 0);
  let knowledgeEngineFallbackReason = null;
  const [
    nodes,
    usageRows,
    recentEdges,
    recentDocuments,
    chatData,
    activity,
    feedback,
  ] = await Promise.all([
    getNodes(workspaceId),
    getUsage(workspaceId),
    getRecentEdges(workspaceId),
    getRecentDocuments(workspaceId),
    getRecentChats(workspaceId, userId, threadSlug),
    getActivity(workspaceId),
    getFeedback(workspaceId, userId),
  ]);

  const supplementsByNodeKey = await NodeSupplement.summariesByNodeKeys({
    workspaceId,
    nodeKeys: nodes.map((node) => node.nodeKey).filter(Boolean),
  });
  const supplementedNodes = attachNodeSupplements(nodes, supplementsByNodeKey);
  const workspaceSupplementSummary = await WorkspaceSupplement.summary({
    workspaceId,
  }).catch((error) => {
    console.error("[WorkspaceOverview] workspace supplements failed:", error);
    return { count: 0, byKind: {}, supplements: [] };
  });
  let workspaceProfile = null;
  let bookStructure = null;
  try {
    const profileResult = await buildWorkspaceKnowledgeProfile({ workspace });
    workspaceProfile = profileResult.profile;
    bookStructure = profileResult.bookStructure;
  } catch (error) {
    knowledgeEngineFallbackReason =
      error?.message || "workspace_profile_failed";
    console.error("[WorkspaceOverview] knowledge profile failed:", error);
  }
  const enginePaths = (
    await Promise.all(
      supplementedNodes.slice(0, 4).map((node) =>
        keyPathsForNode({
          workspaceId,
          node,
          profile: workspaceProfile,
          bookStructure,
          workspaceSupplements: workspaceSupplementSummary.supplements,
          limit: 1,
        }).catch(() => [])
      )
    )
  ).flat();

  const sessionConcepts = conceptsFromChats(chatData.chats, supplementedNodes);
  const rawUnfinishedExplorations = buildUnfinishedExplorations({
    workspaceId,
    nodes: supplementedNodes,
    usageRows,
    feedback,
  });
  const recommendations = buildRecommendations({
    workspaceId,
    nodes: supplementedNodes,
    usageRows,
    recentEdges,
    feedback,
  });
  const documentFallbackRecommendations = buildDocumentFallbackRecommendations({
    workspaceId,
    recentDocuments,
    chatData,
    feedback,
  });
  const engineRecommendations = knowledgeEngineFallbackReason
    ? []
    : await buildKnowledgeEngineRecommendations({
        workspaceId,
        userId,
        profile: workspaceProfile,
        bookStructure,
        nodes: supplementedNodes,
        paths: enginePaths,
        feedback,
        workspaceSupplements: workspaceSupplementSummary.supplements,
      }).catch((error) => {
        knowledgeEngineFallbackReason =
          error?.message || "recommendation_adapter_failed";
        console.error(
          "[WorkspaceOverview] recommendation adapter failed:",
          error
        );
        return [];
      });
  const rawPersonalizedRecommendations = diversityPick(
    engineRecommendations.length > 0
      ? engineRecommendations
      : [
          ...rawUnfinishedExplorations,
          ...recommendations,
          ...documentFallbackRecommendations,
        ]
  );
  const hydratedRecommendationCards = await hydrateRecommendationCards({
    workspaceId,
    userId,
    workspaceSupplements: workspaceSupplementSummary.supplements,
    recommendations: [
      ...rawPersonalizedRecommendations,
      ...rawUnfinishedExplorations,
    ],
  });
  const personalizedRecommendations = hydratedRecommendationCards.slice(
    0,
    rawPersonalizedRecommendations.length
  );
  const unfinishedExplorations = hydratedRecommendationCards.slice(
    rawPersonalizedRecommendations.length
  );
  const todayEvidence = await optionalQuery(
    `SELECT COUNT(*) AS count FROM "EdgeEvidence"
    WHERE "workspaceId" = ? AND "createdAt" >= date('now')`,
    workspaceId
  );
  const todayRelations = await optionalQuery(
    `SELECT COUNT(*) AS count FROM "KnowledgeEdge"
    WHERE "workspaceId" = ? AND "createdAt" >= date('now')`,
    workspaceId
  );
  const todayDocs = await optionalQuery(
    `SELECT COUNT(*) AS count FROM "workspace_documents"
    WHERE "workspaceId" = ? AND "lastUpdatedAt" >= date('now')`,
    workspaceId
  );

  let beacon;
  try {
    beacon = await healthBeacon({
      workspaceId,
      workspaceSlug: workspace.slug,
    });
  } catch {
    beacon = unknownBeacon(workspace.slug);
  }

  const stableFocus = selectStableCurrentFocus({
    candidates: personalizedRecommendations,
    previousState: focusState,
    now,
  });
  const topFocus = stableFocus.focus;
  const narrative = await getOrScheduleWorkspaceOverviewNarrative({
    workspace,
    workspaceSupplements: workspaceSupplementSummary.supplements,
    bookStructure,
  }).catch((error) => {
    console.warn("[WorkspaceOverview] narrative unavailable:", error.message);
    return null;
  });
  const focusNodeKey = topFocus?.[0]?.target?.nodeKey || null;
  const [workspaceBackground, nodeBackground] = await Promise.all([
    WorkspaceVisualAsset.forWorkspace({
      workspaceId,
      workspaceSlug: workspace.slug,
    }).catch(() => null),
    focusNodeKey
      ? WorkspaceVisualAsset.forNode({
          workspaceId,
          workspaceSlug: workspace.slug,
          nodeKey: focusNodeKey,
        }).catch(() => null)
      : null,
  ]);
  const currentFocusDetail = buildCurrentFocusDetail({
    focus: topFocus?.[0] || null,
    nodeBackground,
  });
  const hasAnyOverviewData =
    supplementedNodes.length > 0 ||
    recentDocuments.length > 0 ||
    chatData.chats.length > 0 ||
    activity.length > 0;
  return {
    workspace: {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
    },
    [FOCUS_STATE_SYMBOL]: stableFocus.state,
    generatedAt: new Date().toISOString(),
    formulaVersion: FORMULA_VERSION,
    workspaceHero: {
      title: workspace.name,
      tagline: narrative?.status === "ready" ? narrative.tagline : "",
      taglineStatus: narrative?.status || "empty",
      backgroundImageUrl: workspaceBackground?.url || null,
      backgroundAsset: workspaceBackground || null,
    },
    visualAssets: {
      workspaceBackground,
      currentFocusBackground: currentFocusDetail?.backgroundAsset || null,
    },
    workspaceProfile,
    bookStructure,
    workspaceSupplements: workspaceSupplementSummary,
    recommendationEngine: {
      primary:
        engineRecommendations.length > 0
          ? "knowledge_engine"
          : "legacy_fallback",
      fallbackUsed: engineRecommendations.length === 0,
      engineRecommendationCount: engineRecommendations.length,
      fallbackReason:
        engineRecommendations.length === 0
          ? knowledgeEngineFallbackReason || "knowledge_engine_no_candidates"
          : null,
    },
    todaySummary: {
      evidenceAddedToday: countFrom(todayEvidence),
      relationsAddedToday: countFrom(todayRelations),
      documentsUpdatedToday: countFrom(todayDocs),
      recentDocuments: recentDocuments.slice(0, 5),
    },
    userCognitiveState: {
      currentFocusConcepts: topFocus.map((item) => item.target),
      activeTopics: sessionConcepts.slice(0, 6),
      recentPaths: personalizedRecommendations
        .filter((item) => item.target?.targetType === "path")
        .slice(0, 4),
      unfinishedExplorations,
      interestSignals: usageRows.slice(0, 10).map((row) => ({
        targetType: row.targetType,
        targetId: row.targetId,
        action: row.action,
        count: row.count,
        lastUsedAt: row.lastUsedAt,
        decayedScore: round(row.decayedScore),
      })),
      updatedAt: new Date().toISOString(),
    },
    sessionContext: {
      recentQuestionConcepts: sessionConcepts,
      referencedDocuments: recentDocuments.slice(0, 5),
      activeThreadSlug: threadSlug || null,
      activeThreadName: chatData.activeThread?.name || null,
      lastInteractionAt: chatData.chats?.[0]?.lastUpdatedAt || null,
    },
    currentFocus: topFocus,
    currentFocusDetail,
    personalizedRecommendations,
    unfinishedExplorations,
    curiosityRecommendations: personalizedRecommendations.filter((item) =>
      ["gap", "conflict", "curiosity"].includes(item.category)
    ),
    recommendedExploration: personalizedRecommendations,
    knowledgeMomentum: {
      fastestGrowingConcepts: supplementedNodes
        .filter((node) => node.recentEvidenceCount > 0)
        .sort((a, b) => b.recentEvidenceCount - a.recentEvidenceCount)
        .slice(0, 6)
        .map((node) => ({
          nodeId: node.id,
          concept: node.canonicalName,
          displayName: displayName(node),
          recentEvidenceCount: node.recentEvidenceCount,
        })),
      newImportantRelations: recentEdges.slice(0, 6),
      frequentlyViewedConcepts: usageRows
        .filter((row) => row.targetType === "node")
        .slice(0, 6),
    },
    resumeResearch: {
      items: unfinishedExplorations.slice(0, 4),
      recentDocuments: recentDocuments.slice(0, 5),
      recentConcepts: usageRows
        .filter((row) => row.targetType === "node")
        .slice(0, 6),
    },
    recentActivity: activity,
    healthLite: {
      score: beacon.score,
      status: beacon.status,
      processing: beacon.processing,
      summary: beacon.summary,
      topIssues: beacon.topIssues?.slice(0, 3) || [],
      lastUpdatedAt: beacon.lastUpdatedAt,
    },
    recommendationDiversity: {
      requestedCategories: [
        "continue",
        "focus",
        "change",
        "gap",
        "conflict",
        "curiosity",
      ],
      returnedCategories: [
        ...new Set(personalizedRecommendations.map((item) => item.category)),
      ],
    },
    recommendationDebug: {
      formulaVersion: FORMULA_VERSION,
      scoreFormula:
        "workspaceImportance*0.20 + personalFocus*0.25 + recentInterest*0.20 + unfinishedExploration*0.15 + novelty*0.10 + curiosity*0.10",
      nodeCount: supplementedNodes.length,
      documentFallbackCount: documentFallbackRecommendations.length,
      usageSignalCount: usageRows.length,
      feedbackCount: feedback.size,
      fallbackUsed: engineRecommendations.length === 0,
      fallbackReason:
        engineRecommendations.length === 0
          ? knowledgeEngineFallbackReason || "knowledge_engine_no_candidates"
          : null,
    },
    emptyState: {
      show: !hasAnyOverviewData,
      reason: !hasAnyOverviewData ? "workspace_overview_empty" : null,
      actions: !hasAnyOverviewData
        ? [
            "上传或选择文档",
            "运行 Knowledge Graph backfill",
            "打开健康中心检查后台状态",
          ]
        : [],
    },
  };
}

async function refreshWorkspaceOverviewCache(key, params) {
  if (overviewInflight.has(key)) return overviewInflight.get(key);

  const promise = buildWorkspaceOverviewUncached({
    ...params,
    focusState: overviewFocusState.get(key) || null,
  })
    .then((overview) => {
      if (overview[FOCUS_STATE_SYMBOL]) {
        overviewFocusState.set(key, overview[FOCUS_STATE_SYMBOL]);
      } else {
        overviewFocusState.delete(key);
      }
      overviewCache.set(key, {
        overview: {
          ...overview,
          cacheStatus: "fresh",
          cacheUpdatedAt: new Date().toISOString(),
        },
        updatedAt: Date.now(),
        error: null,
      });
      return overviewCache.get(key).overview;
    })
    .catch((error) => {
      const previous = overviewCache.get(key);
      overviewCache.set(
        key,
        previous?.overview
          ? { ...previous, lastError: error, lastErrorAt: Date.now() }
          : {
              overview: null,
              updatedAt: Date.now(),
              error,
            }
      );
      throw error;
    })
    .finally(() => overviewInflight.delete(key));

  overviewInflight.set(key, promise);
  return promise;
}

async function buildWorkspaceOverview({
  workspace,
  user = null,
  threadSlug = null,
}) {
  const workspaceId = Number(workspace.id);
  const userId = Number(user?.id || 0);
  const key = overviewCacheKey({ workspaceId, userId, threadSlug });
  const cached = overviewCache.get(key);
  const now = Date.now();

  if (cached?.overview) {
    const ageMs = now - cached.updatedAt;
    if (ageMs < OVERVIEW_CACHE_TTL_MS) return cached.overview;

    refreshWorkspaceOverviewCache(key, { workspace, user, threadSlug }).catch(
      (error) =>
        console.warn(
          "[WorkspaceOverview] background refresh failed:",
          error.message
        )
    );
    return {
      ...cached.overview,
      cacheStatus: "stale",
      cacheAgeMs: ageMs,
    };
  }

  if (cached?.error && now - cached.updatedAt < OVERVIEW_ERROR_CACHE_TTL_MS) {
    throw cached.error;
  }

  return await refreshWorkspaceOverviewCache(key, {
    workspace,
    user,
    threadSlug,
  });
}

async function recordRecommendationUsage({
  workspaceId,
  userId = 0,
  recommendationId: id,
  formulaVersion = FORMULA_VERSION,
  type,
  targetType,
  targetId,
  action,
  pageSessionId = null,
}) {
  const validActions = ["impression", "click", "dismiss", "continue"];
  if (!workspaceId || !id || !validActions.includes(String(action))) {
    return { success: false, error: "invalid_usage_event" };
  }

  try {
    const row = (
      await withSqliteBusyRetry(() =>
        workspaceOverviewDb.$queryRawUnsafe(
          `SELECT "id", "workspaceId", "userId", "recommendationId", "type",
        "targetType", "targetId", "formulaVersion", "impressionCount",
        "clickCount", "dismissCount", "continueCount",
        CAST("lastShownAt" AS TEXT) AS "lastShownAt",
        CAST("lastInteractedAt" AS TEXT) AS "lastInteractedAt",
        CAST("cooldownUntil" AS TEXT) AS "cooldownUntil",
        "metadata", CAST("createdAt" AS TEXT) AS "createdAt",
        CAST("updatedAt" AS TEXT) AS "updatedAt"
      FROM "WorkspaceOverviewRecommendationUsage"
      WHERE "workspaceId" = ? AND "userId" = ? AND "recommendationId" = ?
      LIMIT 1`,
          Number(workspaceId),
          Number(userId || 0),
          String(id)
        )
      )
    )?.[0];
    const metadata = safeJsonParse(row?.metadata, {});
    const sessions = Array.isArray(metadata.impressionSessions)
      ? metadata.impressionSessions
      : [];
    if (
      action === "impression" &&
      pageSessionId &&
      sessions.includes(pageSessionId)
    ) {
      return { success: true, deduped: true };
    }
    if (action === "impression" && pageSessionId) {
      metadata.impressionSessions = [
        ...sessions.slice(-49),
        String(pageSessionId),
      ];
    }

    const column = {
      impression: "impressionCount",
      click: "clickCount",
      dismiss: "dismissCount",
      continue: "continueCount",
    }[action];
    const cooldownUntil =
      action === "dismiss"
        ? toSqliteDateTime(
            new Date(Date.now() + DISMISS_COOLDOWN_DAYS * DAY_MS)
          )
        : row?.cooldownUntil || null;
    const now = toSqliteDateTime(new Date());
    const lastShownAt =
      action === "impression" ? now : row?.lastShownAt || null;
    const lastInteractedAt =
      action === "impression" ? row?.lastInteractedAt || null : now;

    await withSqliteBusyRetry(() =>
      workspaceOverviewDb.$executeRawUnsafe(
        `INSERT INTO "WorkspaceOverviewRecommendationUsage" (
      "workspaceId", "userId", "recommendationId", "type", "targetType",
      "targetId", "formulaVersion", "${column}", "lastShownAt",
      "lastInteractedAt", "cooldownUntil", "metadata"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT("workspaceId", "userId", "recommendationId") DO UPDATE SET
      "${column}" = "${column}" + 1,
      "type" = excluded."type",
      "targetType" = excluded."targetType",
      "targetId" = excluded."targetId",
      "formulaVersion" = excluded."formulaVersion",
      "lastShownAt" = COALESCE(excluded."lastShownAt", "lastShownAt"),
      "lastInteractedAt" = COALESCE(excluded."lastInteractedAt", "lastInteractedAt"),
      "cooldownUntil" = excluded."cooldownUntil",
      "metadata" = excluded."metadata",
      "updatedAt" = CURRENT_TIMESTAMP`,
        Number(workspaceId),
        Number(userId || 0),
        String(id),
        String(type || "unknown"),
        String(targetType || "unknown"),
        String(targetId || ""),
        String(formulaVersion || FORMULA_VERSION),
        lastShownAt,
        lastInteractedAt,
        cooldownUntil,
        safeJSONStringify(metadata, "{}")
      )
    );
    if (action !== "impression") {
      invalidateWorkspaceOverviewCache({
        workspaceId: Number(workspaceId),
        userId: Number(userId || 0),
      });
    }
    return { success: true, deduped: false };
  } catch (error) {
    if (isSqliteLocked(error)) {
      console.warn(
        "[WorkspaceOverview] usage write skipped because database is locked"
      );
      return { success: true, skipped: true, reason: "database_locked" };
    }
    throw error;
  }
}

module.exports = {
  FORMULA_VERSION,
  buildWorkspaceOverview,
  invalidateWorkspaceOverviewCache,
  recordRecommendationUsage,
  recommendationId,
  selectStableCurrentFocus,
  collectHydrationNodeIds,
  collectHydrationEdgeIds,
  buildNodeSummary,
  buildMainlinePath,
  buildRecommendationDisplayFields,
  relationTypeLabel,
  buildRelationTitle,
  buildRelationSummary,
  relationSnippetMatches,
};
