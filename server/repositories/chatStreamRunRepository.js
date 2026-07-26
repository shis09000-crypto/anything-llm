const { ChatStreamRun } = require("../models/chatStreamRun");
const { createModelRepository } = require("./createModelRepository");

const ChatStreamRunRepository = createModelRepository(ChatStreamRun, {
  domain: "chat-stream-run",
  repositoryName: "ChatStreamRunRepository",
});

module.exports = { ChatStreamRunRepository };
