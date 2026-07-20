const { SyncV2 } = require("../models/syncV2");
const { createModelRepository } = require("./createModelRepository");

const SyncV2Repository = createModelRepository(SyncV2, {
  domain: "sync-v2",
  repositoryName: "SyncV2Repository",
});

module.exports = { SyncV2Repository };
