const { KnowledgeGraph } = require("../../models/knowledgeGraph");
const {
  GRAPH_VERSION,
  EXTRACTION_PROMPT_VERSION,
  MERGE_LOGIC_VERSION,
  RELATION_ONTOLOGY_VERSION,
} = require("./constants");
const { detectPromptDomain } = require("./promptRegistry");
const { chunksForDocument } = require("./chunks");

async function scheduleGraphExtractionForDocument({
  workspace,
  document,
  processNow = true,
}) {
  if (!workspace?.id || !document?.docId) return { scheduled: 0, skipped: 0 };
  try {
    const chunks = await chunksForDocument(document);
    let scheduled = 0;
    for (const chunk of chunks) {
      const promptDomain = detectPromptDomain({
        text: chunk.text,
        metadata: chunk.metadata,
        filePath: document.docpath,
      });
      const job = await KnowledgeGraph.scheduleJob({
        workspaceId: workspace.id,
        documentId: document.docId,
        chunkId: chunk.chunkId,
        promptDomain,
        graphVersion: GRAPH_VERSION,
        extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
        mergeLogicVersion: MERGE_LOGIC_VERSION,
        relationOntologyVersion: RELATION_ONTOLOGY_VERSION,
      });
      if (job?.created) scheduled += 1;
    }
    if (processNow && scheduled > 0) {
      const {
        processPendingGraphExtractionJobs,
      } = require("./processGraphExtractionJob");
      setImmediate(() =>
        processPendingGraphExtractionJobs({ workspaceId: workspace.id }).catch(
          (error) =>
            console.error(
              "[KnowledgeGraph] async extraction failed",
              error.message
            )
        )
      );
    }
    console.log(
      `[KnowledgeGraph] scheduled ${scheduled} graph extraction jobs for ${document.docpath}`
    );
    return { scheduled, skipped: 0 };
  } catch (error) {
    console.error(
      "[KnowledgeGraph] failed to schedule extraction",
      error.message
    );
    return { scheduled: 0, skipped: 1, error: error.message };
  }
}

module.exports = { scheduleGraphExtractionForDocument };
