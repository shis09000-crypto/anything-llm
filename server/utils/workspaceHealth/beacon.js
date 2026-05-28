const prisma = require("../prisma");
const { KnowledgeGraph } = require("../../models/knowledgeGraph");

const CACHE_TTL_MS = 30_000;
const REFRESH_COOLDOWN_MS = 30_000;

const beaconCache = new Map();
const refreshCooldowns = new Map();

function countFrom(rows) {
  return Number(rows?.[0]?.count || 0);
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function statusForScore(score) {
  if (score === null || score === undefined) return "unknown";
  if (score >= 90) return "healthy";
  if (score >= 70) return "warning";
  if (score >= 50) return "degraded";
  return "critical";
}

function statusLabel(status) {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "warning":
      return "Warning";
    case "degraded":
      return "Warning";
    case "critical":
      return "Critical";
    default:
      return "Unknown";
  }
}

function unknownBeacon(workspaceSlug, message = "健康状态暂时不可用") {
  const now = new Date().toISOString();
  return {
    workspaceSlug,
    score: null,
    status: "unknown",
    statusLabel: statusLabel("unknown"),
    processing: false,
    unknown: true,
    summary: message,
    topIssues: [],
    processingMessages: [],
    latestActivities: [],
    lastUpdatedAt: now,
    dataFreshness: {
      label: "未知",
      ageMs: null,
    },
    sourceTimes: {
      summaryCacheUpdatedAt: null,
      latestActivityAt: null,
      latestWorkerHeartbeatAt: null,
    },
    advanced: {},
    cooldownRemainingMs: 0,
  };
}

function issue(title, detail, severity = "warning") {
  return { title, detail, severity };
}

function deduction(key, title, points, detail, severity = "warning") {
  return {
    key,
    title,
    points: Math.max(0, Number(points || 0)),
    detail,
    severity,
  };
}

function freshnessFrom(timestamp) {
  if (!timestamp) return { label: "暂无来源时间", ageMs: null };
  const ageMs = Date.now() - new Date(timestamp).getTime();
  if (Number.isNaN(ageMs)) return { label: "暂无来源时间", ageMs: null };
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (minutes < 1) return { label: "刚刚更新", ageMs };
  if (minutes < 60) return { label: `${minutes} 分钟前更新`, ageMs };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { label: `${hours} 小时前更新`, ageMs };
  return { label: `${Math.floor(hours / 24)} 天前更新`, ageMs };
}

async function optionalQuery(query, ...params) {
  try {
    return await prisma.$queryRawUnsafe(query, ...params);
  } catch {
    return [];
  }
}

async function metricsSummary(workspaceId) {
  const [
    stale,
    total,
    warnings,
    staleWarnings,
    locked,
    latestRun,
    latestMetricsUpdate,
  ] = await Promise.all([
    optionalQuery(
      `SELECT COUNT(*) AS count FROM "KnowledgeNodeMetrics" WHERE "workspaceId" = ? AND "stale" = 1`,
      Number(workspaceId)
    ),
    optionalQuery(
      `SELECT COUNT(*) AS count FROM "KnowledgeNodeMetrics" WHERE "workspaceId" = ?`,
      Number(workspaceId)
    ),
    optionalQuery(
      `SELECT COUNT(*) AS count FROM "KnowledgeNodeMetrics"
       WHERE "workspaceId" = ? AND "stale" = 0
         AND "warning" IS NOT NULL AND "warning" != ''`,
      Number(workspaceId)
    ),
    optionalQuery(
      `SELECT COUNT(*) AS count FROM "KnowledgeNodeMetrics"
       WHERE "workspaceId" = ? AND "stale" = 1
         AND "warning" IS NOT NULL AND "warning" != ''`,
      Number(workspaceId)
    ),
    optionalQuery(
      `SELECT COUNT(*) AS count FROM "KnowledgeNodeMetrics"
       WHERE "workspaceId" = ? AND "lockedAt" IS NOT NULL
         AND "lockedAt" >= datetime('now', '-15 minutes')`,
      Number(workspaceId)
    ),
    optionalQuery(
      `SELECT * FROM "KnowledgeNodeMetricsRecomputeRun"
       WHERE "workspaceId" = ? ORDER BY "createdAt" DESC LIMIT 1`,
      Number(workspaceId)
    ),
    optionalQuery(
      `SELECT MAX("updatedAt") AS "latestAt" FROM "KnowledgeNodeMetrics" WHERE "workspaceId" = ?`,
      Number(workspaceId)
    ),
  ]);

  return {
    total: countFrom(total),
    stale: countFrom(stale),
    warnings: countFrom(warnings),
    staleWarningCount: countFrom(staleWarnings),
    locked: countFrom(locked),
    latestRun: latestRun?.[0] || null,
    latestAt: latestMetricsUpdate?.[0]?.latestAt || null,
  };
}

