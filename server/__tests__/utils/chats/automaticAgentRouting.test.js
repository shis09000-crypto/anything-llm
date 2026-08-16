const {
  shouldBypassAutomaticAgentRouting,
} = require("../../../utils/chats/automaticAgentRouting");

describe("automaticAgentRouting", () => {
  test.each([
    "哈咯",
    "你好！",
    "谢谢",
    "收到",
    "我是小明",
    "Hello",
    "thanks!",
  ])("keeps short social message in normal chat: %s", (message) => {
    expect(shouldBypassAutomaticAgentRouting(message)).toBe(true);
  });

  test.each([
    "帮我搜索一下今天的新闻",
    "查询我的加密资产",
    "读取这个文件并总结",
    "@agent 哈咯",
    "你好，请帮我调用工具检查服务器",
    "我是小明，帮我记住并创建一个文件",
  ])("preserves agent routing for actionable message: %s", (message) => {
    expect(shouldBypassAutomaticAgentRouting(message)).toBe(false);
  });
});
