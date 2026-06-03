const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const prisma = require("../utils/prisma");
const { storagePath } = require("../utils/environment");

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
    return await prisma.documentIndexStatus.upsert({
      where: {
        workspaceId_filePath: {
          workspaceId: Number(workspaceId),
          filePath,
        },
      },
      create: {
        workspaceId: Number(workspaceId),
        docId,
        filePath,
        fileHash,
        indexStatus: this.statuses.pending,
        errorMessage: null,
      },
      update: {
        docId,
        fileHash,
        indexStatus: this.statuses.pending,
        errorMessage: null,
      },
    });
  },

  markIndexing: async function ({ workspaceId, docId = null, filePath }) {
    if (!workspaceId || !filePath) return null;
    await this.upsertPending({ workspaceId, docId, filePath });
    return await prisma.documentIndexStatus.update({
      where: {
        workspaceId_filePath: {
          workspaceId: Number(workspaceId),
          filePath,
        },
      },
      data: {
        docId,
        fileHash: this.computeFileHash(filePath),
        indexStatus: this.statuses.indexing,
        errorMessage: null,
      },
    });
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
    await this.upsertPending({ workspaceId, docId, filePath });
    return await prisma.documentIndexStatus.update({
      where: {
        workspaceId_filePath: {
          workspaceId: Number(workspaceId),
          filePath,
        },
      },
      data: {
        docId,
        fileHash: this.computeFileHash(filePath),
        indexStatus: this.statuses.indexed,
        indexedAt: new Date(),
        errorMessage: null,
        chunkCount: Number(resolvedChunkCount || 0),
        embeddingCount: Number(resolvedEmbeddingCount || 0),
      },
    });
  },

  markFailed: async function ({
    workspaceId,
    docId = null,
    filePath,
    errorMessage = "Unknown error",
  }) {
    if (!workspaceId || !filePath) return null;
    await this.upsertPending({ workspaceId, docId, filePath });
    return await prisma.documentIndexStatus.update({
      where: {
        workspaceId_filePath: {
          workspaceId: Number(workspaceId),
          filePath,
        },
      },
      data: {
        docId,
        indexStatus: this.statuses.failed,
        errorMessage: String(errorMessage || "Unknown error"),
      },
    });
  },

  markDeleted: async function ({ workspaceId, docId = null, filePath }) {
    if (!workspaceId || !filePath) return null;
    await this.upsertPending({ workspaceId, docId, filePath });
    return await prisma.documentIndexStatus.update({
      where: {
        workspaceId_filePath: {
          workspaceId: Number(workspaceId),
          filePath,
        },
      },
      data: {
        docId,
        indexStatus: this.statuses.deleted,
        errorMessage: null,
      },
    });
  },

  markOutdatedIfHashChanged: async function (statusRecord = null) {
    if (!statusRecord || statusRecord.indexStatus !== this.statuses.indexed)
      return statusRecord;
    const currentHash = this.computeFileHash(statusRecord.filePath);
    if (!currentHash || currentHash === statusRecord.fileHash)
      return statusRecord;
    return await prisma.documentIndexStatus.update({
      where: { id: statusRecord.id },
      data: {
        indexStatus: this.statuses.outdated,
        errorMessage: `File hash changed from ${statusRecord.fileHash} to ${currentHash}.`,
      },
    });
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

    await this.upsertPending({ workspaceId, docId, filePath });
    return await prisma.documentIndexStatus.update({
      where: {
        workspaceId_filePath: {
          workspaceId: Number(workspaceId),
          filePath,
        },
      },
      data: {
        ...(docId ? { docId } : {}),
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
    });
  },
};

module.exports = { DocumentIndexStatus };
