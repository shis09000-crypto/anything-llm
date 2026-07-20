const {
  WorkspaceMeetingDelegate,
} = require("../models/workspaceMeetingDelegate");
const { createModelRepository } = require("./createModelRepository");

const WorkspaceMeetingDelegateRepository = createModelRepository(
  WorkspaceMeetingDelegate,
  {
    domain: "workspace-meeting-delegate",
    repositoryName: "WorkspaceMeetingDelegateRepository",
  }
);

module.exports = { WorkspaceMeetingDelegateRepository };
