const { lazyDataAccessFacade } = require("../../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const knowledgeGraphDb = KnowledgeGraphData.db;

function ratio(part, total) {
  const denominator = Number(total || 0);
  if (denominator <= 0) return 0;
  return Number((Number(part || 0) / denominator).toFixed(4));
}

async function graphQualityMetrics(workspaceId) {
  const [
    edges,
    lowConfidence,
    relatedTo,
    highFanoutDocs,
    jobs,
    malformedJobs,
    failedJobs,
  ] = await Promise.all([
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "KnowledgeEdge" WHERE "workspaceId" = ?`,
      Number(workspaceId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "KnowledgeEdge"
        WHERE "workspaceId" = ? AND "confidence" < 0.45`,
      Number(workspaceId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "KnowledgeEdge"
        WHERE "workspaceId" = ? AND "relationType" = 'related_to'`,
      Number(workspaceId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM (
          SELECT ev."documentId", COUNT(DISTINCT ev."edgeId") AS edgeCount
          FROM "EdgeEvidence" ev
          WHERE ev."workspaceId" = ?
          GROUP BY ev."documentId"
          HAVING edgeCount > 120
        )`,
      Number(workspaceId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "GraphExtractionJob" WHERE "workspaceId" = ?`,
      Number(workspaceId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "GraphExtractionJob"
        WHERE "workspaceId" = ? AND LOWER(COALESCE("errorMessage", '')) LIKE '%json%'`,
      Number(workspaceId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "GraphExtractionJob"
        WHERE "workspaceId" = ? AND "status" = 'failed'`,
      Number(workspaceId)
    ),
  ]);
  const edgeCount = countFrom(edges);
  const jobCount = countFrom(jobs);
  return {
    lowConfidenceRelationRatio: ratio(countFrom(lowConfidence), edgeCount),
    relatedToRatio: ratio(countFrom(relatedTo), edgeCount),
    malformedExtractionRatio: ratio(countFrom(malformedJobs), jobCount),
    abnormalFanoutCount: countFrom(highFanoutDocs),
    malformedJsonRate: ratio(countFrom(malformedJobs), jobCount),
    providerFailureRate: ratio(countFrom(failedJobs), jobCount),
  };
}

async function providerHealthMetrics(workspaceId) {
  const [jobs, timeoutJobs, failedJobs, malformedJobs] = await Promise.all([
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "GraphExtractionJob" WHERE "workspaceId" = ?`,
      Number(workspaceId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "GraphExtractionJob"
      WHERE "workspaceId" = ? AND LOWER(COALESCE("errorMessage", '')) LIKE '%timeout%'`,
      Number(workspaceId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "GraphExtractionJob"
      WHERE "workspaceId" = ? AND "status" = 'failed'`,
      Number(workspaceId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "GraphExtractionJob"
      WHERE "workspaceId" = ? AND LOWER(COALESCE("errorMessage", '')) LIKE '%json%'`,
      Number(workspaceId)
    ),
  ]);
  const jobCount = countFrom(jobs);
  return {
    timeoutRate: ratio(countFrom(timeoutJobs), jobCount),
    malformedJsonRate: ratio(countFrom(malformedJobs), jobCount),
    providerFailureRate: ratio(countFrom(failedJobs), jobCount),
    providerFailureTrend: ratio(countFrom(failedJobs), jobCount),
  };
}

function repairRunMetrics({ repaired = 0, failed = 0, latencies = [] } = {}) {
  const total = repaired + failed;
  const avgRepairLatencyMs =
    latencies.length === 0
      ? 0
      : latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
  return {
    successRate: ratio(repaired, total),
    avgRepairLatencyMs: Number(avgRepairLatencyMs.toFixed(2)),
    providerFailureRate: ratio(failed, total),
  };
}

function countFrom(rows) {
  return Number(rows?.[0]?.count || 0);
}

module.exports = {
  graphQualityMetrics,
  providerHealthMetrics,
  repairRunMetrics,
};
