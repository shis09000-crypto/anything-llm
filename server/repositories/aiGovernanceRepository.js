const { AIGovernance } = require("../models/aiGovernance");
const { createModelRepository } = require("./createModelRepository");

const AIGovernanceRepository = createModelRepository(AIGovernance, {
  domain: "ai-governance",
  repositoryName: "AIGovernanceRepository",
});

module.exports = { AIGovernanceRepository };
