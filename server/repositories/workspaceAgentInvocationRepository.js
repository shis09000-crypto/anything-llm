const {
  WorkspaceAgentInvocation,
} = require("../models/workspaceAgentInvocation");
const { createModelRepository } = require("./createModelRepository");

const WorkspaceAgentInvocationRepository = createModelRepository(
  WorkspaceAgentInvocation,
  {
    domain: "workspace-agent-invocation",
    repositoryName: "WorkspaceAgentInvocationRepository",
  }
);

module.exports = { WorkspaceAgentInvocationRepository };
