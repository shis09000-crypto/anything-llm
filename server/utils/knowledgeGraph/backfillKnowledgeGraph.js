const { Workspace } = require("../../models/workspace");
const { Document } = require("../../models/documents");
const {
  scheduleGraphExtractionForDocument,
} = require("./scheduleGraphExtraction");
const {
  processPendingGraphExtractionJobs,
} = require("./processGraphExtractionJob");
const { cleanupKnowledgeGraph } = require("./cleanup");
const { KnowledgeGraph } = require("../../models/knowledgeGraph");

async function backfillKnowledgeGraph({
  workspaceSlug = null,
  all = false,
  limit = null,
  batchSize = 25,
  retry = false,
  cleanup = false,
} = {}) {
  const workspaces = all
    ? await Workspace.where({})
    : [await Workspace.get({ slug: workspaceSlug })].filter(Boolean);
  if (workspaces.length === 0) throw new Error("workspace_not_found");

  let scheduled = 0;
  let processed = 0;
  for (const workspace of workspaces) {
    const documents = await Document.where(
      { workspaceId: workspace.id },
      limit ? Number(limit) : null,
      { id: "asc" }
    );
    for (const document of documents) {
      const result = await scheduleGraphExtractionForDocument({
        workspace,
        document,
        processNow: false,
      });
      scheduled += result.scheduled || 0;
    }
    const processResult = await processPendingGraphExtractionJobs({
      workspaceId: workspace.id,
      limit: Number(batchSize || 25),
      retryFailed: retry,
    });
    processed += processResult.processed;
    if (cleanup) await cleanupKnowledgeGraph({ workspaceId: workspace.id });
    await KnowledgeGraph.markWorkspaceNodeMetricsStale(
      workspace.id,
      "backfill_completed"
    );
    const stats = await KnowledgeGraph.graphStats(workspace.id);
    console.log(
      "[KnowledgeGraph] backfill workspace stats",
      workspace.slug,
      stats
    );
  }
  return { workspaces: workspaces.length, scheduled, processed };
}

module.exports = { backfillKnowledgeGraph };
