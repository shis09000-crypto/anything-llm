const { LocalRuntime } = require("../models/localRuntime");
const { createModelRepository } = require("./createModelRepository");

const LocalRuntimeRepository = createModelRepository(LocalRuntime, {
  domain: "localRuntime",
  repositoryName: "LocalRuntimeRepository",
});

module.exports = { LocalRuntimeRepository };
