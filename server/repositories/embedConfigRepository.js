const { EmbedConfig } = require("../models/embedConfig");
const { createModelRepository } = require("./createModelRepository");

const EmbedConfigRepository = createModelRepository(EmbedConfig, {
  domain: "embed-config",
  repositoryName: "EmbedConfigRepository",
});

module.exports = { EmbedConfigRepository };
