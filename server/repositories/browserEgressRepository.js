const { BrowserEgress } = require("../models/browserEgress");
const { createModelRepository } = require("./createModelRepository");

const BrowserEgressRepository = createModelRepository(BrowserEgress, {
  domain: "browserEgress",
  repositoryName: "BrowserEgressRepository",
});

module.exports = { BrowserEgressRepository };
