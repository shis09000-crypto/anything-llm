const os = require("os");
const prisma = require("../prisma");
const { safeJsonParse } = require("../http");
const { KnowledgeGraph } = require("../../models/knowledgeGraph");

const NODE_METRICS_FORMULA_VERSION = "metrics-v1";
const CORE_DIMENSIONS = [
  "evidenceStrength",
  "bridgeValue",
  "knowledgeConnectivity",
  "traversalImportance",
  "crossDocumentPresence",
  "freshness",
  "relationDiversity",
  "sourceAuthority",
  "stability",
  "conflictSafety",
];

const DIMENSION_LABELS = {
  evidenceStrength: ["证据强度", "Evidence Strength"],
  bridgeValue: ["桥接价值", "Bridge Value"],
  knowledgeConnectivity: ["知识连接度", "Knowledge Connectivity"],
  traversalImportance: ["推理核心度", "Traversal Importance"],
  crossDocumentPresence: ["跨文档出现率", "Cross-document Presence"],
  freshness: ["近期活跃度", "Freshness"],
  relationDiversity: ["关系多样性", "Relation Diversity"],
  sourceAuthority: ["来源可信度", "Source Authority"],
  stability: ["稳定性", "Stability"],
  conflictSafety: ["冲突安全度", "Conflict Safety"],
};

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value || 0)));
}

function score100(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0) * 100)));
}

function ageDecay(dateValue, halfLifeDays = 30) {
  const date = dateValue ? new Date(dateValue) : null;
  if (!date || !Number.isFinite(date.getTime())) return 0;
  const ageDays = Math.max(0, (Date.now() - date.getTime()) / 86_400_000);
  return Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
}

function relationPenalty(relatedToRatio = 0) {
  const ratio = clamp01(relatedToRatio);
  if (ratio <= 0.45) return 1;
  if (ratio >= 0.9) return 0.55;
  return 1 - (ratio - 0.45);
}

function conflictRiskScore({ conflictCount = 0, edgeCount = 0 } = {}) {
  if (!edgeCount) return 0;
  return clamp01(conflictCount / Math.max(1, edgeCount));
}

function calculateRadarScores(inputs = {}) {
  const relatedPenalty = relationPenalty(inputs.relatedToRatio);
  const evidenceStrength = score100(
    clamp01(inputs.evidenceCount / 8) * 0.38 +
      clamp01(inputs.averageTrustScore) * 0.32 +
      clamp01(inputs.documentCount / 4) * 0.18 +
      clamp01(inputs.chunkCount / 8) * 0.12
  );
  const bridgeValue = score100(
    (clamp01(inputs.edgeCount / 10) * 0.3 +
      clamp01(inputs.twoHopPathCount / 18) * 0.36 +
      clamp01(inputs.relationTypeCount / 5) * 0.2 +
      clamp01(inputs.documentCount / 4) * 0.14) *
      relatedPenalty
  );
  const knowledgeConnectivity = score100(
    (clamp01(inputs.edgeCount / 12) * 0.36 +
      clamp01(inputs.neighborCount / 12) * 0.28 +
      clamp01(inputs.totalEdgeWeight / 16) * 0.2 +
      clamp01(inputs.averageConfidence) * 0.16) *
      relatedPenalty
  );
  const traversalImportance = score100(
    clamp01(inputs.decayedUsageScore / 8) * 0.52 +
      clamp01(inputs.recentUsageCount / 8) * 0.24 +
      clamp01(inputs.usageCount / 40) * 0.14 +
      clamp01(inputs.workspaceImportanceScore) * 0.1
  );
  const crossDocumentPresence = score100(
    clamp01(inputs.documentCount / 5) * 0.62 +
      clamp01(inputs.chunkCount / 12) * 0.28 +
      clamp01(inputs.evidenceDocumentCount / 4) * 0.1
  );
  const freshness = score100(
    clamp01(inputs.decayedFreshnessScore / 4) * 0.5 +
      clamp01(inputs.recentEvidenceCount / 4) * 0.28 +
      clamp01(inputs.recentUsageCount / 8) * 0.14 +
      clamp01(inputs.nodeFreshnessScore) * 0.08
  );
  const relationDiversity = score100(
    (clamp01(inputs.relationTypeCount / 5) * 0.72 +
      (1 - clamp01(inputs.relatedToRatio)) * 0.28) *
      relatedPenalty
  );
  const sourceAuthority = score100(
    clamp01(inputs.pinnedDocumentRatio) * 0.2 +
      clamp01(inputs.watchedDocumentRatio) * 0.16 +
      clamp01(inputs.averageChunkCompleteness) * 0.22 +
      clamp01(inputs.documentCoverageRatio) * 0.22 +
      clamp01(inputs.documentCount / 4) * 0.2
  );
  const stability = score100(
    clamp01(inputs.evidenceCount / 8) * 0.26 +
      clamp01(inputs.documentCount / 4) * 0.22 +
      clamp01(inputs.evidenceSpanDays / 90) * 0.16 +
      clamp01(inputs.averageConfidence) * 0.18 +
      (1 - conflictRiskScore(inputs)) * 0.18
  );
  const conflictSafety = score100(1 - conflictRiskScore(inputs));

  return {
    evidenceStrength,
    bridgeValue,
    knowledgeConnectivity,
    traversalImportance,
    crossDocumentPresence,
    freshness,
    relationDiversity,
    sourceAuthority,
    stability,
    conflictSafety,
  };
}

