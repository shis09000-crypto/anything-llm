const { lazyDataAccessFacade } = require("../../../dataAccess/lazyFacade");
const Workspace = lazyDataAccessFacade("workspace");
const {
  DocumentRepository: Document,
} = require("../../../../repositories/documentRepository");
const {
  DocumentIndexStatusRepository: DocumentIndexStatus,
} = require("../../../../repositories/documentIndexStatusRepository");

const TOOL_NAME = "document_index_status_tool";
const MISSING_STATUS_ERROR = "missing_status_row";

function toIsoString(value = null) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function compactStatusRecord(record = {}) {
  return {
    filePath: record.filePath || null,
    docId: record.docId || null,
    indexStatus: record.indexStatus || DocumentIndexStatus.statuses.pending,
    indexedAt: toIsoString(record.indexedAt),
    errorMessage: record.errorMessage || null,
    chunkCount: Number(record.chunkCount || 0),
    embeddingCount: Number(record.embeddingCount || 0),
  };
}

async function hydrateEmbeddingCount(record = {}) {
  const compact = compactStatusRecord(record);
  if (!compact.docId || compact.embeddingCount > 0) return compact;

  compact.embeddingCount = await DocumentIndexStatus.embeddingCountForDoc(
    compact.docId
  );
  if (!compact.chunkCount) compact.chunkCount = compact.embeddingCount;
  return compact;
}

async function syntheticStatusRecord(document = {}) {
  const embeddingCount = await DocumentIndexStatus.embeddingCountForDoc(
    document.docId
  );
  const legacyStatus = String(document.embeddingStatus || "").toLowerCase();
  const isIndexed = legacyStatus === "completed" && embeddingCount > 0;
  const isFailed = legacyStatus === "failed";
  const isIndexing = ["indexing", "processing", "in_progress"].includes(
    legacyStatus
  );
  let indexStatus = DocumentIndexStatus.statuses.pending;
  if (isIndexed) indexStatus = DocumentIndexStatus.statuses.indexed;
  if (isFailed) indexStatus = DocumentIndexStatus.statuses.failed;
  if (isIndexing) indexStatus = DocumentIndexStatus.statuses.indexing;

  return {
    filePath: document.docpath || null,
    docId: document.docId || null,
    indexStatus,
    indexedAt: null,
    errorMessage: isIndexed
      ? null
      : document.embeddingError || MISSING_STATUS_ERROR,
    chunkCount: embeddingCount,
    embeddingCount,
  };
}

async function workspaceDocumentStatus(workspaceId) {
  const [documents, statuses] = await Promise.all([
    Document.forWorkspace(workspaceId),
    DocumentIndexStatus.forWorkspace(workspaceId),
  ]);

  const statusByPath = new Map(
    statuses.map((status) => [status.filePath, status])
  );
  const statusByDocId = new Map(
    statuses
      .filter((status) => !!status.docId)
      .map((status) => [status.docId, status])
  );

  const currentDocuments = await Promise.all(
    documents.map(async (document) => {
      const status =
        statusByPath.get(document.docpath) || statusByDocId.get(document.docId);
      return await hydrateEmbeddingCount(
        status || (await syntheticStatusRecord(document))
      );
    })
  );

  const documentPaths = new Set(documents.map((document) => document.docpath));
  const orphanStatusRows = statuses.filter(
    (status) => !documentPaths.has(status.filePath)
  );
  const deletedStatusRows = await Promise.all(
    orphanStatusRows
      .filter(
        (status) => status.indexStatus === DocumentIndexStatus.statuses.deleted
      )
      .map((status) => hydrateEmbeddingCount(status))
  );
  const statusRows = await Promise.all(
    statuses.map((status) => hydrateEmbeddingCount(status))
  );

  return { currentDocuments, deletedStatusRows, statusRows };
}

function sortRecords(records = []) {
  return records.sort((a, b) =>
    String(a.filePath || "").localeCompare(String(b.filePath || ""))
  );
}

