const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const crypto = require("crypto");
const knowledgeGraphDb = KnowledgeGraphData.db;
const { workspaceSupplementKindLabel } = require("./supplementConstants");

const FORMULA_VERSION = "knowledge-engine-rec-v1";
const SUPPLEMENT_BOOST_CAP = 4;

function displayName(node = {}) {
  return (
    node.displayNameZh ||
    node.displayNameEn ||
    node.canonicalName ||
    node.concept ||
    ""
  );
}

function idFor({ workspaceId, type, targetType, targetId }) {
  return crypto
    .createHash("sha256")
    .update(
      [type, targetType, targetId, workspaceId, FORMULA_VERSION].join("|")
    )
    .digest("hex");
}

async function learningStatesFor({ workspaceId, userId = 0, nodeKeys = [] }) {
  const unique = [...new Set(nodeKeys.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const rows = await knowledgeGraphDb
    .$queryRawUnsafe(
      `SELECT * FROM "NodeLearningState"
    WHERE "workspaceId" = ? AND "userId" = ? AND "nodeKey" IN (${unique
      .map(() => "?")
      .join(",")})`,
      Number(workspaceId),
      Number(userId || 0),
      ...unique
    )
    .catch(() => []);
  return new Map(rows.map((row) => [row.nodeKey, row]));
}

function profileMode(profile = {}, bookStructure = {}) {
  if (profile?.profileType !== "book") return profile?.profileType || "mixed";
  return bookStructure?.structureType || "mixed_structure";
}

function profileModeLabel(mode = "mixed") {
  return (
    {
      book: "书籍",
      course: "课程",
      research: "研究",
      project: "项目",
      loose_notes: "零散笔记",
      mixed: "混合资料",
      person_driven: "人物驱动",
      concept_driven: "概念驱动",
      chronology_driven: "时间驱动",
      problem_driven: "问题驱动",
      method_driven: "方法驱动",
      chapter_driven: "章节驱动",
      argument_driven: "论证驱动",
      mixed_structure: "混合结构",
    }[mode] || "混合资料"
  );
}

function axisWeight(node = {}, bookStructure = {}) {
  const type = node.entityType || "concept";
  const primary = String(bookStructure?.primaryAxis || "");
  if (primary.includes("人物") && type === "person") return 1;
  if (primary.includes("概念") && type === "concept") return 1;
  if (primary.includes("时间") && ["era", "event"].includes(type)) return 1;
  if (primary.includes("问题") && ["question", "problem"].includes(type))
    return 1;
  if (primary.includes("方法") && ["method", "task"].includes(type)) return 1;
  if (primary.includes("章节") && type === "chapter") return 1;
  if (primary.includes("论证") && ["argument", "claim"].includes(type))
    return 1;
  const secondary = bookStructure?.secondaryAxes || [];
  return secondary.some((axis) => String(axis).includes(type)) ? 0.7 : 0.45;
}

function withFeedback(candidate, feedback = new Map()) {
  const item = feedback.get(candidate.recommendationId);
  if (!item) return { hidden: false, candidate };
  const cooldown =
    item.cooldownUntil && new Date(item.cooldownUntil).getTime() > Date.now();
  if (cooldown) return { hidden: true, candidate };
  const dismissPenalty = Math.min(28, Number(item.dismissCount || 0) * 12);
  const fatiguePenalty =
    Number(item.impressionCount || 0) > 3 && Number(item.clickCount || 0) === 0
      ? Math.min(18, Number(item.impressionCount || 0) * 3)
      : 0;
  return {
    hidden: false,
    candidate: {
      ...candidate,
      score: Math.max(0, candidate.score - dismissPenalty - fatiguePenalty),
      feedback: {
        impressionCount: Number(item.impressionCount || 0),
        clickCount: Number(item.clickCount || 0),
        dismissCount: Number(item.dismissCount || 0),
        cooldownUntil: item.cooldownUntil,
      },
    },
  };
}

function buildCandidate({
  workspaceId,
  type,
  category,
  title,
  target,
  baseScore,
  reasonZh = [],
  refs = [],
}) {
  const targetType = target?.targetType || "node";
  const targetId = String(
    target?.targetId || target?.nodeId || target?.nodeKey || title
  );
  const supplementBoost = Math.min(
    SUPPLEMENT_BOOST_CAP,
    target?.hasSupplement ? Math.max(1, Number(target.supplementCount || 1)) : 0
  );
  return {
    recommendationId: idFor({ workspaceId, type, targetType, targetId }),
    formulaVersion: FORMULA_VERSION,
    type,
    category: category || type,
    title,
    target: { ...target, targetType, targetId },
    score: Math.min(100, Math.round(baseScore) + supplementBoost),
    confidence: 78,
    reasonCodes: ["knowledge_engine_candidate"],
    reasonZh,
    normalizedInputs: {
      engine: "workspace_knowledge_engine",
      supplementBoost,
    },
    hasSupplement: Boolean(target?.hasSupplement),
    supplementCount: Number(target?.supplementCount || 0),
    supplementTitles: target?.supplementTitles || [],
    refs,
  };
}

function targetForNode(node = {}) {
  return {
    targetType: "node",
    targetId: String(node.id),
    nodeId: node.id,
    nodeKey: node.nodeKey,
    canonicalKey: node.canonicalKey,
    nodeType: node.entityType || "concept",
    concept: node.canonicalName,
    displayName: displayName(node),
    hasSupplement: Boolean(node.hasSupplement),
    supplementCount: Number(node.supplementCount || 0),
    supplementTitles: node.supplementTitles || [],
    supplementDocumentIds: node.supplementDocumentIds || [],
  };
}

async function buildKnowledgeEngineRecommendations({
  workspaceId,
  userId = 0,
  profile,
  bookStructure,
  nodes = [],
  paths = [],
  feedback = new Map(),
  workspaceSupplements = [],
}) {
  const learning = await learningStatesFor({
    workspaceId,
    userId,
    nodeKeys: nodes.map((node) => node.nodeKey).filter(Boolean),
  });
  const mode = profileMode(profile, bookStructure);
  const modeLabel = profileModeLabel(mode);
  const candidates = [];
  const ranked = [...nodes]
    .map((node) => {
      const state = learning.get(node.nodeKey) || {};
      const weakness =
        Number(state.wrongCount || 0) > Number(state.correctCount || 0)
          ? 18
          : 0;
      const unfinished =
        Number(state.viewedCount || 0) > 0 &&
        Number(state.masteryScore || 0) < 0.45
          ? 12
          : 0;
      const score =
        Number(node.workspaceImportanceScore || 0) * 34 +
        Number(node.recentImportanceScore || 0) * 18 +
        axisWeight(node, bookStructure) * 18 +
        Math.min(16, Number(node.evidenceCount || 0)) +
        weakness +
        unfinished;
      return { node, state, score };
    })
    .sort((a, b) => b.score - a.score);

  for (const item of ranked.slice(0, 7)) {
    const node = item.node;
    const target = targetForNode(node);
    const type =
      item.state?.wrongCount > item.state?.correctCount
        ? "repair_node"
        : item.state?.viewedCount > 0
          ? "review_node"
          : "focus_node";
    candidates.push(
      buildCandidate({
        workspaceId,
        type,
        category: type === "focus_node" ? "focus" : "continue",
        title: `${displayName(node)}：${type === "repair_node" ? "修复薄弱点" : type === "review_node" ? "继续复习" : "作为焦点节点"}`,
        target,
        baseScore: item.score,
        reasonZh: [
          `来自${profile?.profileType === "book" ? "书籍结构" : "工作区知识画像"}的${modeLabel}主导脉络。`,
          node.hasSupplement
            ? "该节点已有补充文档，可用于更具体的深挖。"
            : "该节点在知识图谱中具有较高结构价值。",
        ],
        refs: [{ type: "node", id: node.id }],
      })
    );
  }

  for (const node of ranked
    .filter((item) => item.node.hasSupplement)
    .slice(0, 4)
    .map((item) => item.node)) {
    candidates.push(
      buildCandidate({
        workspaceId,
        type: "deep_dive_node",
        category: "curiosity",
        title: `深挖 ${displayName(node)}`,
        target: targetForNode(node),
        baseScore:
          56 +
          Number(node.workspaceImportanceScore || 0) * 18 +
          Number(node.supplementCount || 0) * 2,
        reasonZh: [
          "该节点绑定了补充文档，适合把节点理解推进到更具体的证据层。",
          "补充文档只提供轻量加分，不会覆盖冷却或忽略规则。",
        ],
        refs: [{ type: "node", id: node.id }],
      })
    );
  }

  for (const path of paths.slice(0, 4)) {
    candidates.push(
      buildCandidate({
        workspaceId,
        type: "continue_path",
        category: "continue",
        title: `继续路径：${path.summary || path.pathType}`,
        target: {
          targetType: "path",
          targetId: path.pathId,
          pathType: path.pathType,
          sourceConcept: path.nodes?.[0]?.canonicalName,
          targetConcept: path.nodes?.[1]?.canonicalName,
        },
        baseScore: 62 + Number(path.learningValue || 0) * 0.25,
        reasonZh: [
          "该路径由知识图谱结构解析产生，不依赖旧首页的零散活动信号。",
          "适合按当前工作区主导脉络继续推进。",
        ],
        refs: [{ type: "path", id: path.pathId }],
      })
    );
  }

  for (const supplement of workspaceSupplements.slice(0, 3)) {
    candidates.push(
      buildCandidate({
        workspaceId,
        type:
          profile?.profileType === "book"
            ? "continue_path"
            : "organize_cluster",
        category: "focus",
        title:
          profile?.profileType === "book"
            ? `依据全书补充推进：${supplement.documentName}`
            : `整理补充资料：${supplement.documentName}`,
        target: {
          targetType: "document",
          targetId: supplement.documentId,
          documentId: supplement.documentId,
          supplementScope: "workspace",
          supplementKind: supplement.supplementKind,
        },
        baseScore: 54 + Math.min(24, Number(supplement.weight || 0) * 0.18),
        reasonZh: [
          "该候选来自全书/工作区补充，不是旧首页零散活动逻辑。",
          `${workspaceSupplementKindLabel(supplement.supplementKind)}使用统一权重表参与结构化推荐。`,
        ],
        refs: [{ type: "document", id: supplement.documentId }],
      })
    );
  }

  if (["loose_notes", "mixed"].includes(profile?.profileType)) {
    for (const node of ranked.slice(0, 3).map((item) => item.node)) {
      candidates.push(
        buildCandidate({
          workspaceId,
          type: "organize_cluster",
          category: "gap",
          title: `整理主题簇：${displayName(node)}`,
          target: targetForNode(node),
          baseScore: 58 + Number(node.evidenceCount || 0),
          reasonZh: [
            "该工作区更像零散或混合资料，推荐优先围绕主题簇和问题整理。",
            "适合归纳相关资料、已有结论和待澄清问题。",
          ],
          refs: [{ type: "node", id: node.id }],
        })
      );
    }
  }

  const deduped = new Map();
  for (const candidate of candidates) {
    const adjusted = withFeedback(candidate, feedback);
    if (adjusted.hidden) continue;
    const existing = deduped.get(candidate.recommendationId);
    if (!existing || adjusted.candidate.score > existing.score)
      deduped.set(candidate.recommendationId, adjusted.candidate);
  }
  return [...deduped.values()].sort((a, b) => b.score - a.score);
}

module.exports = {
  FORMULA_VERSION,
  buildKnowledgeEngineRecommendations,
};
