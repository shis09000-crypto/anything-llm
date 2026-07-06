const {
  WorkspaceChatCompaction,
} = require("../models/workspaceChatCompaction");
const { createModelRepository } = require("./createModelRepository");

const WorkspaceChatCompactionRepository = createModelRepository(
  WorkspaceChatCompaction,
  {
    domain: "workspace-chat-compaction",
    repositoryName: "WorkspaceChatCompactionRepository",
  }
);

module.exports = { WorkspaceChatCompactionRepository };
