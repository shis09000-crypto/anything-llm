const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const { v4: uuidv4 } = require("uuid");
const { getVectorDbClass } = require("../utils/helpers");
const prisma = require("../utils/prisma");
const { Telemetry } = require("./telemetry");
const { EventLogs } = require("./eventLogs");
const { safeJsonParse } = require("../utils/http");
const { getModelTag } = require("../endpoints/utils");
const { DocumentIndexStatus } = require("./documentIndexStatus");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");
const {
  workspaceDocumentsProjection,
} = require("../utils/syncV2/documentProjection");

async function documentSyncReady() {
  return SyncV2.enabled("documents") && (await SyncV2.schemaReady());
}

async function recordWorkspaceDocumentsChange(
  tx,
  workspaceId,
  { changedPaths = ["$"], eventType = "workspace.documents.updated" } = {}
) {
  const content = await workspaceDocumentsProjection(tx, workspaceId);
  return await SyncV2.recordNodeChange(tx, {
    nodeKey: nodeKeys.workspaceDomain(workspaceId, "documents"),
    content,
    changedPaths,
    eventType,
  });
}

function documentDisplayName(docpath = "", metadata = {}) {
  return (
    metadata.documentName ||
    metadata.displayTitle ||
    metadata.title ||
    docpath.split("/")[1]
  );
}

