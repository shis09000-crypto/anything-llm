const { DocumentSyncQueue } = require("../models/documentSyncQueue");
const { createModelRepository } = require("./createModelRepository");

const DocumentSyncQueueRepository = createModelRepository(DocumentSyncQueue, {
  domain: "document-sync-queue",
  repositoryName: "DocumentSyncQueueRepository",
});

module.exports = { DocumentSyncQueueRepository };
