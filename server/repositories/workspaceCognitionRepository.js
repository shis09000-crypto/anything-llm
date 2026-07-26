const { WorkspaceCognition } = require("../models/workspaceCognition");
const {
  startWorkspaceCognitionWorker,
  stopWorkspaceCognitionWorker,
  workspaceCognitionWorkerSnapshot,
} = require("../models/workspaceCognitionBatch");
const { createModelRepository } = require("./createModelRepository");

const WorkspaceCognitionRepository = createModelRepository(WorkspaceCognition, {
  domain: "workspace-cognition",
  repositoryName: "WorkspaceCognitionRepository",
});

WorkspaceCognitionRepository.startWorker = startWorkspaceCognitionWorker;
WorkspaceCognitionRepository.stopWorker = stopWorkspaceCognitionWorker;
WorkspaceCognitionRepository.workerSnapshot = workspaceCognitionWorkerSnapshot;

module.exports = { WorkspaceCognitionRepository };
