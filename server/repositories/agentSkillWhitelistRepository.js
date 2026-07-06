const { AgentSkillWhitelist } = require("../models/agentSkillWhitelist");
const { createModelRepository } = require("./createModelRepository");

const AgentSkillWhitelistRepository = createModelRepository(
  AgentSkillWhitelist,
  {
    domain: "agent-skill-whitelist",
    repositoryName: "AgentSkillWhitelistRepository",
  }
);

module.exports = { AgentSkillWhitelistRepository };
