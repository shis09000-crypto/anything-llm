const { SyncEvent } = require("../models/syncEvent");
const { createModelRepository } = require("./createModelRepository");

const SyncEventRepository = createModelRepository(SyncEvent, {
  domain: "sync-event",
  repositoryName: "SyncEventRepository",
});

module.exports = { SyncEventRepository };
