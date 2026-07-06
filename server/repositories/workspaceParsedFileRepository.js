const { WorkspaceParsedFiles } = require("../models/workspaceParsedFiles");
const { createModelRepository } = require("./createModelRepository");

const WorkspaceParsedFileRepository = createModelRepository(
  WorkspaceParsedFiles,
  {
    domain: "workspace-parsed-file",
    repositoryName: "WorkspaceParsedFileRepository",
  }
);

module.exports = { WorkspaceParsedFileRepository };
