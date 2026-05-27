const prisma = require("../prisma");
const { safeJsonParse } = require("../http");
const { chunksForDocument } = require("./chunks");
const {
  WorkspaceKnowledgeProfile,
} = require("../../models/workspaceKnowledgeProfile");
const { analyzeBookStructure } = require("./bookStructureAnalyzer");
const {
  workspaceSupplementsWithContent,
  supplementSignalText,
} = require("./workspaceSupplementResolver");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MANY_DOCUMENTS_ADDED_THRESHOLD = 5;

const USER_DESCRIPTION_TEMPLATE = [
  "资料类型：书籍 / 课程 / 研究资料 / 项目资料 / 零散笔记 / 混合资料",
  "主文档：哪一个文档是核心文本，或说明没有主文档",
  "主题范围：这批资料主要讨论什么，也请说明不讨论什么",
  "组织方式：按人物、概念、时间、问题、方法、章节、论证，还是混合",
  "学习目标：理解、复习、研究、整理、备考，还是项目推进",
  "重要对象：关键人物、概念、问题、方法、事件、论证、章节",
  "推荐偏好：主线推进、薄弱点修复、概念对比、问题整理、深挖资料",
  "禁止误判：例如不要强行按人物线、章节线或时间线组织",
  "语言偏好：中文名、英文名、双语标签如何展示",
].join("\n");

function lower(value = "") {
  return String(value || "").toLowerCase();
}

function includesAny(text, keywords = []) {
  const haystack = lower(text);
  return keywords.some((keyword) => haystack.includes(lower(keyword)));
}

function scoreKeywords(docs = [], keywords = []) {
  const haystack = docs
    .map((doc) => `${doc.filename || ""} ${doc.docpath || ""}`)
    .join("\n");
  return keywords.reduce(
    (score, keyword) => score + (includesAny(haystack, [keyword]) ? 1 : 0),
    0
  );
}

async function documentStats(workspaceId) {
  const docs = await prisma.workspace_documents.findMany({
    where: { workspaceId: Number(workspaceId) },
    orderBy: { lastUpdatedAt: "desc" },
  });
  const stats = [];
  for (const doc of docs.slice(0, 30)) {
    const chunks = await chunksForDocument(doc).catch(() => []);
    const sample = chunks
      .slice(0, 8)
      .map((chunk) => chunk.text)
      .join("\n")
      .slice(0, 18_000);
    stats.push({
      docId: doc.docId,
      filename: doc.filename,
      docpath: doc.docpath,
      metadata: safeJsonParse(doc.metadata, {}),
      chunkCount: chunks.length,
      sample,
      charCount: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      lastUpdatedAt: doc.lastUpdatedAt,
    });
  }
  return stats;
}

function dominantDocuments(docs = []) {
  const totalChars = docs.reduce(
    (sum, doc) => sum + Number(doc.charCount || 0),
    0
  );
  const ranked = [...docs].sort((a, b) => b.charCount - a.charCount);
  const top = ranked[0];
  return {
    totalChars,
    top,
    topShare: totalChars > 0 && top ? top.charCount / totalChars : 0,
    primaryDocumentIds: ranked
      .filter(
        (doc, index) =>
          index < 3 && doc.charCount >= (top?.charCount || 0) * 0.25
      )
      .map((doc) => doc.docId),
  };
}

function inferMainTopic(docs = [], userDescription = "") {
  if (userDescription) return userDescription.split(/\n|。/)[0].slice(0, 120);
  const first = docs.find((doc) => doc.filename || doc.docpath);
  return String(first?.filename || first?.docpath || "Workspace").replace(
    /\.[^.]+$/,
    ""
  );
}

