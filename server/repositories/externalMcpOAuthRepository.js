const { McpOAuth } = require("../models/mcpOAuth");
const { createModelRepository } = require("./createModelRepository");

const ExternalMcpOAuthRepository = createModelRepository(McpOAuth, {
  domain: "external-mcp-oauth",
  repositoryName: "ExternalMcpOAuthRepository",
});

module.exports = { ExternalMcpOAuthRepository };
