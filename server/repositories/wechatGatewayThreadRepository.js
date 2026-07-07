const { WeChatGatewayThread } = require("../models/wechatGatewayThread");
const { createModelRepository } = require("./createModelRepository");

const WeChatGatewayThreadRepository = createModelRepository(
  WeChatGatewayThread,
  {
    domain: "wechat-gateway-thread",
    repositoryName: "WeChatGatewayThreadRepository",
  }
);

module.exports = { WeChatGatewayThreadRepository };