function detectProfile({ docs = [], userDescription = "" }) {
  const joined = docs
    .map(
      (doc) => `${doc.filename} ${doc.docpath}\n${doc.sample.slice(0, 2500)}`
    )
    .join("\n");
  const dominance = dominantDocuments(docs);
  const hasBookStructure =
    dominance.topShare >= 0.55 ||
    includesAny(joined, [
      "目录",
      "chapter",
      "第1章",
      "第一章",
      "contents",
      "preface",
    ]);
  const courseScore = scoreKeywords(docs, [
    "课程",
    "讲义",
    "作业",
    "单元",
    "lesson",
    "lecture",
    "syllabus",
  ]);
  const researchScore = scoreKeywords(docs, [
    "paper",
    "论文",
    "citation",
    "实验",
    "methodology",
    "研究",
    "report",
  ]);
  const projectScore = scoreKeywords(docs, [
    "prd",
    "roadmap",
    "bug",
    "需求",
    "任务",
    "会议",
    "架构",
    "design",
  ]);
  const shortDocRatio =
    docs.length > 0
      ? docs.filter((doc) => Number(doc.charCount || 0) < 4_000).length /
        docs.length
      : 0;
  const userHint = lower(userDescription);
  if (
    includesAny(userHint, [
      '"资料类型":"书籍"',
      '"资料类型": "书籍"',
      "资料类型：书籍",
    ])
  ) {
    return {
      profileType: "book",
      confidence: 0.9,
      reason: "structure_json_book",
    };
  }

  if (includesAny(userHint, ["书", "book", "教材", "专著"])) {
    return { profileType: "book", confidence: 0.86, reason: "user_hint_book" };
  }
  if (includesAny(userHint, ["课程", "course", "讲义"])) {
    return {
      profileType: "course",
      confidence: 0.84,
      reason: "user_hint_course",
    };
  }
  if (includesAny(userHint, ["项目", "project", "prd", "roadmap"])) {
    return {
      profileType: "project",
      confidence: 0.84,
      reason: "user_hint_project",
    };
  }
  if (includesAny(userHint, ["研究", "research", "论文"])) {
    return {
      profileType: "research",
      confidence: 0.84,
      reason: "user_hint_research",
    };
  }
  if (hasBookStructure && docs.length <= 5) {
    return {
      profileType: "book",
      confidence: dominance.topShare >= 0.55 ? 0.78 : 0.68,
      reason: "long_structured_document",
    };
  }
  if (courseScore >= 2)
    return {
      profileType: "course",
      confidence: 0.72,
      reason: "course_title_signals",
    };
  if (researchScore >= 2)
    return {
      profileType: "research",
      confidence: 0.72,
      reason: "research_title_signals",
    };
  if (projectScore >= 2)
    return {
      profileType: "project",
      confidence: 0.72,
      reason: "project_title_signals",
    };
  if (docs.length >= 6 && shortDocRatio >= 0.65)
    return {
      profileType: "loose_notes",
      confidence: 0.7,
      reason: "many_short_documents",
    };
  if (docs.length === 0)
    return {
      profileType: "loose_notes",
      confidence: 0.35,
      reason: "empty_workspace",
    };
  return {
    profileType: "mixed",
    confidence: 0.55,
    reason: "mixed_or_unclear_signals",
  };
}

function suggestedStrategy(profileType) {
  switch (profileType) {
    case "book":
      return "book_structure_first";
    case "course":
      return "unit_goal_prerequisite_graph";
    case "research":
      return "source_claim_evidence_question_graph";
    case "project":
      return "requirement_decision_task_risk_graph";
    case "loose_notes":
      return "topic_cluster_question_idea_graph";
    default:
      return "mixed_cluster_and_path_graph";
  }
}

async function shouldRefresh({ existing, force = false, docs }) {
  if (force || !existing) return true;
  if (existing.manualOverride) return false;
  if (existing.profileVersion !== WorkspaceKnowledgeProfile.PROFILE_VERSION)
    return true;
  if (!existing.lastAnalyzedAt) return true;
  if (Date.now() - new Date(existing.lastAnalyzedAt).getTime() > ONE_DAY_MS)
    return true;
  const previousCount = Number(existing.metadata?.documentCount || 0);
  if (docs.length - previousCount >= MANY_DOCUMENTS_ADDED_THRESHOLD)
    return true;
  const previousPrimary = (existing.primaryDocumentIds || []).join("|");
  const nextPrimary = dominantDocuments(docs).primaryDocumentIds.join("|");
  return Boolean(
    previousPrimary &&
      nextPrimary &&
      previousPrimary !== nextPrimary &&
      docs.length
  );
}

