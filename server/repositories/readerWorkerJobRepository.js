const { ReaderWorkerJob } = require("../models/readerWorkerJob");
const { createModelRepository } = require("./createModelRepository");

const ReaderWorkerJobRepository = createModelRepository(ReaderWorkerJob, {
  domain: "reader-worker-job",
  repositoryName: "ReaderWorkerJobRepository",
});

module.exports = { ReaderWorkerJobRepository };
