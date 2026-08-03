const { requestInternalService } = require("../microModules/internalClient");
const { distributedTopology } = require("../microModules/serviceHost");

const CAPABILITY = "knowledge.metrics.recompute";
const PATH = "/internal/v1/knowledge/metrics/recompute";

function knowledgeIngestUrl(env = process.env) {
  return String(env.ATHENA_KNOWLEDGE_INGEST_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function remoteMetricsRecomputeEnabled(env = process.env) {
  return (
    distributedTopology(env) &&
    String(env.ATHENA_RUNTIME_ROLE || "") !== "knowledge-ingest"
  );
}

async function recomputeKnowledgeMetrics(
  { trigger = "worker", batchSize = 200, lockTtlMs = 900_000 } = {},
  env = process.env
) {
  if (!remoteMetricsRecomputeEnabled(env)) {
    const { recomputeStaleNodeMetrics } = require("./nodeMetrics");
    return recomputeStaleNodeMetrics({ trigger, batchSize, lockTtlMs });
  }
  const baseUrl = knowledgeIngestUrl(env);
  if (!baseUrl) {
    const error = new Error("knowledge_metrics_capability_unavailable");
    error.code = "knowledge_metrics_capability_unavailable";
    error.httpStatus = 503;
    throw error;
  }
  const response = await requestInternalService({
    callerRole: String(env.ATHENA_RUNTIME_ROLE || "background-worker"),
    callerModule: "background-worker",
    targetModule: "knowledge-ingest",
    capability: CAPABILITY,
    contractVersion: "1.0",
    url: `${baseUrl}${PATH}`,
    body: { trigger, batchSize, lockTtlMs },
    idempotencyKey: `knowledge-metrics:${trigger}:${Math.floor(Date.now() / 60_000)}`,
    env,
    timeoutMs: Number(env.ATHENA_KNOWLEDGE_METRICS_TIMEOUT_MS || 120_000),
  });
  return response?.result || response;
}

module.exports = {
  CAPABILITY,
  PATH,
  knowledgeIngestUrl,
  recomputeKnowledgeMetrics,
  remoteMetricsRecomputeEnabled,
};
