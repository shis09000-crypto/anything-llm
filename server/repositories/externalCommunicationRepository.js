const {
  ExternalCommunicationConnector,
} = require("../models/externalCommunicationConnector");
const { createModelRepository } = require("./createModelRepository");

const ExternalCommunicationRepository = createModelRepository(
  ExternalCommunicationConnector,
  {
    domain: "external-communication",
    repositoryName: "ExternalCommunicationRepository",
  }
);

module.exports = { ExternalCommunicationRepository };
