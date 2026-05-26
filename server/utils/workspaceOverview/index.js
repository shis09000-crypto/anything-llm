const crypto = require("crypto");
const prisma = require("../prisma");
const { safeJsonParse } = require("../http");
const { healthBeacon, unknownBeacon } = require("../workspaceHealth/beacon");

const FORMULA_VERSION = "overview-rec-v1";
const DAY_MS = 86_400_000;
const DISMISS_COOLDOWN_DAYS = 7;
const MAX_RECOMMENDATIONS = 18;
const OVERVIEW_CACHE_TTL_MS = 60_000;
const OVERVIEW_ERROR_CACHE_TTL_MS = 5_000;

const overviewCache = new Map();
const overviewInflight = new Map();

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
    return await prisma.$queryRawUnsafe(query, ...params);
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
}

async function getNodes(workspaceId) {
  const rows = await optionalQuery(
    `SELECT
      n."id", n."canonicalName", n."displayNameZh", n."displayNameEn",
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
        SUM(CASE WHEN ev."createdAt" >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS "recentEvidenceCount"
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
    Number(workspaceId)
  );

  return rows.map((row) => ({
    ...row,
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
    WHERE "workspaceId" = ? AND "include" = 1 ${userClause} ${threadClause}
    ORDER BY "lastUpdatedAt" DESC LIMIT 20`,
    ...params
  );
  return { chats: rows, activeThread: threadRows?.[0] || null };
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
    concept: node.canonicalName,
    displayName: displayName(node),
  };
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
    ...(components.extra || {}),
  };
  const score =
    normalizedInputs.workspaceImportance * 0.2 +
    normalizedInputs.personalFocus * 0.25 +
    normalizedInputs.recentInterest * 0.2 +
    normalizedInputs.unfinishedExploration * 0.15 +
    normalizedInputs.novelty * 0.1 +
    normalizedInputs.curiosity * 0.1;
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
    score: Math.round(clamp(score) * 100),
    confidence: Math.round(clamp(confidence) * 100),
    reasonCodes,
    reasonZh,
    normalizedInputs,
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
}) {
  const workspaceId = Number(workspace.id);
  const userId = Number(user?.id || 0);
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

  const sessionConcepts = conceptsFromChats(chatData.chats, nodes);
  const unfinishedExplorations = buildUnfinishedExplorations({
    workspaceId,
    nodes,
    usageRows,
    feedback,
  });
  const recommendations = buildRecommendations({
    workspaceId,
    nodes,
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
  const personalizedRecommendations = diversityPick([
    ...unfinishedExplorations,
    ...recommendations,
    ...documentFallbackRecommendations,
  ]);
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

  const topFocus = personalizedRecommendations
    .filter((item) => ["continue", "focus"].includes(item.category))
    .slice(0, 3);
  const hasAnyOverviewData =
    nodes.length > 0 ||
    recentDocuments.length > 0 ||
    chatData.chats.length > 0 ||
    activity.length > 0;
  return {
    workspace: {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
    },
    generatedAt: new Date().toISOString(),
    formulaVersion: FORMULA_VERSION,
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
    personalizedRecommendations,
    unfinishedExplorations,
    curiosityRecommendations: personalizedRecommendations.filter((item) =>
      ["gap", "conflict", "curiosity"].includes(item.category)
    ),
    recommendedExploration: personalizedRecommendations,
    knowledgeMomentum: {
      fastestGrowingConcepts: nodes
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
      nodeCount: nodes.length,
      documentFallbackCount: documentFallbackRecommendations.length,
      usageSignalCount: usageRows.length,
      feedbackCount: feedback.size,
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

  const promise = buildWorkspaceOverviewUncached(params)
    .then((overview) => {
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
        prisma.$queryRawUnsafe(
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
      prisma.$executeRawUnsafe(
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
};