async function cacheSummary(workspaceId) {
  const [graphCache, expiredGraphCache] = await Promise.all([
    optionalQuery(
      `SELECT COUNT(*) AS count FROM "GraphRetrievalCache" WHERE "workspaceId" = ?`,
      Number(workspaceId)
    ),
    optionalQuery(
      `SELECT COUNT(*) AS count FROM "GraphRetrievalCache"
       WHERE "workspaceId" = ? AND "expiresAt" <= datetime('now')`,
      Number(workspaceId)
    ),
  ]);
  return {
    graphTraversalEntries: countFrom(graphCache),
    staleGraphTraversalEntries: countFrom(expiredGraphCache),
  };
}

async function latestGraphActivities(workspaceId) {
  const [jobs, repairRuns, metricRuns] = await Promise.all([
    optionalQuery(
      `SELECT "status", "documentId", "chunkId", "updatedAt", "errorMessage"
       FROM "GraphExtractionJob"
       WHERE "workspaceId" = ?
       ORDER BY "updatedAt" DESC LIMIT 5`,
      Number(workspaceId)
    ),
    optionalQuery(
      `SELECT "repaired", "failed", "skipped", "durationMs", "createdAt"
       FROM "KnowledgeGraphRepairRun"
       WHERE "workspaceId" = ?
       ORDER BY "createdAt" DESC LIMIT 3`,
      Number(workspaceId)
    ),
    optionalQuery(
      `SELECT "trigger", "processed", "succeeded", "failed", "durationMs", "createdAt"
       FROM "KnowledgeNodeMetricsRecomputeRun"
       WHERE "workspaceId" = ?
       ORDER BY "createdAt" DESC LIMIT 3`,
      Number(workspaceId)
    ),
  ]);

  const activities = [];
  jobs.forEach((job) => {
    activities.push({
      type: "kg",
      title:
        job.status === "completed"
          ? "完成 KG extraction"
          : job.status === "failed"
            ? "KG extraction 失败"
            : `KG extraction ${job.status}`,
      detail: `${job.documentId || "未知文档"} / ${job.chunkId || "未知 chunk"}`,
      severity: job.status === "failed" ? "critical" : "info",
      createdAt: job.updatedAt,
    });
  });
  repairRuns.forEach((run) => {
    activities.push({
      type: "repair",
      title: "完成 graph repair 巡检",
      detail: `修复 ${run.repaired || 0} 个，失败 ${run.failed || 0} 个，跳过 ${run.skipped || 0} 个`,
      severity: Number(run.failed || 0) > 0 ? "warning" : "info",
      createdAt: run.createdAt,
    });
  });
  metricRuns.forEach((run) => {
    activities.push({
      type: "metrics",
      title: "重新计算 node metrics",
      detail: `处理 ${run.processed || 0} 个，成功 ${run.succeeded || 0} 个`,
      severity: Number(run.failed || 0) > 0 ? "warning" : "info",
      createdAt: run.createdAt,
    });
  });

  return activities
    .filter((activity) => activity.createdAt)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
}

function metricsWorkerActive(metrics = {}) {
  if (Number(metrics.locked || 0) > 0) return true;
  return false;
}

