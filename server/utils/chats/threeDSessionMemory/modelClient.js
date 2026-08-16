const crypto = require("crypto");
const { requestInternalService } = require("../../microModules");

const BACKGROUND_PROVIDER = "deepseek";
const BACKGROUND_MODEL = "deepseek-v4-flash";

function gatewayUrl(env = process.env) {
  const value = String(env.ATHENA_MODEL_GATEWAY_URL || "").replace(/\/+$/, "");
  if (!value) {
    const error = new Error("model_gateway_url_missing");
    error.code = "model_gateway_url_missing";
    throw error;
  }
  return value;
}

async function compactConversationMemory(
  { checkpoint, turns, maxOutputTokens },
  env = process.env
) {
  const provider = BACKGROUND_PROVIDER;
  const model = BACKGROUND_MODEL;
  const body = {
    provider,
    model,
    input: [
      {
        type: "message",
        role: "user",
        content: JSON.stringify({ checkpoint: checkpoint || null, turns }),
      },
    ],
    instructions: [
      "你是 Athena 3D Center 会话记忆压缩器。只输出一个合法 JSON object。",
      "只压缩用户与角色说过的语言，不解释动作、表情、状态、时间线或执行事件。",
      "保留人物关系、称呼、明确事实、承诺、偏好、未完成话题、时间顺序和语气变化。",
      "输出字段必须为 summary、preserved_facts、open_threads、conversation_tone。",
      "summary 是可直接作为下一轮会话上下文的中文压缩记忆；其余三个字段均为数组。",
    ].join("\n"),
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_output_tokens: maxOutputTokens,
    stream: false,
  };
  const response = await requestInternalService({
    callerRole: "chat-runtime",
    targetModule: "model-gateway",
    capability: "model.responses.complete",
    contractVersion: "1.0",
    url: `${gatewayUrl(env)}/internal/v1/models/responses/complete`,
    body,
    idempotencyKey: crypto
      .createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex"),
    env,
    timeoutMs: Number(env.ATHENA_MODEL_GATEWAY_TIMEOUT_MS || 300_000),
  });
  const content = String(response?.result?.output_text || "").trim();
  if (!content) {
    const error = new Error("athena_3d_memory_compaction_empty");
    error.code = "athena_3d_memory_compaction_empty";
    throw error;
  }
  try {
    const parsed = JSON.parse(content);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
      throw new Error("json_object_required");
    if (
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.preserved_facts) ||
      !Array.isArray(parsed.open_threads) ||
      !Array.isArray(parsed.conversation_tone)
    )
      throw new Error("compaction_contract_invalid");
    return { payload: parsed, provider, model };
  } catch (cause) {
    const error = new Error("athena_3d_memory_compaction_json_invalid", {
      cause,
    });
    error.code = "athena_3d_memory_compaction_json_invalid";
    throw error;
  }
}

module.exports = {
  BACKGROUND_MODEL,
  BACKGROUND_PROVIDER,
  compactConversationMemory,
};
