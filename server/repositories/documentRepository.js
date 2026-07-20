const { Document } = require("../models/documents");
const { createModelRepository } = require("./createModelRepository");

const DocumentRepository = createModelRepository(Document, {
  domain: "document",
  repositoryName: "DocumentRepository",
});

DocumentRepository.create = async function (data = {}) {
  return await Document.create(data);
};

module.exports = { DocumentRepository };