function reasonsForDimension(key, score, inputs = {}) {
  const reasons = [];
  switch (key) {
    case "evidenceStrength":
      reasons.push(`当前概念关联 ${inputs.evidenceCount} 条 evidence。`);
      reasons.push(
        `平均 evidence trust 约为 ${toPct(inputs.averageTrustScore)}。`
      );
      if (inputs.documentCount > 1)
        reasons.push("证据来自多个文档，支持更充分。");
      break;
    case "bridgeValue":
      reasons.push(`该节点连接 ${inputs.neighborCount} 个邻居概念。`);
      reasons.push(`二跳路径 proxy 为 ${inputs.twoHopPathCount}。`);
      if (inputs.relatedToRatio > 0.55)
        reasons.push("弱关系 related_to 占比较高，已降低桥接贡献。");
      break;
    case "knowledgeConnectivity":
      reasons.push(`该节点有 ${inputs.edgeCount} 条 incident relation。`);
      reasons.push(`平均关系置信度为 ${toPct(inputs.averageConfidence)}。`);
      if (inputs.relatedToRatio > 0.55)
        reasons.push("related_to 占比偏高，连接度评分做了保守惩罚。");
      break;
    case "traversalImportance":
      reasons.push(`累计 evidence/node 使用 ${inputs.usageCount} 次。`);
      reasons.push(
        `时间衰减后的使用分为 ${inputs.decayedUsageScore.toFixed(2)}。`
      );
      break;
    case "crossDocumentPresence":
      reasons.push(`该概念覆盖 ${inputs.documentCount} 个文档。`);
      reasons.push(`关联 ${inputs.chunkCount} 个 chunk。`);
      break;
    case "freshness":
      reasons.push(`近 30 天新增 evidence ${inputs.recentEvidenceCount} 条。`);
      reasons.push(
        `近期活跃度按时间衰减计算为 ${inputs.decayedFreshnessScore.toFixed(2)}。`
      );
      break;
    case "relationDiversity":
      reasons.push(`关系类型数量为 ${inputs.relationTypeCount}。`);
      if (inputs.relatedToRatio > 0.55)
        reasons.push("related_to 占比较高，说明关系语义仍偏弱。");
      break;
    case "sourceAuthority":
      reasons.push(
        `来源文档覆盖率约为 ${toPct(inputs.documentCoverageRatio)}。`
      );
      reasons.push(
        `平均 chunk 完整度约为 ${toPct(inputs.averageChunkCompleteness)}。`
      );
      break;
    case "stability":
      reasons.push(
        `evidence 时间跨度约 ${Math.round(inputs.evidenceSpanDays)} 天。`
      );
      reasons.push(`冲突数量为 ${inputs.conflictCount}。`);
      break;
    case "conflictSafety":
      reasons.push(`检测到 ${inputs.conflictCount} 个潜在 relation 冲突。`);
      reasons.push("分数越高表示冲突越少、冲突风险越低。");
      break;
  }
  if (score >= 75) reasons.unshift("该维度在当前 workspace 图谱中表现较强。");
  if (score <= 35)
    reasons.unshift("该维度当前较弱，建议结合原文 evidence 判断。");
  return reasons;
}

function buildReasons(scores = {}, inputs = {}) {
  return CORE_DIMENSIONS.reduce((acc, key) => {
    const [labelZh, labelEn] = DIMENSION_LABELS[key];
    acc[key] = {
      labelZh,
      labelEn,
      score: scores[key],
      formulaVersion: NODE_METRICS_FORMULA_VERSION,
      reasons: reasonsForDimension(key, scores[key], inputs),
    };
    return acc;
  }, {});
}