async function buildWorkspaceKnowledgeProfile({
  workspace,
  force = false,
  userDescription = "",
  override = null,
} = {}) {
  const workspaceId = Number(workspace?.id || workspace);
  const existing = await WorkspaceKnowledgeProfile.get(workspaceId);
  const docs = await documentStats(workspaceId);
  const workspaceSupplements = await workspaceSupplementsWithContent({
    workspaceId,
    limit: 12,
  });
  const supplementText = supplementSignalText(
    workspaceSupplements.filter(
      (item) =>
        item.supplementKind !== "structure_json" || item.structureJsonValid
    )
  );
  const effectiveUserDescription = [
    supplementText,
    userDescription || existing?.userDescription || "",
  ]
    .filter(Boolean)
    .join("\n\n");

  if (override?.profileType) {
    const profile = await WorkspaceKnowledgeProfile.upsert(workspaceId, {
      ...(existing || {}),
      profileType: override.profileType,
      confidence: 1,
      primaryDocumentIds:
        existing?.primaryDocumentIds ||
        dominantDocuments(docs).primaryDocumentIds,
      mainTopic:
        existing?.mainTopic || inferMainTopic(docs, effectiveUserDescription),
      detectedStructure: existing?.detectedStructure || {},
      suggestedGraphStrategy: suggestedStrategy(override.profileType),
      manualOverride: true,
      overrideSource: override.source || "user",
      overrideReason: override.reason || "",
      originalProfileType:
        existing?.originalProfileType || existing?.profileType || null,
      originalConfidence:
        existing?.originalConfidence ?? existing?.confidence ?? null,
      userDescription: userDescription || existing?.userDescription || "",
      metadata: { ...(existing?.metadata || {}), documentCount: docs.length },
    });
    return {
      profile,
      bookStructure: await maybeAnalyzeBook({
        workspace,
        profile,
        docs,
        workspaceSupplements,
        force: true,
      }),
    };
  }

  const needsRefresh = await shouldRefresh({ existing, force, docs });
  if (!needsRefresh) {
    return {
      profile: existing,
      bookStructure: await maybeAnalyzeBook({
        workspace,
        profile: existing,
        docs,
        workspaceSupplements,
        force,
      }),
    };
  }

  const detected = detectProfile({
    docs,
    userDescription: effectiveUserDescription,
  });
  const dominance = dominantDocuments(docs);
  const profile = await WorkspaceKnowledgeProfile.upsert(workspaceId, {
    profileType: detected.profileType,
    confidence: detected.confidence,
    primaryDocumentIds: dominance.primaryDocumentIds,
    mainTopic: inferMainTopic(docs, effectiveUserDescription),
    detectedStructure: {
      reason: detected.reason,
      topDocumentShare: Number(dominance.topShare.toFixed(3)),
      documentCount: docs.length,
      workspaceSupplementCount: workspaceSupplements.length,
      highStructureSupplementCount: workspaceSupplements.filter(
        (item) => item.highStructureValue
      ).length,
      topDocument: dominance.top?.filename || dominance.top?.docpath || null,
    },
    suggestedGraphStrategy: suggestedStrategy(detected.profileType),
    profileVersion: WorkspaceKnowledgeProfile.PROFILE_VERSION,
    manualOverride: false,
    userDescription: userDescription || existing?.userDescription || "",
    metadata: {
      documentCount: docs.length,
      totalChars: dominance.totalChars,
      workspaceSupplements: workspaceSupplements.map((item) => ({
        documentId: item.documentId,
        supplementKind: item.supplementKind,
        weight: item.weight,
        structureJsonValid: item.structureJsonValid,
      })),
      refreshedBecause: force
        ? "manual_refresh"
        : existing
          ? "cache_policy"
          : "first_build",
    },
  });
  return {
    profile,
    bookStructure: await maybeAnalyzeBook({
      workspace,
      profile,
      docs,
      workspaceSupplements,
      force,
    }),
  };
}

async function maybeAnalyzeBook({
  workspace,
  profile,
  docs,
  workspaceSupplements = [],
  force = false,
}) {
  if (profile?.profileType !== "book") return null;
  return await analyzeBookStructure({
    workspace,
    profile,
    docs,
    workspaceSupplements,
    force,
  });
}

module.exports = {
  USER_DESCRIPTION_TEMPLATE,
  buildWorkspaceKnowledgeProfile,
  detectProfile,
  documentStats,
};
