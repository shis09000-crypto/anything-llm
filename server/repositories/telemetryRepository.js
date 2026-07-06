const { Telemetry } = require("../models/telemetry");
const { createModelRepository } = require("./createModelRepository");

const TelemetryRepository = createModelRepository(Telemetry, {
  domain: "telemetry",
  repositoryName: "TelemetryRepository",
});

module.exports = { TelemetryRepository };
