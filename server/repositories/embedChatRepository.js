const { EmbedChats } = require("../models/embedChats");
const { createModelRepository } = require("./createModelRepository");

const EmbedChatRepository = createModelRepository(EmbedChats, {
  domain: "embed-chat",
  repositoryName: "EmbedChatRepository",
});

module.exports = { EmbedChatRepository };