function buildScore({ graph, repair, metrics, cache }) {
  let score = 100;
  const topIssues = [];
  const processingMessages = [];
  const scoreBreakdown = [];

  function applyDeduction(item) {
    if (!item?.points) return;
    score -= item.points;
    scoreBreakdown.push(item);
  }

  if (graph.failedJobs > 0) {
    const points = Math.min(35, graph.failedJobs * 8);
    applyDeduction(
      deduction(
        "failedJobs",
        "KG extraction 有失败任务",
        points,
        `${graph.failedJobs} 个任务需要检查。`,
        "critical"
      )
    );
    topIssues.push(
      issue(
        "KG extraction 有失败任务",
        `${graph.failedJobs} 个任务需要检查。`,
        "critical"
      )
    );
  }
  if (graph.pendingJobs > 0) {
    applyDeduction(
      deduction(
        "pendingJobs",
        "KG extraction 待处理任务较多",
        Math.min(12, Math.ceil(graph.pendingJobs / 10) * 3),
        `${graph.pendingJobs} 个任务仍在等待处理。`,
        "warning"
      )
    );
  }
  if (graph.processingJobs > 0) {
    processingMessages.push(
      `正在运行 ${graph.processingJobs} 个 KG extraction`
    );
  }
  if (
    graph.backfillStatus === "partial" &&
    graph.pendingJobs === 0 &&
    graph.processingJobs === 0
  ) {
    applyDeduction(
      deduction(
        "partialBackfill",
        "KG 覆盖仍是部分完成",
        6,
        "部分可用文档尚未形成完整图谱覆盖。",
        "warning"
      )
    );
    topIssues.push(
      issue(
        "KG 覆盖仍是部分完成",
        "部分可用文档尚未形成完整图谱覆盖。",
        "warning"
      )
    );
  }
  if (graph.isSparse) {
    applyDeduction(
      deduction(
        "sparseGraph",
        "知识图谱数据较少",
        5,
        "相关概念和 MindMap 结果可能不完整。",
        "warning"
      )
    );
    topIssues.push(
      issue(
        "知识图谱数据较少",
        "相关概念和 MindMap 结果可能不完整。",
        "warning"
      )
    );
  }
  if (graph.missingGraphTextDocuments > 0) {
    const points = Math.min(20, graph.missingGraphTextDocuments * 5);
    applyDeduction(
      deduction(
        "missingGraphTextDocuments",
        "部分文档缺少可恢复文本",
        points,
        `${graph.missingGraphTextDocuments} 个文档无法参与 KG 构建。`,
        "warning"
      )
    );
    topIssues.push(
      issue(
        "部分文档缺少可恢复文本",
        `${graph.missingGraphTextDocuments} 个文档无法参与 KG 构建。`,
        "warning"
      )
    );
  }

  const repairCounts = repair?.counts || {};
  if (repairCounts.quarantined > 0) {
    const points = Math.min(30, repairCounts.quarantined * 10);
    applyDeduction(
      deduction(
        "quarantinedRepairIssues",
        "存在隔离的 graph repair 项",
        points,
        `${repairCounts.quarantined} 个项目暂停自动处理。`,
        "critical"
      )
    );
    topIssues.push(
      issue(
        "存在隔离的 graph repair 项",
        `${repairCounts.quarantined} 个项目暂停自动处理。`,
        "critical"
      )
    );
  }
  if (repairCounts.open > 0) {
    applyDeduction(
      deduction(
        "openRepairIssues",
        "存在待修复 graph 健康问题",
        Math.min(18, repairCounts.open * 4),
        `${repairCounts.open} 个 graph 健康问题正在等待修复。`,
        "warning"
      )
    );
    processingMessages.push(`正在修复 ${repairCounts.open} 个 graph 健康问题`);
  }
  if (repairCounts.needsReembed > 0) {
    const points = Math.min(15, repairCounts.needsReembed * 5);
    applyDeduction(
      deduction(
        "needsReembedIssues",
        "存在需要人工确认的重嵌入项",
        points,
        `${repairCounts.needsReembed} 个项目等待处理。`,
        "warning"
      )
    );
    topIssues.push(
      issue(
        "存在需要人工确认的重嵌入项",
        `${repairCounts.needsReembed} 个项目等待处理。`,
        "warning"
      )
    );
  }
  if (repairCounts.providerFailures7d > 0) {
    const points = Math.min(20, repairCounts.providerFailures7d * 4);
    applyDeduction(
      deduction(
        "providerFailures7d",
        "Provider 近期有失败",
        points,
        `${repairCounts.providerFailures7d} 次失败记录。`,
        "warning"
      )
    );
    topIssues.push(
      issue(
        "Provider 近期有失败",
        `${repairCounts.providerFailures7d} 次失败记录。`,
        "warning"
      )
    );
  }

  if (metrics.stale > 0) {
    if (metricsWorkerActive(metrics)) {
      processingMessages.push(`正在重新计算 ${metrics.stale} 个重要性指标`);
    }
  }
  if (metrics.warnings > 0) {
    const points = Math.min(12, metrics.warnings * 3);
    applyDeduction(
      deduction(
        "metricsWarnings",
        "部分节点指标波动异常",
        points,
        `${metrics.warnings} 个节点需要观察。`,
        "warning"
      )
    );
    topIssues.push(
      issue(
        "部分节点指标波动异常",
        `${metrics.warnings} 个节点需要观察。`,
        "warning"
      )
    );
  }

  const finalScore = clampScore(score);
  return {
    score: finalScore,
    status: statusForScore(finalScore),
    processing: processingMessages.length > 0,
    topIssues: topIssues.slice(0, 5),
    processingMessages: processingMessages.slice(0, 5),
    scoreBreakdown,
    maintenanceInfo: {
      expiredTraversalCacheEntries: cache.staleGraphTraversalEntries || 0,
      cacheNote:
        "Graph traversal 缓存过期是正常 TTL 行为，会按需重建，不影响健康分数。",
      staleWarningCount: metrics.staleWarningCount || 0,
    },
  };
}