const Document = {
  writable: ["pinned", "watched", "lastUpdatedAt"],
  /**
   * @param {import("@prisma/client").workspace_documents} document - Document PrismaRecord
   * @returns {{
   *  metadata: (null|object),
   *  type: import("./documentSyncQueue.js").validFileType,
   *  source: string
   * }}
   */
  parseDocumentTypeAndSource: function (document) {
    const metadata = safeJsonParse(document.metadata, null);
    if (!metadata) return { metadata: null, type: null, source: null };

    // Parse the correct type of source and its original source path.
    const idx = metadata.chunkSource.indexOf("://");
    const [type, source] = [
      metadata.chunkSource.slice(0, idx),
      metadata.chunkSource.slice(idx + 3),
    ];
    return { metadata, type, source: this._stripSource(source, type) };
  },

  forWorkspace: async function (workspaceId = null) {
    if (!workspaceId) return [];
    return await prisma.workspace_documents.findMany({
      where: { workspaceId },
    });
  },

  delete: async function (clause = {}) {
    try {
      const documents = await prisma.workspace_documents.findMany({
        where: clause,
        select: { workspaceId: true, docId: true },
      });
      const byWorkspace = new Map();
      for (const document of documents) {
        if (!byWorkspace.has(document.workspaceId))
          byWorkspace.set(document.workspaceId, []);
        byWorkspace.get(document.workspaceId).push(document.docId);
      }
      if (await documentSyncReady()) {
        await prisma.$transaction(async (tx) => {
          await tx.workspace_documents.deleteMany({ where: clause });
          for (const [workspaceId, documentIds] of byWorkspace.entries()) {
            await recordWorkspaceDocumentsChange(tx, workspaceId, {
              changedPaths: documentIds.map(
                (documentId) => `documents.${documentId}`
              ),
              eventType: "workspace.documents.deleted",
            });
          }
        });
      } else {
        await prisma.workspace_documents.deleteMany({ where: clause });
      }
      try {
        const { WorkspaceCognition } = require("./workspaceCognition");
        await Promise.all(
          [...byWorkspace.entries()].map(([workspaceId, documentIds]) =>
            WorkspaceCognition.markDocumentEvidenceStale(
              workspaceId,
              documentIds,
              "source_deleted"
            )
          )
        );
      } catch (error) {
        console.warn(
          "[WorkspaceCognition] failed to stale deleted document evidence",
          error.message
        );
      }
      return true;
    } catch (error) {
      throwModelDataAccessError("documents.delete", error);
    }
  },

  get: async function (clause = {}) {
    try {
      const document = await prisma.workspace_documents.findFirst({
        where: clause,
      });
      return document || null;
    } catch (error) {
      throwModelDataAccessError("documents.get", error);
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    include = null,
    select = null
  ) {
    try {
      const results = await prisma.workspace_documents.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
        ...(include !== null ? { include } : {}),
        ...(select !== null ? { select: { ...select } } : {}),
      });
      return results;
    } catch (error) {
      throwModelDataAccessError("documents.where", error);
    }
  },

  addDocuments: async function (
    workspace,
    additions = [],
    userId = null,
    options = {}
  ) {
    const {
      isBatchMode,
      enqueueBatchDocuments,
    } = require("../utils/DocumentEmbeddingBatch");
    const VectorDb = getVectorDbClass();
    if (additions.length === 0) return { failed: [], embedded: [] };

    if (isBatchMode(options?.embeddingModeOverride))
      return await enqueueBatchDocuments({ workspace, additions, userId });

    const { fileData } = require("../utils/files");
    const { emitProgress } = require("../utils/EmbeddingWorkerManager");
    const embedded = [];
    const documents = [];
    const failedToEmbed = [];
    const errors = new Set();

    emitProgress(workspace.slug, {
      type: "batch_starting",
      workspaceSlug: workspace.slug,
      userId,
      filenames: additions,
      totalDocs: additions.length,
    });

    for (const [index, path] of additions.entries()) {
      const docProgress = {
        workspaceSlug: workspace.slug,
        userId,
        filename: path,
        docIndex: index,
        totalDocs: additions.length,
      };

      await DocumentIndexStatus.upsertPending({
        workspaceId: workspace.id,
        filePath: path,
      });
      const data = await fileData(path);
      if (!data) {
        await DocumentIndexStatus.markFailed({
          workspaceId: workspace.id,
          filePath: path,
          errorMessage: "Failed to load file data",
        });
        emitProgress(workspace.slug, {
          type: "doc_failed",
          ...docProgress,
          error: "Failed to load file data",
        });
        continue;
      }

      const docId = uuidv4();
      const { pageContent: _pageContent, ...metadata } = data;
      const newDoc = {
        docId,
        filename: documentDisplayName(path, metadata),
        docpath: path,
        workspaceId: workspace.id,
        metadata: JSON.stringify(metadata),
      };

      await DocumentIndexStatus.markIndexing({
        workspaceId: workspace.id,
        docId,
        filePath: path,
      });
      emitProgress(workspace.slug, { type: "doc_starting", ...docProgress });

      global.__embeddingProgress = {
        workspaceSlug: workspace.slug,
        filename: path,
        userId,
      };

      const { vectorized, error } = await VectorDb.addDocumentToNamespace(
        workspace.slug,
        { ...data, docId },
        path
      );

      if (!vectorized) {
        console.error(
          "Failed to vectorize",
          metadata?.title || newDoc.filename
        );
        failedToEmbed.push(metadata?.title || newDoc.filename);
        errors.add(error);
        await DocumentIndexStatus.markFailed({
          workspaceId: workspace.id,
          docId,
          filePath: path,
          errorMessage: error || "Unknown error",
        });
        emitProgress(workspace.slug, {
          type: "doc_failed",
          ...docProgress,
          error: error || "Unknown error",
        });
        continue;
      }

      try {
        const createdDocument = (await documentSyncReady())
          ? await prisma.$transaction(async (tx) => {
              const created = await tx.workspace_documents.create({
                data: newDoc,
              });
              await recordWorkspaceDocumentsChange(tx, workspace.id, {
                changedPaths: [`documents.${created.docId}`],
                eventType: "workspace.documents.created",
              });
              return created;
            })
          : await prisma.workspace_documents.create({ data: newDoc });
        await DocumentIndexStatus.markIndexed({
          workspaceId: workspace.id,
          docId,
          filePath: path,
        });
        const {
          scheduleGraphExtractionForDocument,
        } = require("../utils/knowledgeGraph");
        scheduleGraphExtractionForDocument({
          workspace,
          document: createdDocument,
          processNow: true,
        }).catch((error) =>
          console.error(
            "[KnowledgeGraph] failed to schedule document extraction",
            error.message
          )
        );
        embedded.push(path);
        documents.push(createdDocument);
        emitProgress(workspace.slug, {
          type: "doc_complete",
          ...docProgress,
        });
      } catch (error) {
        console.error(error.message);
        await DocumentIndexStatus.markFailed({
          workspaceId: workspace.id,
          docId,
          filePath: path,
          errorMessage: "Failed to save document record",
        });
        emitProgress(workspace.slug, {
          type: "doc_failed",
          ...docProgress,
          error: "Failed to save document record",
        });
      }
    }

    global.__embeddingProgress = null;

    emitProgress(workspace.slug, {
      type: "all_complete",
      workspaceSlug: workspace.slug,
      userId,
      totalDocs: additions.length,
      embedded: embedded.length,
      failed: failedToEmbed.length,
    });

    await Telemetry.sendTelemetry("documents_embedded_in_workspace", {
      LLMSelection: process.env.LLM_PROVIDER || "openai",
      Embedder: process.env.EMBEDDING_ENGINE || "inherit",
      VectorDbSelection: process.env.VECTOR_DB || "lancedb",
      TTSSelection: process.env.TTS_PROVIDER || "native",
      LLMModel: getModelTag(),
    });
    await EventLogs.logEvent(
      "workspace_documents_added",
      {
        workspaceName: workspace?.name || "Unknown Workspace",
        numberOfDocumentsAdded: additions.length,
      },
      userId
    );
    return { failedToEmbed, errors: Array.from(errors), embedded, documents };
  },

  removeDocuments: async function (workspace, removals = [], userId = null) {
    const VectorDb = getVectorDbClass();
    if (removals.length === 0) return;

    for (const path of removals) {
      const document = await this.get({
        docpath: path,
        workspaceId: workspace.id,
      });
      if (!document) continue;
      await VectorDb.deleteDocumentFromNamespace(
        workspace.slug,
        document.docId
      );

      try {
        if (await documentSyncReady()) {
          await prisma.$transaction(async (tx) => {
            await tx.workspace_documents.delete({
              where: { id: document.id, workspaceId: workspace.id },
            });
            await tx.document_vectors.deleteMany({
              where: { docId: document.docId },
            });
            await recordWorkspaceDocumentsChange(tx, workspace.id, {
              changedPaths: [`documents.${document.docId}`],
              eventType: "workspace.documents.deleted",
            });
          });
        } else {
          await prisma.workspace_documents.delete({
            where: { id: document.id, workspaceId: workspace.id },
          });
          await prisma.document_vectors.deleteMany({
            where: { docId: document.docId },
          });
        }
        const { NodeSupplement } = require("./nodeSupplement");
        await NodeSupplement.deleteForDocument({
          workspaceId: workspace.id,
          documentId: document.docId,
        });
        const { WorkspaceSupplement } = require("./workspaceSupplement");
        await WorkspaceSupplement.deleteForDocument({
          workspaceId: workspace.id,
          documentId: document.docId,
        });
        const { KnowledgeGraph } = require("./knowledgeGraph");
        await KnowledgeGraph.deleteDocumentGraph({
          workspaceId: workspace.id,
          documentId: document.docId,
        });
        await prisma
          .$executeRawUnsafe(
            `DELETE FROM "NodeChunkBinding" WHERE "workspaceId" = ? AND "documentId" = ?`,
            Number(workspace.id),
            String(document.docId)
          )
          .catch(() => null);
        try {
          const { WorkspaceCognition } = require("./workspaceCognition");
          await WorkspaceCognition.markDocumentEvidenceStale(
            workspace.id,
            [document.docId],
            "source_deleted"
          );
        } catch (error) {
          console.warn(
            "[WorkspaceCognition] failed to stale deleted document evidence",
            error.message
          );
        }
        await DocumentIndexStatus.markDeleted({
          workspaceId: workspace.id,
          docId: document.docId,
          filePath: path,
        });
      } catch (error) {
        console.error(error.message);
      }
    }

    await EventLogs.logEvent(
      "workspace_documents_removed",
      {
        workspaceName: workspace?.name || "Unknown Workspace",
        numberOfDocuments: removals.length,
      },
      userId
    );
    return true;
  },

  reindexDocuments: async function (workspace, docIds = [], userId = null) {
    const normalized = [
      ...new Set(
        (Array.isArray(docIds) ? docIds : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .slice(0, 200)
      ),
    ];
    if (!workspace?.id || !workspace?.slug || !normalized.length)
      return { rebuilt: [], failed: [] };
    const documents = await this.where({
      workspaceId: Number(workspace.id),
      docId: { in: normalized },
    });
    const VectorDb = getVectorDbClass();
    const { fileData } = require("../utils/files");
    const rebuilt = [];
    const failed = [];
    for (const document of documents) {
      try {
        const data = await fileData(document.docpath);
        if (!data?.pageContent) throw new Error("document_source_unavailable");
        await DocumentIndexStatus.markIndexing({
          workspaceId: workspace.id,
          docId: document.docId,
          filePath: document.docpath,
        });
        await VectorDb.deleteDocumentFromNamespace(
          workspace.slug,
          document.docId
        );
        await prisma.document_vectors.deleteMany({
          where: { docId: document.docId },
        });
        const result = await VectorDb.addDocumentToNamespace(
          workspace.slug,
          { ...data, docId: document.docId },
          document.docpath
        );
        if (!result?.vectorized)
          throw new Error(result?.error || "document_reindex_failed");
        await DocumentIndexStatus.markIndexed({
          workspaceId: workspace.id,
          docId: document.docId,
          filePath: document.docpath,
        });
        rebuilt.push(document.docId);
      } catch (error) {
        await DocumentIndexStatus.markFailed({
          workspaceId: workspace.id,
          docId: document.docId,
          filePath: document.docpath,
          errorMessage: error?.code || error?.message || "reindex_failed",
        });
        failed.push({
          docId: document.docId,
          errorCode: String(
            error?.code || error?.message || "reindex_failed"
          ).slice(0, 160),
        });
      }
    }
    await EventLogs.logEvent(
      "workspace_documents_reindexed",
      {
        workspaceId: Number(workspace.id),
        requested: normalized.length,
        rebuilt: rebuilt.length,
        failed: failed.length,
      },
      userId
    );
    return { rebuilt, failed };
  },

  count: async function (clause = {}, limit = null) {
    try {
      const count = await prisma.workspace_documents.count({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
      });
      return count;
    } catch (error) {
      throwModelDataAccessError("documents.count", error);
    }
  },
  update: async function (id = null, data = {}) {
    if (!id) throw new Error("No workspace document id provided for update");

    const validKeys = Object.keys(data).filter((key) =>
      this.writable.includes(key)
    );
    if (validKeys.length === 0)
      return { document: { id }, message: "No valid fields to update!" };

    try {
      const document = (await documentSyncReady())
        ? await prisma.$transaction(async (tx) => {
            const saved = await tx.workspace_documents.update({
              where: { id },
              data,
            });
            await recordWorkspaceDocumentsChange(tx, saved.workspaceId, {
              changedPaths: validKeys.map(
                (field) => `documents.${saved.docId}.${field}`
              ),
              eventType: "workspace.documents.updated",
            });
            return saved;
          })
        : await prisma.workspace_documents.update({ where: { id }, data });
      return { document, message: null };
    } catch (error) {
      console.error(error.message);
      return { document: null, message: error.message };
    }
  },
  _updateAll: async function (clause = {}, data = {}) {
    try {
      if (await documentSyncReady()) {
        const workspaces = await prisma.workspace_documents.findMany({
          where: clause,
          select: { workspaceId: true },
          distinct: ["workspaceId"],
        });
        await prisma.$transaction(async (tx) => {
          await tx.workspace_documents.updateMany({ where: clause, data });
          for (const workspace of workspaces) {
            await recordWorkspaceDocumentsChange(tx, workspace.workspaceId, {
              changedPaths: ["documents"],
              eventType: "workspace.documents.updated",
            });
          }
        });
      } else {
        await prisma.workspace_documents.updateMany({
          where: clause,
          data,
        });
      }
      return true;
    } catch (error) {
      throwModelDataAccessError("documents._updateAll", error);
    }
  },
  create: async function (data = {}) {
    if (!(await documentSyncReady()))
      return await prisma.workspace_documents.create({ data });
    return await prisma.$transaction(async (tx) => {
      const document = await tx.workspace_documents.create({ data });
      await recordWorkspaceDocumentsChange(tx, document.workspaceId, {
        changedPaths: [`documents.${document.docId}`],
        eventType: "workspace.documents.created",
      });
      return document;
    });
  },
  content: async function (docId) {
    if (!docId) throw new Error("No workspace docId provided!");
    const document = await this.get({ docId: String(docId) });
    if (!document) throw new Error(`Could not find a document by id ${docId}`);

    const { fileData } = require("../utils/files");
    const data = await fileData(document.docpath);
    return { title: data.title, content: data.pageContent };
  },
  contentByDocPath: async function (docPath) {
    const { fileData } = require("../utils/files");
    const data = await fileData(docPath);
    return { title: data.title, content: data.pageContent };
  },

  // Some data sources have encoded params in them we don't want to log - so strip those details.
  _stripSource: function (sourceString, type) {
    if (["confluence", "github"].includes(type)) {
      const _src = new URL(sourceString);
      _src.search = ""; // remove all search params that are encoded for resync.
      return _src.toString();
    }

    return sourceString;
  },

  /**
   * Functions for the backend API endpoints - not to be used by the frontend or elsewhere.
   * @namespace api
   */
  api: {
    /**
     * Process a document upload from the API and upsert it into the database. This
     * functionality should only be used by the backend /v1/documents/upload endpoints for post-upload embedding.
     * @param {string} wsSlugs - The slugs of the workspaces to embed the document into, will be comma-separated list of workspace slugs
     * @param {string} docLocation - The location/path of the document that was uploaded
     * @returns {Promise<boolean>} - True if the document was uploaded successfully, false otherwise
     */
    uploadToWorkspace: async function (wsSlugs = "", docLocation = null) {
      if (!docLocation)
        return console.log(
          "No document location provided for embedding",
          docLocation
        );

      const slugs = wsSlugs
        .split(",")
        .map((slug) => String(slug)?.trim()?.toLowerCase());
      if (slugs.length === 0)
        return console.log(`No workspaces provided got: ${wsSlugs}`);

      const { Workspace } = require("./workspace");
      const workspaces = await Workspace.where({ slug: { in: slugs } });
      if (workspaces.length === 0)
        return console.log("No valid workspaces found for slugs: ", slugs);

      // Upsert the document into each workspace - do this sequentially
      // because the document may be large and we don't want to overwhelm the embedder, plus on the first
      // upsert we will then have the cache of the document - making n+1 embeds faster. If we parallelize this
      // we will have to do a lot of extra work to ensure that the document is not embedded more than once.
      for (const workspace of workspaces) {
        const { failedToEmbed = [], errors = [] } = await Document.addDocuments(
          workspace,
          [docLocation]
        );
        if (failedToEmbed.length > 0)
          return console.log(
            `Failed to embed document into workspace ${workspace.slug}`,
            errors
          );
        console.log(`Document embedded into workspace ${workspace.slug}...`);
      }

      return true;
    },
  },
};

module.exports = { Document };
