const { WorkspaceThreadGoal } = require("../models/workspaceThreadGoal");
const { createModelRepository } = require("./createModelRepository");

const WorkspaceThreadGoalRepository = createModelRepository(
  WorkspaceThreadGoal,
  {
    domain: "workspace-thread-goal",
    repositoryName: "WorkspaceThreadGoalRepository",
  }
);

module.exports = { WorkspaceThreadGoalRepository };
