const { log, conclude } = require("./helpers/index.js");
const { repairKnowledgeGraph } = require("../utils/knowledgeGraph/repair");

(async () => {
  try {
    if (process.env.KNOWLEDGE_GRAPH_REPAIR_ENABLED === "false") {
      log("Knowledge Graph repair disabled. Exiting.");
      return;
    }
    const result = await repairKnowledgeGraph({
      all: true,
      trigger: "auto",
      allowReembed: false,
      batchSize: Number(process.env.KNOWLEDGE_GRAPH_REPAIR_BATCH_SIZE || 25),
      scanLimit: Number(process.env.KNOWLEDGE_GRAPH_REPAIR_SCAN_LIMIT || 100),
    });
    log(`Knowledge Graph repair complete: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error);
    log(`Knowledge Graph repair failed: ${error.message}`);
  } finally {
    conclude();
  }
})();
