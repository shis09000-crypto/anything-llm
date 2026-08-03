const { log, conclude } = require("./helpers/index.js");
const {
  recomputeKnowledgeMetrics,
} = require("../utils/knowledgeGraph/metricsCapabilityClient");

(async () => {
  try {
    if (process.env.KNOWLEDGE_NODE_METRICS_RECOMPUTE_ENABLED === "false") {
      log("Knowledge node metrics recompute disabled. Exiting.");
      return;
    }
    const result = await recomputeKnowledgeMetrics({
      trigger: "worker",
      batchSize: Number(
        process.env.KNOWLEDGE_NODE_METRICS_RECOMPUTE_BATCH_SIZE || 200
      ),
      lockTtlMs: Number(
        process.env.KNOWLEDGE_NODE_METRICS_LOCK_TTL_MS || 900000
      ),
    });
    log(`Knowledge node metrics recompute complete: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error);
    log(`Knowledge node metrics recompute failed: ${error.message}`);
  } finally {
    conclude();
  }
})();
