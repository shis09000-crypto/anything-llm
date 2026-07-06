const prisma = require("../utils/prisma");
const { SystemSettings } = require("../models/systemSettings");
const { EmbeddingBatchJob } = require("../models/embeddingBatchJob");

const workspaceDocuments = {
  create: (options = {}) => prisma.workspace_documents.create(options),
  findFirst: (options = {}) => prisma.workspace_documents.findFirst(options),
  findMany: (options = {}) => prisma.workspace_documents.findMany(options),
  updateMany: (options = {}) => prisma.workspace_documents.updateMany(options),
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
