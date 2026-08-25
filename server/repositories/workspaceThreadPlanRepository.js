const { WorkspaceThreadPlan } = require("../models/workspaceThreadPlan");
const { createModelRepository } = require("./createModelRepository");

const WorkspaceThreadPlanRepository = createModelRepository(
  WorkspaceThreadPlan,
  {
    domain: "workspace-thread-plan",
    repositoryName: "WorkspaceThreadPlanRepository",
  }
);

module.exports = { WorkspaceThreadPlanRepository };