async function aggregateBeacon({ workspaceId, workspaceSlug }) {
  const [graph, repair, metrics, cache, latestActivities] = await Promise.all([
    KnowledgeGraph.graphStats(workspaceId, { ensureSchema: false }),
    KnowledgeGraph.repairStatus(workspaceId, {
      ensureSchema: false,
      repairLegacyVectorCache: false,
    }),
    metricsSummary(workspaceId),
    cacheSummary(workspaceId),
    latestGraphActivities(workspaceId),
  ]);

  const score = buildScore({ graph, repair, metrics, cache });
  const now = new Date().toISOString();
  const latestActivityAt = latestActivities?.[0]?.createdAt || null;
  const latestWorkerHeartbeatAt =
    metrics.latestRun?.createdAt ||
    repair?.latestRun?.createdAt ||
    latestActivityAt;
  const sourceTimes = {
    summaryCacheUpdatedAt: now,
    latestActivityAt,
    latestWorkerHeartbeatAt,
  };

  const payload = {
    workspaceSlug,
    score: score.score,
    status: score.status,
    statusLabel: statusLabel(score.status),
    processing: score.processing,
    unknown: false,
    summary:
      score.topIssues.length > 0
        ? "工作区可以使用，但有一些后台状态值得关注。"
        : score.processing
          ? "工作区健康良好，后台任务正在处理中。"
          : "工作区健康状态良好，未发现需要立即处理的问题。",
    topIssues: score.topIssues,
    processingMessages: score.processingMessages,
    scoreBreakdown: score.scoreBreakdown,
    latestActivities,
    lastUpdatedAt: now,
    dataFreshness: freshnessFrom(now),
    sourceTimes,
    advanced: {
      graph: {
        nodes: graph.nodes,
        edges: graph.edges,
        evidence: graph.evidence,
        backfillStatus: graph.backfillStatus,
        processedDocuments: graph.graphProcessedDocuments,
        totalVectorDocuments: graph.totalVectorDocuments,
      },
      queue: {
        pending: graph.pendingJobs,
        processing: graph.processingJobs,
        failed: graph.failedJobs,
        completed: graph.completedJobs,
      },
      repair: repair?.counts || {},
      metrics: {
        total: metrics.total,
        stale: metrics.stale,
        warnings: metrics.warnings,
        staleWarningCount: metrics.staleWarningCount,
        locked: metrics.locked,
        latestRun: metrics.latestRun,
      },
      provider: {
        failureCount7d: repair?.counts?.providerFailures7d || 0,
        state: repair?.counts?.providerFailures7d > 0 ? "degraded" : "online",
      },
      cache,
      maintenance: score.maintenanceInfo,
    },
    cooldownRemainingMs: 0,
  };
  beaconCache.set(workspaceId, { payload, updatedAt: Date.now() });
  return payload;
}

async function healthBeacon({ workspaceId, workspaceSlug, force = false }) {
  const cached = beaconCache.get(workspaceId);
  if (!force && cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return cached.payload;
  }
  try {
    return await aggregateBeacon({ workspaceId, workspaceSlug });
  } catch (error) {
    console.error(
      "[WorkspaceHealth] beacon aggregation failed:",
      error.message
    );
    if (cached?.payload) {
      return {
        ...cached.payload,
        stale: true,
        unknown: false,
        healthStaleReason: "aggregation_failed",
        cooldownRemainingMs: 0,
      };
    }
    return unknownBeacon(workspaceSlug);
  }
}

async function refreshHealthBeacon({
  workspaceId,
  workspaceSlug,
  userKey = "anonymous",
}) {
  const key = `${workspaceId}:${userKey}`;
  const lastRefresh = refreshCooldowns.get(key) || 0;
  const remaining = REFRESH_COOLDOWN_MS - (Date.now() - lastRefresh);
  if (remaining > 0) {
    const payload = await healthBeacon({
      workspaceId,
      workspaceSlug,
      force: false,
    });
    return {
      ...payload,
      cooldownRemainingMs: remaining,
      refreshed: false,
    };
  }

  refreshCooldowns.set(key, Date.now());
  const payload = await healthBeacon({
    workspaceId,
    workspaceSlug,
    force: true,
  });
  return {
    ...payload,
    cooldownRemainingMs: REFRESH_COOLDOWN_MS,
    refreshed: true,
  };
}

module.exports = {
  healthBeacon,
  refreshHealthBeacon,
  unknownBeacon,
  statusForScore,
  buildScore,
  metricsWorkerActive,
  REFRESH_COOLDOWN_MS,
};
