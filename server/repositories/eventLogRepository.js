const { EventLogs } = require("../models/eventLogs");
const { createModelRepository } = require("./createModelRepository");

const EventLogRepository = createModelRepository(EventLogs, {
  domain: "event-log",
  repositoryName: "EventLogRepository",
});

module.exports = { EventLogRepository };
