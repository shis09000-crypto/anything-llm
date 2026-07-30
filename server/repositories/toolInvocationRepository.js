const { ToolInvocation } = require("../models/toolInvocation");
const { createModelRepository } = require("./createModelRepository");

const ToolInvocationRepository = createModelRepository(ToolInvocation, {
  domain: "tool-invocation",
  repositoryName: "ToolInvocationRepository",
});

module.exports = { ToolInvocationRepository };
