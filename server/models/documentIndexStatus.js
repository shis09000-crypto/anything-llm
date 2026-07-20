const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const prisma = require("../utils/prisma");
const { storagePath } = require("../utils/environment");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");

const documentsPath = storagePath("documents");

function normalizePath(filepath = "") {
  const result = path
    .normalize(String(filepath).trim())
    .replace(/^(\.\.(\/|\\|$))+/, "")
    .trim();
  if (!result || ["..", ".", "/"].includes(result))
    throw new Error("Invalid path.");
  return result;
}

function isWithin(outer, inner) {
  if (outer === inner) return false;
  const rel = path.relative(outer, inner);
  return !rel.startsWith("../") && rel !== "..";
}

async function writeStatus(
  { workspaceId, docId = null, filePath, create = {}, update = {} },
  eventType
) {
  const normalizedWorkspaceId = Number(workspaceId);
  const apply = async (tx) => {
    const existing = await tx.documentIndexStatus.findUnique({
      where: {
        workspaceId_filePath: {
          workspaceId: normalizedWorkspaceId,
          filePath,
        },
      },
    });
    const target = { ...(docId !== undefined ? { docId } : {}), ...update };
    const changed =
      !existing ||
      Object.entries(target).some(([field, value]) => {
        const current = existing[field];
        if (current instanceof Date || value instanceof Date) {
          return (
            new Date(current || 0).getTime() !== new Date(value || 0).getTime()
          );
        }
        return (
          JSON.stringify(current ?? null) !== JSON.stringify(value ?? null)
        );
      });
    if (!changed) return existing;
    const row = await tx.documentIndexStatus.upsert({
      where: {
        workspaceId_filePath: {
          workspaceId: normalizedWorkspaceId,
          filePath,
        },
      },
      create: {
        workspaceId: normalizedWorkspaceId,
        docId,
        filePath,
        ...create,
        ...update,
      },
      update: target,
    });
    if (tx !== prisma) {
      await SyncV2.recordNodeChange(tx, {
        nodeKey: nodeKeys.workspaceDomain(
          normalizedWorkspaceId,
          "document-status"
        ),
        content: { workspaceId: normalizedWorkspaceId },
        eventType,
        changedPaths: [`documents.${docId || filePath}.indexStatus`],
        payloadHint: {
          workspaceId: normalizedWorkspaceId,
          docId,
          indexStatus: row.indexStatus,
        },
      });
    }
    return row;
  };
  const syncReady = SyncV2.enabled("documents") && (await SyncV2.schemaReady());
  return syncReady ? prisma.$transaction(apply) : apply(prisma);
}

async function updateStatusRow(row, data, eventType) {
  const apply = async (tx) => {
    const updated = await tx.documentIndexStatus.update({
      where: { id: row.id },
      data,
    });
    if (tx !== prisma) {
      await SyncV2.recordNodeChange(tx, {
        nodeKey: nodeKeys.workspaceDomain(row.workspaceId, "document-status"),
        content: { workspaceId: Number(row.workspaceId) },
        eventType,
        changedPaths: [`documents.${row.docId || row.filePath}.indexStatus`],
        payloadHint: {
          workspaceId: Number(row.workspaceId),
          docId: row.docId,
          indexStatus: updated.indexStatus,
        },
      });
    }
    return updated;
  };
  const syncReady = SyncV2.enabled("documents") && (await SyncV2.schemaReady());
  return syncReady ? prisma.$transaction(apply) : apply(prisma);
}