const documentIndexStatusTool = {
  name: TOOL_NAME,
  startupConfig: {
    params: {},
  },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: this.name,
          description:
            "Query document indexing status for a workspace. Use this to see which documents are already embedded in the vector database, which documents still need indexing, which indexing jobs failed, and which documents are outdated. This tool is read-only and does not index, delete, or modify documents.",
          examples: [
            {
              prompt: "Which files have not been embedded yet?",
              call: JSON.stringify({
                action: "list_unindexed",
                workspaceSlug: "my-workspace",
              }),
            },
            {
              prompt: "Which files are already in the vector database?",
              call: JSON.stringify({
                action: "list_indexed",
                workspaceSlug: "my-workspace",
              }),
            },
            {
              prompt: "Show the indexing status for custom-documents/a.json",
              call: JSON.stringify({
                action: "get_status",
                workspaceSlug: "my-workspace",
                filePath: "custom-documents/a.json",
              }),
            },
            {
              prompt: "Summarize indexing status for this workspace",
              call: JSON.stringify({
                action: "get_summary",
                workspaceSlug: "my-workspace",
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: [
                  "list_unindexed",
                  "list_indexed",
                  "get_status",
                  "get_summary",
                ],
                description:
                  "The status query to run. Use list_unindexed for pending/outdated/failed/missing-status documents, list_indexed for embedded documents, get_status for one document, and get_summary for workspace counts.",
              },
              workspaceSlug: {
                type: "string",
                description:
                  "The workspace slug whose document indexing status should be queried.",
              },
              filePath: {
                type: "string",
                "x-nullable": true,
                description:
                  "Stored document path to inspect. Required for get_status unless docId is provided.",
              },
              docId: {
                type: "string",
                "x-nullable": true,
                description:
                  "Document ID to inspect. Required for get_status unless filePath is provided.",
              },
            },
            required: ["action", "workspaceSlug"],
            additionalProperties: false,
          },
          handler: async function ({ action, workspaceSlug, filePath, docId }) {
            try {
              const workspace = await Workspace.get({ slug: workspaceSlug });
              if (!workspace)
                return JSON.stringify({
                  error: "workspace_not_found",
                  message: `No workspace was found for slug "${workspaceSlug}".`,
                });

              if (action === "list_unindexed")
                return await this.listUnindexed(workspace);
              if (action === "list_indexed")
                return await this.listIndexed(workspace);
              if (action === "get_status")
                return await this.getStatus(workspace, { filePath, docId });
              if (action === "get_summary")
                return await this.getSummary(workspace);

              return JSON.stringify({
                error: "invalid_action",
                message: `Unsupported action "${action}".`,
              });
            } catch (error) {
              this.super.handlerProps.log(
                `${TOOL_NAME} raised an error. ${error.message}`
              );
              return JSON.stringify({
                error: "document_index_status_error",
                message: error.message,
              });
            }
          },
          listUnindexed: async function (workspace) {
            this.super.introspect(
              `${this.caller}: Checking unindexed documents in ${workspace.slug}.`
            );
            const { currentDocuments } = await workspaceDocumentStatus(
              workspace.id
            );
            const unindexedStatuses = [
              DocumentIndexStatus.statuses.pending,
              DocumentIndexStatus.statuses.outdated,
              DocumentIndexStatus.statuses.failed,
            ];
            return JSON.stringify({
              workspaceSlug: workspace.slug,
              count: currentDocuments.filter((record) =>
                unindexedStatuses.includes(record.indexStatus)
              ).length,
              documents: sortRecords(
                currentDocuments.filter((record) =>
                  unindexedStatuses.includes(record.indexStatus)
                )
              ),
            });
          },
          listIndexed: async function (workspace) {
            this.super.introspect(
              `${this.caller}: Checking indexed documents in ${workspace.slug}.`
            );
            const { currentDocuments } = await workspaceDocumentStatus(
              workspace.id
            );
            const documents = currentDocuments.filter(
              (record) =>
                record.indexStatus === DocumentIndexStatus.statuses.indexed
            );
            return JSON.stringify({
              workspaceSlug: workspace.slug,
              count: documents.length,
              documents: sortRecords(documents),
            });
          },
          getStatus: async function (
            workspace,
            { filePath = null, docId = null }
          ) {
            if (!filePath && !docId)
              return JSON.stringify({
                error: "missing_document_identifier",
                message: "get_status requires either filePath or docId.",
              });

            this.super.introspect(
              `${this.caller}: Checking document index status in ${workspace.slug}.`
            );
            const { currentDocuments, statusRows } =
              await workspaceDocumentStatus(workspace.id);
            const currentKeys = new Set(
              currentDocuments.map(
                (record) => `${record.filePath || ""}:${record.docId || ""}`
              )
            );
            const documents = [
              ...currentDocuments,
              ...statusRows.filter(
                (record) =>
                  !currentKeys.has(
                    `${record.filePath || ""}:${record.docId || ""}`
                  )
              ),
            ];
            const match = documents.find(
              (record) =>
                (filePath && record.filePath === filePath) ||
                (docId && record.docId === docId)
            );
            if (!match)
              return JSON.stringify({
                error: "document_not_found",
                message:
                  "No workspace document or document index status row matched the provided filePath or docId.",
              });

            return JSON.stringify({
              workspaceSlug: workspace.slug,
              document: match,
            });
          },
          getSummary: async function (workspace) {
            this.super.introspect(
              `${this.caller}: Summarizing document index status in ${workspace.slug}.`
            );
            const { currentDocuments, deletedStatusRows } =
              await workspaceDocumentStatus(workspace.id);
            const summary = {
              indexed: 0,
              unindexed: 0,
              indexing: 0,
              outdated: 0,
              failed: 0,
              deleted: deletedStatusRows.length,
              pending: 0,
              missingStatus: 0,
              totalCurrentDocuments: currentDocuments.length,
            };

            for (const record of currentDocuments) {
              if (record.indexStatus === DocumentIndexStatus.statuses.indexed) {
                summary.indexed += 1;
                continue;
              }
              if (
                record.indexStatus === DocumentIndexStatus.statuses.indexing
              ) {
                summary.indexing += 1;
                continue;
              }
              if (record.indexStatus === DocumentIndexStatus.statuses.outdated)
                summary.outdated += 1;
              if (record.indexStatus === DocumentIndexStatus.statuses.failed)
                summary.failed += 1;
              if (record.indexStatus === DocumentIndexStatus.statuses.pending)
                summary.pending += 1;
              if (record.errorMessage === MISSING_STATUS_ERROR)
                summary.missingStatus += 1;

              summary.unindexed += 1;
            }

            return JSON.stringify({
              workspaceSlug: workspace.slug,
              summary,
            });
          },
        });
      },
    };
  },
};

module.exports = {
  documentIndexStatusTool,
  compactStatusRecord,
  syntheticStatusRecord,
  workspaceDocumentStatus,
};
