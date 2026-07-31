const { BrowserPlane } = require("../models/browserPlane");
const { createModelRepository } = require("./createModelRepository");

const BrowserPlaneRepository = createModelRepository(BrowserPlane, {
  domain: "browserPlane",
  repositoryName: "BrowserPlaneRepository",
});

module.exports = { BrowserPlaneRepository };
