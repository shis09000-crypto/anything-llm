const { Document } = require("../models/documents");
const { createModelRepository } = require("./createModelRepository");

const DocumentRepository = createModelRepository(Document, {
  domain: "document",
  repositoryName: "DocumentRepository",
});

module.exports = { DocumentRepository };
