const { SystemPromptVariables } = require("../models/systemPromptVariables");
const { createModelRepository } = require("./createModelRepository");

const SystemPromptVariableRepository = createModelRepository(
  SystemPromptVariables,
  {
    domain: "system-prompt-variable",
    repositoryName: "SystemPromptVariableRepository",
  }
);

module.exports = { SystemPromptVariableRepository };
