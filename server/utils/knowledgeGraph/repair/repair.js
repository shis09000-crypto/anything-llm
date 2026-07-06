const {
  lazyDataAccessFacade,
  lazyDataAccessProperty,
} = require("../../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const knowledgeGraphDb = KnowledgeGraphData.db;
const Workspace = lazyDataAccessProperty("knowledgeGraph", "workspace");
const KnowledgeGraph = lazyDataAccessProperty("knowledgeGraph", "model");
const {
  scheduleGraphExtractionForDocument,
} = require("../scheduleGraphExtraction");
const { processGraphExtractionJob } = require("../processGraphExtractionJob");
const { chunkForJob } = require("../chunks");
const { scanWorkspaceForRepairIssues } = require("./scan");
const {
  createRepairBudget,
  canSpend,
  spend,
  estimateTokens,
} = require("./budget");
const {
  cooldownUntil,
  nextRetryAt,
  isPermanentRepairError,
} = require("./backoff");
const {
  graphQualityMetrics,
  providerHealthMetrics,
  repairRunMetrics,
} = require("./metrics");
const {
  repairVectorCacheByReadback,
  repairVectorCacheByDashScopeReembed,
} = require("./vectorCache");

async function repairKnowledgeGraph({
  workspaceSlug = null,
  workspaceId = null,
  all = false,
  trigger = "manual",
  allowReembed = false,
  force = false,
  batchSize = null,
  scanLimit = 100,
  budgetOptions = {},
} = {}) {
  const workspaces = await targetWorkspaces({
    workspaceSlug,
    workspaceId,
    all,
  });
  const results = [];
  for (const workspace of workspaces) {
    results.push(
      await repairWorkspace({
        workspace,
        trigger,
        allowReembed,
        force,
        batchSize,
        scanLimit,
        budgetOptions,
      })
    );
  }
  return {
    workspaces: results.length,
    results,
  };
}

async function repairWorkspace({
  workspace,
  trigger = "manual",
  allowReembed = false,
  force = false,
  batchSize = null,
  scanLimit = 100,
  budgetOptions = {},
}) {
  const startedAt = Date.now();
  const budget = createRepairBudget(budgetOptions);
  const limit =
    Number(batchSize) ||
    Number(process.env.KNOWLEDGE_GRAPH_REPAIR_BATCH_SIZE || 25);
  const scanResult = await scanWorkspaceForRepairIssues({
    workspace,
    limit: scanLimit,
  });
  const issues = await KnowledgeGraph.listRepairIssues({
    workspaceId: workspace.id,
    statuses: ["open", "needs_reembed"],
    limit,
    includeBlocked: force,
  });

  let repaired = 0;
  let failed = 0;
  let skipped = 0;
  const latencies = [];

  for (const issue of issues) {
    if (!canSpend(budget)) {
      skipped += 1;
      break;
    }
    const itemStartedAt = Date.now();
    try {
      const outcome = await repairIssue({
        workspace,
        issue,
        allowReembed,
        force,
      });
      latencies.push(Date.now() - itemStartedAt);
      if (outcome.status === "repaired") repaired += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      await markIssueError(issue, error);
    }
  }

  const processResult = await processPendingJobsWithinBudget({
    workspaceId: workspace.id,
    budget,
    limit,
  });
  repaired += processResult.succeeded;
  failed += processResult.failed;
  skipped += processResult.skipped;
  latencies.push(...processResult.latencies);

  const [quality, provider, repairMetrics, status] = await Promise.all([
    graphQualityMetrics(workspace.id),
    providerHealthMetrics(workspace.id),
    Promise.resolve(repairRunMetrics({ repaired, failed, latencies })),
    KnowledgeGraph.repairStatus(workspace.id),
  ]);
  const durationMs = Date.now() - startedAt;
  const run = await KnowledgeGraph.createRepairRun({
    workspaceId: workspace.id,
    trigger,
    scanned: scanResult.scanned,
    repaired,
    failed,
    skipped,
    budgetExhausted: budget.budgetExhausted,
    durationMs,
    tokenBudgetUsed: budget.tokenBudgetUsed,
    providerBudgetUsed: budget.providerBudgetUsed,
    needsReembedCount: status.counts.needsReembed,
    quarantinedCount: status.counts.quarantined,
    ...quality,
    ...provider,
    ...repairMetrics,
    metrics: {
      scanIssues: scanResult.issues.length,
      budget: {
        tokenBudget: budget.tokenBudget,
        providerBudget: budget.providerBudget,
        maxDurationMs: budget.maxDurationMs,
        exhaustionReason: budget.exhaustionReason,
      },
    },
  });
  await KnowledgeGraph.invalidateCache(workspace.id);
  await KnowledgeGraph.markWorkspaceNodeMetricsStale(
    workspace.id,
    "repair_completed"
  );
  return {
    workspace: workspace.slug,
    run,
    scanned: scanResult.scanned,
    issuesConsidered: issues.length,
    repaired,
    failed,
    skipped,
    processedJobs: processResult.processed,
    budgetExhausted: budget.budgetExhausted,
  };
}

async function repairIssue({ workspace, issue, allowReembed = false }) {
  switch (issue.issueType) {
    case "missing_vector_cache":
      return await repairMissingVectorCache({ workspace, issue, allowReembed });
    case "missing_graph_job":
      return await repairMissingGraphJob({ workspace, issue });
    case "stale_processing_job":
      return await resetIssueJob(issue, "repair_reset_stale_processing_job");
    case "failed_graph_job":
      return await repairFailedGraphJob(issue);
    case "missing_graph_text":
      await KnowledgeGraph.updateRepairIssue(issue.id, {
        status: "unrecoverable",
        repairMethod: "unrecoverable",
        repairConfidence: "none",
        lastError: "missing_source_text",
      });
      return { status: "skipped" };
    default:
      return { status: "skipped" };
  }
}

async function repairMissingVectorCache({ workspace, issue, allowReembed }) {
  const document = await documentForIssue(workspace.id, issue);
  if (!document) throw new Error("invalid_document");

  const readback = await repairVectorCacheByReadback({ workspace, document });
  if (readback.repaired) {
    await KnowledgeGraph.updateRepairIssue(issue.id, {
      status: "repaired",
      repairMethod: readback.method,
      repairConfidence: readback.confidence || "high",
      cooldownUntil: cooldownUntil(),
      explainReason:
        "已从现有 vector DB 读回向量和文本，重建标准 vector-cache。",
      lastError: null,
    });
    return { status: "repaired" };
  }

  if (allowReembed) {
    const reembed = await repairVectorCacheByDashScopeReembed({ document });
    if (reembed.repaired) {
      await KnowledgeGraph.updateRepairIssue(issue.id, {
        status: "repaired",
        repairMethod: reembed.method,
        repairConfidence: reembed.confidence || "high",
        cooldownUntil: cooldownUntil(),
        explainReason:
          "已手动确认并使用 DashScope text-embedding-v4 重建标准 vector-cache。",
        lastError: null,
      });
      return { status: "repaired" };
    }
    await KnowledgeGraph.updateRepairIssue(issue.id, {
      status:
        reembed.reason === "embedding_model_mismatch"
          ? "needs_reembed"
          : "open",
      lastError: reembed.reason,
      nextRetryAt: nextRetryAt(issue.retryCount),
      retryCount: Number(issue.retryCount || 0) + 1,
      repairMethod: "manual_dashscope_reembed",
      repairConfidence: "none",
      explainReason:
        "标准 vector-cache 缺失；手动重嵌入未完成，需确认 DashScope text-embedding-v4 配置。",
    });
    return { status: "skipped" };
  }

  await scheduleGraphExtractionForDocument({
    workspace,
    document,
    processNow: false,
  });
  await KnowledgeGraph.updateRepairIssue(issue.id, {
    status: "needs_reembed",
    repairMethod: "pageContent_fallback",
    repairConfidence: "medium",
    cooldownUntil: cooldownUntil(),
    explainReason:
      "无法无成本重建标准 vector-cache；已使用源文档文本补齐 KG 处理，标准 cache 仍需手动重嵌入。",
    lastError: readback.reason || readback.error || null,
  });
  return { status: "skipped" };
}

async function repairMissingGraphJob({ workspace, issue }) {
  const document = await documentForIssue(workspace.id, issue);
  if (!document) throw new Error("invalid_document");
  await scheduleGraphExtractionForDocument({
    workspace,
    document,
    processNow: false,
  });
  await KnowledgeGraph.updateRepairIssue(issue.id, {
    status: "repaired",
    repairMethod: "schedule_missing_graph_job",
    repairConfidence: "partial",
    cooldownUntil: cooldownUntil(),
    explainReason: "已为缺失 chunk 重新调度 GraphExtractionJob。",
    lastError: null,
  });
  return { status: "repaired" };
}

async function repairFailedGraphJob(issue) {
  const retryCount = Number(issue.retryCount || 0);
  if (retryCount >= 5) {
    await KnowledgeGraph.updateRepairIssue(issue.id, {
      status: "quarantined",
      quarantineReason:
        "Graph extraction 连续失败，已暂停该 chunk 的后续 graph ingestion。",
      explainReason: "连续失败达到上限，为避免污染图谱，已进入隔离。",
      repairMethod: "quarantine",
      repairConfidence: "none",
    });
    return { status: "skipped" };
  }
  return await resetIssueJob(issue, "repair_retry_failed_graph_job");
}

async function resetIssueJob(issue, method) {
  const job = await jobForIssue(issue);
  if (!job) throw new Error("graph_job_not_found");
  await KnowledgeGraph.resetJobToPending(job.id, method);
  await KnowledgeGraph.updateRepairIssue(issue.id, {
    status: "repaired",
    repairMethod: method,
    repairConfidence: "partial",
    cooldownUntil: cooldownUntil(),
    explainReason:
      "已将 GraphExtractionJob 重置为 pending，等待预算内重新处理。",
    lastError: null,
  });
  return { status: "repaired" };
}

async function processPendingJobsWithinBudget({ workspaceId, budget, limit }) {
  const jobs = await KnowledgeGraph.pendingJobs({ workspaceId, limit });
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const latencies = [];

  for (const job of jobs) {
    const chunk = await chunkForJob(job);
    const tokens = estimateTokens(chunk?.text || "");
    if (!canSpend(budget, { tokens, providerCalls: 1 })) {
      skipped += 1;
      break;
    }
    spend(budget, { tokens, providerCalls: 1 });
    const startedAt = Date.now();
    const result = await processGraphExtractionJob(job);
    latencies.push(Date.now() - startedAt);
    processed += 1;
    if (result.success) succeeded += 1;
    else failed += 1;
  }

  return { processed, succeeded, failed, skipped, latencies };
}

async function markIssueError(issue, error) {
  const retryCount = Number(issue.retryCount || 0) + 1;
  const permanent = isPermanentRepairError(error);
  await KnowledgeGraph.updateRepairIssue(issue.id, {
    status: permanent ? "unrecoverable" : issue.status || "open",
    retryCount,
    nextRetryAt: permanent ? null : nextRetryAt(retryCount),
    lastError: error.message || String(error),
    repairConfidence: "none",
  });
}

async function targetWorkspaces({ workspaceSlug, workspaceId, all }) {
  if (all) return await Workspace.where({});
  if (workspaceId) {
    const row = await knowledgeGraphDb.workspaces.findFirst({
      where: { id: Number(workspaceId) },
    });
    return row ? [row] : [];
  }
  const workspace = await Workspace.get({ slug: workspaceSlug });
  return workspace ? [workspace] : [];
}

async function documentForIssue(workspaceId, issue) {
  return await knowledgeGraphDb.workspace_documents.findFirst({
    where: {
      workspaceId: Number(workspaceId),
      docId: issue.documentId,
    },
  });
}

async function jobForIssue(issue) {
  return (
    await knowledgeGraphDb.$queryRawUnsafe(
      `SELECT * FROM "GraphExtractionJob"
      WHERE "workspaceId" = ? AND "chunkId" = ?
      LIMIT 1`,
      Number(issue.workspaceId),
      String(issue.chunkId)
    )
  )?.[0];
}

module.exports = {
  repairKnowledgeGraph,
  repairWorkspace,
};
