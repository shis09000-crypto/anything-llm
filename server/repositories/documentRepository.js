const { Document } = require("../models/documents");
const { createModelRepository } = require("./createModelRepository");
const prisma = require("../utils/prisma");

const DocumentRepository = createModelRepository(Document, {
  domain: "document",
  repositoryName: "DocumentRepository",
});

DocumentRepository.create = async function (data = {}) {
  return await prisma.workspace_documents.create({ data });
};

module.exports = { DocumentRepository };
