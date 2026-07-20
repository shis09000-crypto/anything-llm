const { ContentObject } = require("../models/contentObject");
const { createModelRepository } = require("./createModelRepository");

const ContentObjectRepository = createModelRepository(ContentObject, {
  domain: "content-object",
  repositoryName: "ContentObjectRepository",
});

module.exports = { ContentObjectRepository };