const DocumentIndexStatus = {
  statuses: {
    pending: "pending",
    indexing: "indexing",
    indexed: "indexed",
    outdated: "outdated",
    failed: "failed",
    deleted: "deleted",
  },

  validStatuses: [
    "pending",
    "indexing",
    "indexed",
    "outdated",
    "failed",
    "deleted",
  ],

  computeFileHash: function (filePath = null) {
    if (!filePath) return "";
    const fullFilePath = path.resolve(documentsPath, normalizePath(filePath));
    if (!fs.existsSync(fullFilePath) || !isWithin(documentsPath, fullFilePath))
      return "";
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(fullFilePath))
      .digest("hex");
  },

  embeddingCountForDoc: async function (docId = null) {
    if (!docId) return 0;
    return await prisma.document_vectors.count({ where: { docId } });
  },

  upsertPending: async function ({ workspaceId, docId = null, filePath }) {
    if (!workspaceId || !filePath) return null;
    const fileHash = this.computeFileHash(filePath);
    return await writeStatus(
      {
        workspaceId,
        docId,
        filePath,
        create: { fileHash },
        update: {
          fileHash,
          indexStatus: this.statuses.pending,
          errorMessage: null,
        },
      },
      "workspace.document_status.pending"
    );
  },

  markIndexing: async function ({ workspaceId, docId = null, filePath }) {
    if (!workspaceId || !filePath) return null;
    const fileHash = this.computeFileHash(filePath);
    return await writeStatus(
      {
        workspaceId,
        docId,
        filePath,
        create: { fileHash },
        update: {
          fileHash,
          indexStatus: this.statuses.indexing,
          errorMessage: null,
        },
      },
      "workspace.document_status.indexing"
    );
  },

  markIndexed: async function ({
    workspaceId,
    docId = null,
    filePath,
    chunkCount = null,
    embeddingCount = null,
  }) {
    if (!workspaceId || !filePath) return null;
    const resolvedEmbeddingCount =
      embeddingCount ?? (await this.embeddingCountForDoc(docId));
    const resolvedChunkCount = chunkCount ?? resolvedEmbeddingCount;
    const fileHash = this.computeFileHash(filePath);
    return await writeStatus(
      {
        workspaceId,
        docId,
        filePath,
        create: { fileHash },
        update: {
          fileHash,
          indexStatus: this.statuses.indexed,
          indexedAt: new Date(),
          errorMessage: null,
          chunkCount: Number(resolvedChunkCount || 0),
          embeddingCount: Number(resolvedEmbeddingCount || 0),
        },
      },
      "workspace.document_status.indexed"
    );
  },

  markFailed: async function ({
    workspaceId,
    docId = null,
    filePath,
    errorMessage = "Unknown error",
  }) {
    if (!workspaceId || !filePath) return null;
    return await writeStatus(
      {
        workspaceId,
        docId,
        filePath,
        create: { fileHash: this.computeFileHash(filePath) },
        update: {
          indexStatus: this.statuses.failed,
          errorMessage: String(errorMessage || "Unknown error"),
        },
      },
      "workspace.document_status.failed"
    );
  },

  markDeleted: async function ({ workspaceId, docId = null, filePath }) {
    if (!workspaceId || !filePath) return null;
    return await writeStatus(
      {
        workspaceId,
        docId,
        filePath,
        create: { fileHash: this.computeFileHash(filePath) },
        update: {
          indexStatus: this.statuses.deleted,
          errorMessage: null,
        },
      },
      "workspace.document_status.deleted"
    );
  },

  markOutdatedIfHashChanged: async function (statusRecord = null) {
    if (!statusRecord || statusRecord.indexStatus !== this.statuses.indexed)
      return statusRecord;
    const currentHash = this.computeFileHash(statusRecord.filePath);
    if (!currentHash || currentHash === statusRecord.fileHash)
      return statusRecord;
    return await updateStatusRow(
      statusRecord,
      {
        indexStatus: this.statuses.outdated,
        errorMessage: `File hash changed from ${statusRecord.fileHash} to ${currentHash}.`,
      },
      "workspace.document_status.outdated"
    );
  },

  forWorkspace: async function (workspaceId = null) {
    if (!workspaceId) return [];
    const rows = await prisma.documentIndexStatus.findMany({
      where: { workspaceId: Number(workspaceId) },
      orderBy: { updatedAt: "desc" },
    });
    return await Promise.all(
      rows.map((row) => this.markOutdatedIfHashChanged(row))
    );
  },

  forFilePaths: async function (filePaths = [], workspaceId = null) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return [];
    const rows = await prisma.documentIndexStatus.findMany({
      where: {
        filePath: { in: filePaths },
        ...(workspaceId ? { workspaceId: Number(workspaceId) } : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
    return await Promise.all(
      rows.map((row) => this.markOutdatedIfHashChanged(row))
    );
  },

  where: async function ({
    workspaceId = null,
    filePath = null,
    docId = null,
  }) {
    const rows = await prisma.documentIndexStatus.findMany({
      where: {
        ...(workspaceId ? { workspaceId: Number(workspaceId) } : {}),
        ...(filePath ? { filePath } : {}),
        ...(docId ? { docId } : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
    return await Promise.all(
      rows.map((row) => this.markOutdatedIfHashChanged(row))
    );
  },

  manualUpdate: async function ({
    workspaceId,
    filePath,
    docId = null,
    indexStatus,
    errorMessage = null,
    chunkCount = null,
    embeddingCount = null,
  }) {
    if (!this.validStatuses.includes(indexStatus))
      throw new Error(`Invalid indexStatus: ${indexStatus}`);
    if (!workspaceId || !filePath)
      throw new Error("workspaceId and filePath are required.");

    return await writeStatus(
      {
        workspaceId,
        docId,
        filePath,
        create: { fileHash: this.computeFileHash(filePath) },
        update: {
          indexStatus,
          ...(errorMessage !== undefined
            ? { errorMessage: errorMessage ? String(errorMessage) : null }
            : {}),
          ...(chunkCount !== null ? { chunkCount: Number(chunkCount) } : {}),
          ...(embeddingCount !== null
            ? { embeddingCount: Number(embeddingCount) }
            : {}),
          ...(indexStatus === this.statuses.indexed
            ? {
                fileHash: this.computeFileHash(filePath),
                indexedAt: new Date(),
                errorMessage: null,
              }
            : {}),
        },
      },
      `workspace.document_status.${indexStatus}`
    );
  },
};

module.exports = { DocumentIndexStatus };
