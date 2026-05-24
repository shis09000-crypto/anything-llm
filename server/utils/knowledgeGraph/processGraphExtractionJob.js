const { KnowledgeGraph } = require("../../models/knowledgeGraph");
const { extractGraphFromChunk } = require("./extractGraph");
const { chunkForJob } = require("./chunks");
const { mergeKnowledgeNode } = require("./mergeKnowledgeNode");
const { createKnowledgeEdge } = require("./createKnowledgeEdge");
const { upsertConceptChunkMap } = require("./conceptChunkMap");
const { updateNodeImportance } = require("./importance");
const { enqueueNodeLabelTranslation } = require("./bilingualLabels");

function workerConcurrency() {
  const value = Number(process.env.KNOWLEDGE_GRAPH_WORKER_CONCURRENCY || 1);
  return Math.max(1, Number.isNaN(value) ? 1 : value);
}

async function processGraphExtractionJob(job) {
  const startedAt = Date.now();
  await KnowledgeGraph.markJobProcessing(job.id);
  try {
    const chunk = await chunkForJob(job);
    if (!chunk?.text) throw new Error("graph_chunk_text_not_found");

    const { graph, LLMConnector } = await extractGraphFromChunk({
      chunkText: chunk.text,
      domain: job.promptDomain,
    });
    const nodesByName = new Map();
    for (const entity of graph.entities) {
      const node = await mergeKnowledgeNode({
        workspaceId: job.workspaceId,
        entity,
        LLMConnector,
      });
      if (!node) continue;
      nodesByName.set(entity.name, node);
      enqueueNodeLabelTranslation({
        workspaceId: job.workspaceId,
        node,
        LLMConnector,
      });
      await upsertConceptChunkMap({
        workspaceId: job.workspaceId,
        nodeId: node.id,
        documentId: job.documentId,
        chunkId: job.chunkId,
        relevanceScore: 0.7,
      });
    }

    const touchedNodeIds = new Set(
      Array.from(nodesByName.values()).map((n) => n.id)
    );
    for (const relation of graph.relations) {
      const sourceNode = nodesByName.get(relation.source);
      const targetNode = nodesByName.get(relation.target);
      if (!sourceNode || !targetNode) continue;
      await createKnowledgeEdge({
        workspaceId: job.workspaceId,
        sourceNode,
        targetNode,
        relation,
        documentId: job.documentId,
        chunkId: job.chunkId,
        extractionJobId: job.id,
      });
      touchedNodeIds.add(sourceNode.id);
      touchedNodeIds.add(targetNode.id);
    }

    await updateNodeImportance({
      workspaceId: job.workspaceId,
      nodeIds: Array.from(touchedNodeIds),
    });
    await KnowledgeGraph.markNodeMetricsStale({
      workspaceId: job.workspaceId,
      nodeIds: Array.from(touchedNodeIds),
      reason: "graph_extraction_completed",
    });
    await KnowledgeGraph.markJobCompleted(job.id);
    console.log(
      `[KnowledgeGraph] completed job ${job.id} in ${Date.now() - startedAt}ms`
    );
    return { success: true };
  } catch (error) {
    await KnowledgeGraph.markJobFailed(job.id, error);
    console.error(`[KnowledgeGraph] failed job ${job.id}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function processPendingGraphExtractionJobs({
  workspaceId = null,
  limit = 25,
  retryFailed = false,
} = {}) {
  const jobs = await KnowledgeGraph.pendingJobs({
    workspaceId,
    limit,
    retryFailed,
  });
  const concurrency = workerConcurrency();
  let index = 0;
  const results = [];

  async function worker() {
    while (index < jobs.length) {
      const job = jobs[index++];
      results.push(await processGraphExtractionJob(job));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker())
  );
  return {
    processed: results.length,
    succeeded: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
  };
}

module.exports = {
  processGraphExtractionJob,
  processPendingGraphExtractionJobs,
};
