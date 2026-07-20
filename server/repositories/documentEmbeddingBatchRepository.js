const prisma = require("../utils/prisma");
const { SystemSettings } = require("../models/systemSettings");
const { EmbeddingBatchJob } = require("../models/embeddingBatchJob");
const { Document } = require("../models/documents");

const workspaceDocuments = {
  create: (options = {}) => Document.create(options.data || {}),
  findFirst: (options = {}) => prisma.workspace_documents.findFirst(options),
  findMany: (options = {}) => prisma.workspace_documents.findMany(options),
  updateMany: (options = {}) =>
    Document._updateAll(options.where || {}, options.data || {}),
};

const DocumentEmbeddingBatchRepository = {
  dataDomain: "document-embedding-batch",
  repositoryName: "DocumentEmbeddingBatchRepository",

  get embeddingBatchJob() {
    return EmbeddingBatchJob;
  },

  get systemSettings() {
    return SystemSettings;
  },

  get workspaceDocuments() {
    return workspaceDocuments;
  },

  get db() {
    return {
      workspaceDocuments,
      workspace_documents: workspaceDocuments,
    };
  },
};

module.exports = { DocumentEmbeddingBatchRepository };
