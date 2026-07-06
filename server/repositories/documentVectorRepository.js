const { DocumentVectors } = require("../models/vectors");
const { createModelRepository } = require("./createModelRepository");

const DocumentVectorRepository = createModelRepository(DocumentVectors, {
  domain: "document-vector",
  repositoryName: "DocumentVectorRepository",
});

module.exports = { DocumentVectorRepository };
