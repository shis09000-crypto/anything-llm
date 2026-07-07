const { DocumentSyncRun } = require("../models/documentSyncRun");
const { createModelRepository } = require("./createModelRepository");

const DocumentSyncRunRepository = createModelRepository(DocumentSyncRun, {
  domain: "document-sync-run",
  repositoryName: "DocumentSyncRunRepository",
});

module.exports = { DocumentSyncRunRepository };
