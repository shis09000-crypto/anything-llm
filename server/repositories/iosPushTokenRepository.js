const { IOSPushToken } = require("../models/iosPushToken");
const { createModelRepository } = require("./createModelRepository");

const IOSPushTokenRepository = createModelRepository(IOSPushToken, {
  domain: "ios-push-token",
  repositoryName: "IOSPushTokenRepository",
});

module.exports = { IOSPushTokenRepository };
