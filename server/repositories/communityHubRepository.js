const { CommunityHub } = require("../models/communityHub");
const { createModelRepository } = require("./createModelRepository");

const CommunityHubRepository = createModelRepository(CommunityHub, {
  domain: "community-hub",
  repositoryName: "CommunityHubRepository",
});

module.exports = { CommunityHubRepository };
