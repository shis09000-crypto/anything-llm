const { DocumentIndexStatus } = require("../models/documentIndexStatus");
const { createModelRepository } = require("./createModelRepository");

const DocumentIndexStatusRepository = createModelRepository(
  DocumentIndexStatus,
  {
    domain: "document-index-status",
    repositoryName: "DocumentIndexStatusRepository",
  }
);

module.exports = { DocumentIndexStatusRepository };
