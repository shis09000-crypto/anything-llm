const {
  lazyDataAccessFacade,
  lazyDataAccessProperty,
} = require("../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const knowledgeGraphDb = KnowledgeGraphData.db;
const BookStructureAnalysis = lazyDataAccessProperty(
  "knowledgeGraph",
  "bookStructureAnalysis"
);

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function lower(value = "") {
  return String(value || "").toLowerCase();
}

function countMatches(text = "", keywords = []) {
  const haystack = lower(text);
  return keywords.reduce(
    (score, keyword) => score + (haystack.includes(lower(keyword)) ? 1 : 0),
    0
  );
}

function labelForType(type) {
  const labels = {
    person_driven: {
      primaryAxis: "人物",
      secondaryAxes: ["概念", "学派", "时间"],
      recommendedNodeTypes: ["person", "concept", "school", "era", "work"],
      recommendedPathTypes: [
        "人物演进路径",
        "思想继承路径",
        "概念发展路径",
        "人物对比路径",
      ],
      extractionFocus: ["人物", "学派", "著作", "概念", "影响关系", "批评关系"],
      recommendationFocus: ["人物路径", "思想继承", "概念发展", "人物对比"],
    },
    concept_driven: {
      primaryAxis: "概念",
      secondaryAxes: ["问题", "论证", "章节"],
      recommendedNodeTypes: [
        "concept",
        "question",
        "claim",
        "argument",
        "chapter",
      ],
      recommendedPathTypes: [
        "概念发展路径",
        "前置概念路径",
        "易混概念对比路径",
      ],
      extractionFocus: ["核心概念", "定义", "例子", "前置关系", "对比关系"],
      recommendationFocus: ["前置概念", "概念理解", "薄弱知识点", "概念对比"],
    },
    chronology_driven: {
      primaryAxis: "时间线",
      secondaryAxes: ["事件", "人物", "制度"],
      recommendedNodeTypes: ["era", "event", "person", "concept", "work"],
      recommendedPathTypes: ["时间线", "事件因果路径", "制度变化路径"],
      extractionFocus: ["时间", "事件", "人物", "制度", "因果关系"],
      recommendationFocus: ["时间线", "事件因果", "人物变化", "制度变化"],
    },
    problem_driven: {
      primaryAxis: "问题",
      secondaryAxes: ["概念", "方法", "结论"],
      recommendedNodeTypes: [
        "question",
        "problem",
        "concept",
        "method",
        "claim",
      ],
      recommendedPathTypes: ["问题推进路径", "证据到结论路径", "解决方案路径"],
      extractionFocus: ["问题", "假设", "方法", "证据", "结论"],
      recommendationFocus: ["问题整理", "解决路径", "未解决问题", "结论形成"],
    },
    method_driven: {
      primaryAxis: "方法",
      secondaryAxes: ["概念", "步骤", "例题"],
      recommendedNodeTypes: ["method", "concept", "task", "problem", "chapter"],
      recommendedPathTypes: ["方法步骤路径", "前置知识路径", "例题应用路径"],
      extractionFocus: ["方法", "步骤", "公式", "示例", "前置条件"],
      recommendationFocus: ["方法步骤", "场景应用", "例题路径", "薄弱点修复"],
    },
    chapter_driven: {
      primaryAxis: "章节",
      secondaryAxes: ["概念", "问题", "摘要"],
      recommendedNodeTypes: ["chapter", "concept", "question", "claim"],
      recommendedPathTypes: ["章节推进路径", "章节主题路径", "章节复习路径"],
      extractionFocus: ["章节", "小节", "章节摘要", "关键概念"],
      recommendationFocus: ["章节推进", "章节总结", "章节复习", "关键节点"],
    },
    argument_driven: {
      primaryAxis: "论证",
      secondaryAxes: ["概念", "问题", "反驳"],
      recommendedNodeTypes: ["argument", "claim", "concept", "question"],
      recommendedPathTypes: ["论证链", "支持证据路径", "反驳路径"],
      extractionFocus: ["主张", "理由", "证据", "反驳", "结论"],
      recommendationFocus: ["论证链", "概念澄清", "反驳关系", "深挖证据"],
    },
    mixed_structure: {
      primaryAxis: "混合结构",
      secondaryAxes: ["主题簇", "关键问题", "章节摘要"],
      recommendedNodeTypes: [
        "topic",
        "concept",
        "question",
        "chapter",
        "claim",
      ],
      recommendedPathTypes: ["主题簇路径", "关键问题路径", "高价值节点路径"],
      extractionFocus: ["主题", "关键问题", "概念", "证据组", "章节摘要"],
      recommendationFocus: ["主题簇", "关键问题", "章节摘要", "高价值节点"],
    },
  };
  return labels[type] || labels.mixed_structure;
}

async function entityTypeCounts(workspaceId) {
  try {
    const rows = await knowledgeGraphDb.$queryRawUnsafe(
      `SELECT "entityType", COUNT(*) AS count
      FROM "KnowledgeNode"
      WHERE "workspaceId" = ?
      GROUP BY "entityType"`,
      Number(workspaceId)
    );
    return Object.fromEntries(
      rows.map((row) => [row.entityType, Number(row.count || 0)])
    );
  } catch {
    return {};
  }
}

async function relationTypeCounts(workspaceId) {
  try {
    const rows = await knowledgeGraphDb.$queryRawUnsafe(
      `SELECT "relationType", COUNT(*) AS count
      FROM "KnowledgeEdge"
      WHERE "workspaceId" = ?
      GROUP BY "relationType"`,
      Number(workspaceId)
    );
    return Object.fromEntries(
      rows.map((row) => [row.relationType, Number(row.count || 0)])
    );
  } catch {
    return {};
  }
}

function detectStructure({
  docs = [],
  entityCounts = {},
  relationCounts = {},
  userDescription = "",
  workspaceSupplements = [],
}) {
  const parsedHints = workspaceSupplements
    .filter((item) => item.supplementKind === "structure_json")
    .filter((item) => item.structureJsonValid && item.parsedStructure)
    .map((item) => item.parsedStructure);
  const supplementText = workspaceSupplements
    .filter(
      (item) =>
        item.supplementKind !== "structure_json" || item.structureJsonValid
    )
    .map((item) => `${item.supplementKind}\n${item.text || ""}`)
    .join("\n");
  const text = `${userDescription}\n${supplementText}\n${docs
    .map((doc) => `${doc.filename || ""}\n${doc.sample || ""}`)
    .join("\n")}`;
  const explicitAxis = parsedHints
    .map(
      (item) =>
        `${item.primaryAxis || ""} ${(item.secondaryAxes || []).join(" ")}`
    )
    .join(" ");
  const scores = {
    person_driven:
      countMatches(text, ["人物", "哲学家", "作者", "biography", "思想家"]) +
      countMatches(explicitAxis, ["人物", "哲学家"]) * 2 +
      Number(entityCounts.person || 0) * 0.35,
    concept_driven:
      countMatches(text, ["概念", "定义", "理论", "自由", "正义", "concept"]) +
      countMatches(explicitAxis, ["概念"]) * 2 +
      Number(entityCounts.concept || 0) * 0.12,
    chronology_driven:
      countMatches(text, [
        "时间",
        "年表",
        "世纪",
        "历史",
        "战争",
        "timeline",
        "chronology",
      ]) +
      Number(entityCounts.era || 0) * 0.4,
    problem_driven:
      countMatches(text, [
        "问题",
        "疑问",
        "为什么",
        "如何",
        "problem",
        "question",
      ]) +
      Number(entityCounts.question || 0) * 0.35,
    method_driven:
      countMatches(text, [
        "方法",
        "步骤",
        "公式",
        "练习",
        "实验",
        "编程",
        "method",
      ]) +
      Number(entityCounts.method || 0) * 0.45,
    chapter_driven: countMatches(text, [
      "目录",
      "章节",
      "第1章",
      "第一章",
      "chapter",
      "section",
    ]),
    argument_driven:
      countMatches(text, [
        "论证",
        "主张",
        "反驳",
        "理由",
        "结论",
        "argument",
        "claim",
      ]) +
      Number(entityCounts.argument || 0) * 0.45 +
      Number(relationCounts.supports_claim || 0) * 0.2,
  };
  for (const hint of parsedHints) {
    const axisText = `${hint.primaryAxis || ""} ${hint["组织方式"] || ""}`;
    if (countMatches(axisText, ["人物", "哲学家"])) scores.person_driven += 4;
    if (countMatches(axisText, ["概念"])) scores.concept_driven += 4;
    if (countMatches(axisText, ["时间", "年表"])) scores.chronology_driven += 4;
    if (countMatches(axisText, ["问题"])) scores.problem_driven += 4;
    if (countMatches(axisText, ["方法"])) scores.method_driven += 4;
    if (countMatches(axisText, ["章节"])) scores.chapter_driven += 4;
    if (countMatches(axisText, ["论证"])) scores.argument_driven += 4;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [winner, score] = ranked[0] || ["mixed_structure", 0];
  const second = ranked[1]?.[1] || 0;
  if (score < 2 || score - second < 1) {
    return { structureType: "mixed_structure", confidence: 0.52, scores };
  }
  return {
    structureType: winner,
    confidence: Math.min(0.9, 0.58 + score / 20),
    scores,
  };
}

function shouldRefresh(existing, force = false) {
  if (force || !existing) return true;
  if (existing.manualOverride) return false;
  if (
    existing.structureVersion !== BookStructureAnalysis.BOOK_STRUCTURE_VERSION
  )
    return true;
  if (!existing.lastAnalyzedAt) return true;
  return Date.now() - new Date(existing.lastAnalyzedAt).getTime() > ONE_DAY_MS;
}

async function analyzeBookStructure({
  workspace,
  profile = null,
  docs = [],
  workspaceSupplements = [],
  force = false,
  override = null,
} = {}) {
  const workspaceId = Number(workspace?.id || workspace);
  const existing = await BookStructureAnalysis.get(workspaceId);

  if (
    override?.structureType ||
    override?.primaryAxis ||
    override?.secondaryAxes
  ) {
    const type =
      override.structureType || existing?.structureType || "mixed_structure";
    const base = labelForType(type);
    return await BookStructureAnalysis.upsert(workspaceId, {
      ...base,
      structureType: type,
      confidence: 1,
      primaryAxis: override.primaryAxis || base.primaryAxis,
      secondaryAxes: override.secondaryAxes || base.secondaryAxes,
      manualOverride: true,
      overrideSource: override.source || "user",
      overrideReason: override.reason || "",
      originalStructureType:
        existing?.originalStructureType || existing?.structureType || null,
      originalConfidence:
        existing?.originalConfidence ?? existing?.confidence ?? null,
      metadata: {
        ...(existing?.metadata || {}),
        profileType: profile?.profileType,
      },
    });
  }

  if (!shouldRefresh(existing, force)) return existing;

  const [entityCounts, relationCounts] = await Promise.all([
    entityTypeCounts(workspaceId),
    relationTypeCounts(workspaceId),
  ]);
  const detected = detectStructure({
    docs,
    entityCounts,
    relationCounts,
    userDescription: profile?.userDescription || "",
    workspaceSupplements,
  });
  const base = labelForType(detected.structureType);
  const parsedStructure = workspaceSupplements.find(
    (item) => item.supplementKind === "structure_json" && item.parsedStructure
  )?.parsedStructure;
  return await BookStructureAnalysis.upsert(workspaceId, {
    ...base,
    structureType: detected.structureType,
    confidence: detected.confidence,
    primaryAxis: parsedStructure?.primaryAxis || base.primaryAxis,
    secondaryAxes: parsedStructure?.secondaryAxes || base.secondaryAxes,
    structureVersion: BookStructureAnalysis.BOOK_STRUCTURE_VERSION,
    manualOverride: false,
    metadata: {
      scores: detected.scores,
      entityCounts,
      relationCounts,
      profileType: profile?.profileType,
      workspaceSupplements: workspaceSupplements.map((item) => ({
        documentId: item.documentId,
        supplementKind: item.supplementKind,
        weight: item.weight,
        structureJsonValid: item.structureJsonValid,
      })),
    },
  });
}

module.exports = {
  analyzeBookStructure,
  detectStructure,
  labelForType,
};