function toPct(value) {
  return `${Math.round(clamp01(value) * 100)}%`;
}

function rowCount(rows) {
  return Number(rows?.[0]?.count || 0);
}

function average(values = []) {
  const items = values.map(Number).filter((value) => Number.isFinite(value));
  return items.length
    ? items.reduce((sum, value) => sum + value, 0) / items.length
    : 0;
}

async function collectNormalizedInputs({ workspaceId, nodeId }) {
  await KnowledgeGraph.ensureTables();
  const node = await KnowledgeGraph.getNode(nodeId);
  if (!node || Number(node.workspaceId) !== Number(workspaceId)) return null;

  const edges = await prisma.$queryRawUnsafe(
    `SELECT * FROM "KnowledgeEdge"
    WHERE "workspaceId" = ?
      AND ("sourceNodeId" = ? OR "targetNodeId" = ?)`,
    Number(workspaceId),
    Number(nodeId),
    Number(nodeId)
  );
  const edgeIds = edges.map((edge) => Number(edge.id));
  const evidenceRows = edgeIds.length
    ? await prisma.$queryRawUnsafe(
        `SELECT * FROM "EdgeEvidence"
        WHERE "workspaceId" = ? AND "edgeId" IN (${edgeIds.map(() => "?").join(",")})`,
        Number(workspaceId),
        ...edgeIds
      )
    : [];
  const mapRows = await prisma.$queryRawUnsafe(
    `SELECT c.*, d."pinned", d."watched", d."metadata"
    FROM "ConceptChunkMap" c
    LEFT JOIN "workspace_documents" d
      ON d."workspaceId" = c."workspaceId" AND d."docId" = c."documentId"
    WHERE c."workspaceId" = ? AND c."nodeId" = ?`,
    Number(workspaceId),
    Number(nodeId)
  );
  const usageRows = await usageRowsForNode({ workspaceId, nodeId, edgeIds });
  const repairIssues = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS count FROM "KnowledgeGraphRepairIssue"
    WHERE "workspaceId" = ? AND "status" IN ('open', 'quarantined', 'needs_reembed')`,
    Number(workspaceId)
  );

  const relationTypes = new Set(
    edges.map((edge) => edge.relationType).filter(Boolean)
  );
  const neighbors = new Set();
  for (const edge of edges) {
    neighbors.add(
      Number(edge.sourceNodeId) === Number(nodeId)
        ? Number(edge.targetNodeId)
        : Number(edge.sourceNodeId)
    );
  }
  const documents = new Set([
    ...evidenceRows.map((row) => row.documentId).filter(Boolean),
    ...mapRows.map((row) => row.documentId).filter(Boolean),
  ]);
  const chunks = new Set([
    ...evidenceRows.map((row) => row.chunkId).filter(Boolean),
    ...mapRows.map((row) => row.chunkId).filter(Boolean),
  ]);
  const evidenceDocuments = new Set(
    evidenceRows.map((row) => row.documentId).filter(Boolean)
  );
  const confidenceValues = edges.map((edge) => Number(edge.confidence || 0));
  const evidenceConfidenceValues = evidenceRows.map((row) =>
    Number(row.confidence || 0)
  );
  const averageConfidence = average(
    confidenceValues.length ? confidenceValues : evidenceConfidenceValues
  );
  const edgeCount = edges.length;
  const relatedToRatio = edgeCount
    ? edges.filter((edge) => edge.relationType === "related_to").length /
      edgeCount
    : 0;
  const totalEdgeWeight = edges.reduce(
    (sum, edge) => sum + Number(edge.weight || 1),
    0
  );
  const conflictCount = conflictCountForEdges(edges);
  const evidenceDates = evidenceRows
    .map((row) => new Date(row.createdAt))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((a, b) => a - b);
  const evidenceSpanDays =
    evidenceDates.length >= 2
      ? (evidenceDates[evidenceDates.length - 1] - evidenceDates[0]) /
        86_400_000
      : 0;
  const recentEvidenceCount = evidenceRows.filter(
    (row) => ageDecay(row.createdAt, 30) >= 0.5
  ).length;
  const usageCount = usageRows.reduce(
    (sum, row) => sum + Number(row.count || 0),
    0
  );
  const recentUsageCount = usageRows
    .filter((row) => ageDecay(row.lastUsedAt, 30) >= 0.5)
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  const decayedUsageScore = usageRows.reduce(
    (sum, row) => sum + Number(row.count || 0) * ageDecay(row.lastUsedAt, 30),
    0
  );
  const decayedFreshnessScore =
    evidenceRows.reduce((sum, row) => sum + ageDecay(row.createdAt, 30), 0) +
    ageDecay(node.updatedAt, 45) +
    usageRows.reduce((sum, row) => sum + ageDecay(row.lastUsedAt, 14), 0);
  const pinnedDocumentRatio = mapRows.length
    ? mapRows.filter((row) => row.pinned).length / mapRows.length
    : 0;
  const watchedDocumentRatio = mapRows.length
    ? mapRows.filter((row) => row.watched).length / mapRows.length
    : 0;
  const averageChunkCompleteness = mapRows.length
    ? average(
        mapRows.map((row) =>
          Math.min(1, Math.max(0.15, Number(row.mentionCount || 1) / 3))
        )
      )
    : evidenceRows.length
      ? 0.55
      : 0.2;
  const documentCoverageRatio = mapRows.length
    ? clamp01(chunks.size / Math.max(1, mapRows.length))
    : 0;
  const twoHopPathCount = await twoHopPathCountForNode({ workspaceId, nodeId });
  const sourceAuthorityProxy =
    pinnedDocumentRatio * 0.25 +
    watchedDocumentRatio * 0.15 +
    averageChunkCompleteness * 0.3 +
    documentCoverageRatio * 0.3;
  const averageTrustScore = clamp01(
    averageConfidence * 0.52 +
      clamp01(documents.size / 4) * 0.18 +
      sourceAuthorityProxy * 0.2 +
      (1 - conflictRiskScore({ conflictCount, edgeCount })) * 0.1
  );

  return {
    node,
    evidenceCount: evidenceRows.length,
    edgeCount,
    documentCount: documents.size,
    chunkCount: chunks.size,
    relationTypeCount: relationTypes.size,
    conflictCount,
    averageConfidence,
    averageTrustScore,
    relatedToRatio,
    recentEvidenceCount,
    usageCount,
    recentUsageCount,
    decayedUsageScore,
    decayedFreshnessScore,
    neighborCount: neighbors.size,
    totalEdgeWeight,
    evidenceDocumentCount: evidenceDocuments.size,
    evidenceSpanDays,
    twoHopPathCount,
    pinnedDocumentRatio,
    watchedDocumentRatio,
    averageChunkCompleteness,
    documentCoverageRatio,
    workspaceImportanceScore: Number(node.workspaceImportanceScore || 0),
    recentImportanceScore: Number(node.recentImportanceScore || 0),
    globalImportanceScore: Number(node.globalImportanceScore || 0),
    repairIssueCount: rowCount(repairIssues),
    nodeFreshnessScore: ageDecay(node.updatedAt, 45),
  };
}

async function usageRowsForNode({ workspaceId, nodeId, edgeIds = [] }) {
  const edgeTargetIds = edgeIds.map(String);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM "KnowledgeGraphEvidenceUsage"
    WHERE "workspaceId" = ? AND (
      ("targetType" = 'node' AND "targetId" = ?)
      ${
        edgeTargetIds.length
          ? `OR ("targetType" = 'edge' AND "targetId" IN (${edgeTargetIds.map(() => "?").join(",")}))`
          : ""
      }
    )`,
    Number(workspaceId),
    String(nodeId),
    ...edgeTargetIds
  );
  return rows;
}

