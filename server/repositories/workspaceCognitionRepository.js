const { WorkspaceCognition } = require("../models/workspaceCognition");
const { createModelRepository } = require("./createModelRepository");

const WorkspaceCognitionRepository = createModelRepository(WorkspaceCognition, {
  domain: "workspace-cognition",
  repositoryName: "WorkspaceCognitionRepository",
});

module.exports = { WorkspaceCognitionRepository };
