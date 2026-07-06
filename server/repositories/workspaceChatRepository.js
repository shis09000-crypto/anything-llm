const { WorkspaceChats } = require("../models/workspaceChats");
const { createModelRepository } = require("./createModelRepository");

const WorkspaceChatRepository = createModelRepository(WorkspaceChats, {
  domain: "workspace-chat",
  repositoryName: "WorkspaceChatRepository",
});

module.exports = { WorkspaceChatRepository };