async function twoHopPathCountForNode({ workspaceId, nodeId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS count FROM "KnowledgeEdge" e1
    JOIN "KnowledgeEdge" e2
      ON (
        CASE WHEN e1."sourceNodeId" = ? THEN e1."targetNodeId" ELSE e1."sourceNodeId" END
      ) IN (e2."sourceNodeId", e2."targetNodeId")
    WHERE e1."workspaceId" = ? AND e2."workspaceId" = ?
      AND (e1."sourceNodeId" = ? OR e1."targetNodeId" = ?)
      AND e2."id" != e1."id"`,
    Number(nodeId),
    Number(workspaceId),
    Number(workspaceId),
    Number(nodeId),
    Number(nodeId)
  );
  return rowCount(rows);
}

function conflictCountForEdges(edges = []) {
  let conflicts = 0;
  const directionSensitive = new Set(["causes", "precedes", "part_of"]);
  for (const edge of edges) {
    for (const other of edges) {
      if (Number(edge.id) >= Number(other.id)) continue;
      const reversed =
        Number(edge.sourceNodeId) === Number(other.targetNodeId) &&
        Number(edge.targetNodeId) === Number(other.sourceNodeId);
      const samePair =
        reversed ||
        (Number(edge.sourceNodeId) === Number(other.sourceNodeId) &&
          Number(edge.targetNodeId) === Number(other.targetNodeId));
      if (!samePair) continue;
      if (
        reversed &&
        directionSensitive.has(edge.relationType) &&
        other.relationType === edge.relationType
      ) {
        conflicts += 2;
      } else if (edge.relationType !== other.relationType) {
        conflicts +=
          Number(edge.confidence || 0) >= 0.65 &&
          Number(other.confidence || 0) >= 0.65
            ? 1
            : 0.5;
      }
    }
  }
  return conflicts;
}

function driftWarning({ scores = {}, snapshot = null }) {
  if (!snapshot?.scores) return null;
  const changed = CORE_DIMENSIONS.filter(
    (key) =>
      Math.abs(Number(scores[key] || 0) - Number(snapshot.scores[key] || 0)) >=
      35
  );
  if (!changed.length) return null;
  return `metrics_drift_warning:${changed.join(",")}`;
}

function shouldSnapshot(scores = {}, inputs = {}) {
  return (
    Number(scores.evidenceStrength || 0) >= 65 ||
    Number(scores.bridgeValue || 0) >= 65 ||
    Number(scores.traversalImportance || 0) >= 65 ||
    Number(inputs.evidenceCount || 0) >= 5 ||
    Number(inputs.usageCount || 0) >= 8
  );
}

async function computeNodeMetrics({ workspaceId, nodeId }) {
  const inputs = await collectNormalizedInputs({ workspaceId, nodeId });
  if (!inputs) return null;
  const scores = calculateRadarScores(inputs);
  const reasons = buildReasons(scores, inputs);
  const snapshot = await KnowledgeGraph.latestNodeMetricsSnapshot({
    workspaceId,
    nodeId,
    formulaVersion: NODE_METRICS_FORMULA_VERSION,
  });
  const warning = driftWarning({ scores, snapshot });
  return {
    node: inputs.node,
    scores,
    reasons,
    normalizedInputs: sanitizeInputs(inputs),
    formulaVersion: NODE_METRICS_FORMULA_VERSION,
    warning,
  };
}

function sanitizeInputs(inputs = {}) {
  const { node: _node, ...rest } = inputs;
  return Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [
      key,
      typeof value === "number" ? Number(value.toFixed(4)) : value,
    ])
  );
}

async function recomputeNodeMetrics({
  workspaceId,
  nodeId,
  trigger = "manual",
}) {
  const computed = await computeNodeMetrics({ workspaceId, nodeId });
  if (!computed) return null;
  const metrics = await KnowledgeGraph.upsertNodeMetrics({
    workspaceId,
    nodeId,
    scores: computed.scores,
    reasons: computed.reasons,
    normalizedInputs: computed.normalizedInputs,
    formulaVersion: computed.formulaVersion,
    warning: computed.warning,
    stale: false,
  });
  if (shouldSnapshot(computed.scores, computed.normalizedInputs)) {
    await KnowledgeGraph.maybeCreateNodeMetricsSnapshot({
      workspaceId,
      nodeId,
      scores: computed.scores,
      normalizedInputs: computed.normalizedInputs,
      formulaVersion: computed.formulaVersion,
      snapshotPeriod: "daily",
    });
  }
  return { metrics, computed, trigger };
}

async function recomputeStaleNodeMetrics({
  workspaceId = null,
  batchSize = 50,
  trigger = "worker",
  formulaVersion = NODE_METRICS_FORMULA_VERSION,
  lockTtlMs = Number(process.env.KNOWLEDGE_NODE_METRICS_LOCK_TTL_MS || 900000),
} = {}) {
  const startedAt = Date.now();
  const lockedBy = `${trigger}:${process.pid}:${os.hostname()}:${Date.now()}`;
  const errors = [];
  let lockedCount = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const candidates = await KnowledgeGraph.nodeMetricsCandidates({
    workspaceId,
    limit: Number(batchSize || 50),
    formulaVersion,
    lockTtlMs,
  });

  for (const candidate of candidates) {
    const locked = await KnowledgeGraph.lockNodeMetricsRow({
      id: candidate.id,
      lockedBy,
      lockTtlMs,
    });
    if (!locked) {
      skipped += 1;
      continue;
    }
    lockedCount += 1;
    try {
      await recomputeNodeMetrics({
        workspaceId: locked.workspaceId,
        nodeId: locked.nodeId,
        trigger,
      });
      succeeded += 1;
    } catch (error) {
      failed += 1;
      errors.push({
        nodeId: locked.nodeId,
        workspaceId: locked.workspaceId,
        error: error.message,
      });
      await KnowledgeGraph.markNodeMetricsError({
        workspaceId: locked.workspaceId,
        nodeId: locked.nodeId,
        error,
      });
    }
  }

  const run = await KnowledgeGraph.createNodeMetricsRecomputeRun({
    workspaceId,
    trigger,
    formulaVersion,
    batchSize,
    processed: candidates.length,
    succeeded,
    failed,
    skipped,
    durationMs: Date.now() - startedAt,
    lockedCount,
    errors,
  });
  return {
    run,
    processed: candidates.length,
    succeeded,
    failed,
    skipped,
    lockedCount,
  };
}

async function nodeMetricsResponse({
  workspaceId,
  nodeId = null,
  concept = "",
}) {
  await KnowledgeGraph.ensureTables();
  const node = nodeId
    ? await KnowledgeGraph.getNode(nodeId)
    : await KnowledgeGraph.findNodeByNameOrAlias({
        workspaceId,
        name: concept,
      });
  if (!node || Number(node.workspaceId) !== Number(workspaceId)) {
    return { node: null, radar: null, emptyReason: "node_not_found" };
  }
  const metrics = await KnowledgeGraph.getNodeMetrics({
    workspaceId,
    nodeId: node.id,
    formulaVersion: NODE_METRICS_FORMULA_VERSION,
  });
  const hasComputedReasons = metrics?.reasons?.evidenceStrength;
  if (!metrics || !hasComputedReasons) {
    return {
      node: publicNode(node),
      radar: null,
      normalizedInputs: null,
      formulaVersion: NODE_METRICS_FORMULA_VERSION,
      stale: true,
      emptyReason: "metrics_missing",
      lastError: metrics?.lastError || null,
    };
  }
  return {
    node: publicNode(node),
    radar: CORE_DIMENSIONS.map((key) => ({
      key,
      ...(metrics.reasons?.[key] || {}),
      score: Number(metrics[key] || metrics.reasons?.[key]?.score || 0),
      formulaVersion:
        metrics.reasons?.[key]?.formulaVersion || metrics.formulaVersion,
    })),
    normalizedInputs: metrics.normalizedInputs || {},
    formulaVersion: metrics.formulaVersion,
    updatedAt: metrics.updatedAt,
    stale:
      metrics.stale || metrics.formulaVersion !== NODE_METRICS_FORMULA_VERSION,
    warning: metrics.warning || null,
    lastError: metrics.lastError || null,
  };
}

function publicNode(node = {}) {
  return {
    id: node.id,
    canonicalName: node.canonicalName,
    displayNameZh: node.displayNameZh || null,
    displayNameEn: node.displayNameEn || node.canonicalName,
    entityType: node.entityType,
    aliases: Array.isArray(node.aliases)
      ? node.aliases
      : safeJsonParse(node.aliases, []),
  };
}

async function requestNodeMetricsRecompute({
  workspaceId,
  nodeId = null,
  concept = "",
}) {
  const node = nodeId
    ? await KnowledgeGraph.getNode(nodeId)
    : await KnowledgeGraph.findNodeByNameOrAlias({
        workspaceId,
        name: concept,
      });
  if (!node || Number(node.workspaceId) !== Number(workspaceId)) {
    return { queued: false, emptyReason: "node_not_found" };
  }
  await KnowledgeGraph.markNodeMetricsStale({
    workspaceId,
    nodeIds: [node.id],
    reason: "lazy_recompute_requested",
  });
  setImmediate(() => {
    recomputeStaleNodeMetrics({
      workspaceId,
      batchSize: 1,
      trigger: "lazy",
    }).catch((error) =>
      console.error(
        "[KnowledgeNodeMetrics] lazy recompute failed:",
        error.message
      )
    );
  });
  return { queued: true, nodeId: node.id };
}

module.exports = {
  NODE_METRICS_FORMULA_VERSION,
  CORE_DIMENSIONS,
  DIMENSION_LABELS,
  ageDecay,
  relationPenalty,
  calculateRadarScores,
  buildReasons,
  computeNodeMetrics,
  recomputeNodeMetrics,
  recomputeStaleNodeMetrics,
  nodeMetricsResponse,
  requestNodeMetricsRecompute,
};
