const { AgentRun } = require("../models/agentRun");
const { createModelRepository } = require("./createModelRepository");

const AgentRunRepository = createModelRepository(AgentRun, {
  domain: "agent-run",
  repositoryName: "AgentRunRepository",
});

module.exports = { AgentRunRepository };
