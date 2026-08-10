import test from "node:test";
import assert from "node:assert/strict";
import English from "../../locales/en/common.js";
import Chinese from "../../locales/zh/common.js";
import Japanese from "../../locales/ja/common.js";
import { formatTimelineContent } from "./toolTimelineI18n.js";

function valueAt(resource, key) {
  return key.split(".").reduce((value, part) => value?.[part], resource);
}

function translator(resource) {
  return (key, options = {}) => {
    const template = valueAt(resource, key) ?? options.defaultValue ?? key;
    return String(template).replace(/{{(\w+)}}/g, (_, name) =>
      options[name] === undefined ? `{{${name}}}` : String(options[name])
    );
  };
}

test("all supported thinking-state keys exist in English, Chinese, and Japanese", () => {
  const keys = [
    "chat_window.turnState.reconnecting",
    "chat_window.turnState.responseFailed",
    "chat_window.toolTimeline.modelThinking",
    "chat_window.toolTimeline.modelComplete",
    "chat_window.toolTimeline.agentThinking",
    "chat_window.toolTimeline.agentComplete",
    "chat_window.toolTimeline.agentSessionStarted",
    "chat_window.toolTimeline.agentTemporarilyUnavailable",
    "chat_window.toolTimeline.agentFallbackToChat",
    "chat_window.toolTimeline.reconnecting",
    "chat_window.toolTimeline.generationStopped",
    "chat_window.toolTimeline.agentError",
  ];

  for (const resource of [English, Chinese, Japanese]) {
    for (const key of keys) {
      assert.equal(typeof valueAt(resource, key), "string", key);
      assert.notEqual(valueAt(resource, key).trim(), "", key);
    }
  }
});

test("stored canonical agent events render in Chinese", () => {
  const t = translator(Chinese);
  assert.equal(
    formatTimelineContent(
      "@agent: Swapping over to agent chat. Type /exit to exit agent execution loop early.",
      t
    ),
    "已进入智能体模式。输入 /exit 可结束智能体会话。"
  );
  assert.equal(
    formatTimelineContent(
      "Agent connection interrupted. Reconnecting 2/5...",
      t
    ),
    "智能体连接中断，正在重新连接（2/5）…"
  );
});

test("stored canonical agent events render in Japanese", () => {
  const t = translator(Japanese);
  assert.equal(
    formatTimelineContent("Agent is thinking...", t),
    "エージェントが思考中..."
  );
  assert.equal(
    formatTimelineContent("Generation stopped by user.", t),
    "生成を停止しました。"
  );
});

test("Agent persistence failures are localized without a false chat fallback", () => {
  assert.equal(
    formatTimelineContent(
      "agent_invocation_store_unavailable",
      translator(Chinese)
    ),
    "智能体服务暂时不可用。您的消息已保留，请稍后重试。"
  );
  assert.equal(
    formatTimelineContent(
      "agent_persistence_contract_incompatible",
      translator(Japanese)
    ),
    "エージェントサービスは一時的に利用できません。メッセージは保持されています。しばらくしてから再試行してください。"
  );
});

test("agent fallback keeps the requested handle while translating the message", () => {
  const t = translator(Chinese);
  assert.equal(
    formatTimelineContent(
      "Agents could not be called. Chat will be handled as default chat.",
      t
    ),
    "无法启动请求的智能体，将继续使用普通聊天。"
  );
  assert.equal(
    formatTimelineContent(
      "Agent @agent could not be called. Chat will be handled as default chat.",
      t
    ),
    "无法启动请求的智能体（@agent），将继续使用普通聊天。"
  );
  assert.equal(
    formatTimelineContent(
      "Agents  could not be called. Chat will be handled as default chat.",
      t
    ),
    "无法启动请求的智能体，将继续使用普通聊天。"
  );
});

test("unrecognized model and tool text remains unchanged", () => {
  const t = translator(English);
  assert.equal(
    formatTimelineContent("Provider-specific reasoning stage", t),
    "Provider-specific reasoning stage"
  );
});
