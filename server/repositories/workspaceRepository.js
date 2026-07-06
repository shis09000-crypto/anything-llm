const { Workspace } = require("../models/workspace");
const { createModelRepository } = require("./createModelRepository");

const WorkspaceRepository = createModelRepository(Workspace, {
  domain: "workspace",
  repositoryName: "WorkspaceRepository",
});

module.exports = { WorkspaceRepository };
