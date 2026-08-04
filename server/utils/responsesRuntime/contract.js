const crypto = require("crypto");
const {
  stripCurrentDateTimePromptBlock,
} = require("../chats/currentDateTimeContext");
const { normalizeHostedTools } = require("./hostedTools");

const FLASH_MODEL = "deepseek-v4-flash";
const RESPONSE_OBJECT = "response";
const RESPONSE_STATUSES = Object.freeze([
  "queued",
  "in_progress",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
]);
const TERMINAL_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
]);
const STREAM_EVENT_TYPES = Object.freeze([
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.content_part.added",
  "response.output_text.delta",
  "response.function_call_arguments.delta",
  "response.output_item.done",
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value
      .map((item) =>
        item === undefined ||
        typeof item === "function" ||
        typeof item === "symbol"
          ? "null"
          : canonicalJson(item)
      )
      .join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter(
        (key) =>
          value[key] !== undefined &&
          typeof value[key] !== "function" &&
          typeof value[key] !== "symbol"
      )
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}

function stateItemFingerprint(item) {
  if (
    item?.type === "message" &&
    item?.role === "user" &&
    typeof item.content === "string"
  ) {
    return sha256({
      ...item,
      content: stripCurrentDateTimePromptBlock(item.content),
    });
  }
  return sha256(item);
}

function responseId() {
  return `ath_resp_${crypto.randomUUID().replace(/-/g, "")}`;
}

function conversationId() {
  return `ath_conv_${crypto.randomUUID().replace(/-/g, "")}`;
}

function itemId() {
  return `ath_item_${crypto.randomUUID().replace(/-/g, "")}`;
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content ?? "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return part;
    if (part.type === "text")
      return { type: "input_text", text: part.text || "" };
    return part;
  });
}

function normalizeInput(input = []) {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: input }];
  }
  if (!Array.isArray(input)) {
    const error = new Error("response_input_invalid");
    error.code = "response_input_invalid";
    error.httpStatus = 400;
    throw error;
  }
  return input.map((entry) => {
    if (!entry || typeof entry !== "object") {
      const error = new Error("response_input_item_invalid");
      error.code = "response_input_item_invalid";
      error.httpStatus = 400;
      throw error;
    }
    if (entry.type && entry.type !== "message") return { ...entry };
    const role = String(entry.role || "user");
    if (!["system", "developer", "user", "assistant", "tool"].includes(role)) {
      const error = new Error("response_input_role_invalid");
      error.code = "response_input_role_invalid";
      error.httpStatus = 400;
      throw error;
    }
    return {
      type: "message",
      role,
      content: normalizeContent(entry.content),
      ...(entry.name ? { name: String(entry.name) } : {}),
      ...(entry.tool_call_id
        ? { tool_call_id: String(entry.tool_call_id) }
        : {}),
    };
  });
}

function commonPrefixLength(left = [], right = []) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  for (; index < limit; index += 1) {
    if (
      stateItemFingerprint(left[index]) !== stateItemFingerprint(right[index])
    )
      break;
  }
  return index;
}

function normalizeUsage(usage = {}) {
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(
    usage.output_tokens ?? usage.completion_tokens ?? 0
  );
  const cachedTokens = Number(
    usage?.input_tokens_details?.cached_tokens ??
      usage?.prompt_tokens_details?.cached_tokens ??
      usage?.prompt_cache_hit_tokens ??
      0
  );
  const reasoningTokens = Number(
    usage?.output_tokens_details?.reasoning_tokens ??
      usage?.completion_tokens_details?.reasoning_tokens ??
      usage?.reasoning_tokens ??
      0
  );
  const cacheMissTokens = Number(
    usage?.input_tokens_details?.cache_miss_tokens ??
      usage?.prompt_cache_miss_tokens ??
      Math.max(0, inputTokens - cachedTokens)
  );
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: cachedTokens,
      cache_miss_tokens: cacheMissTokens,
    },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: Number(usage.total_tokens ?? inputTokens + outputTokens),
  };
}

function baseResponse({
  id,
  conversation = null,
  previousResponseId = null,
  status = "queued",
  background = false,
  model = FLASH_MODEL,
  chatRunId = null,
  agentRunId = null,
} = {}) {
  return {
    id,
    object: RESPONSE_OBJECT,
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: Boolean(background),
    conversation: conversation ? { id: conversation } : null,
    previous_response_id: previousResponseId,
    model,
    output: [],
    output_text: "",
    usage: normalizeUsage(),
    athena: {
      runtimeOwner: "responses-runtime",
      requestedProtocol: "responses",
      effectiveProtocol: null,
      chatRunId,
      agentRunId,
      resultSha256: "",
    },
  };
}

function validateCreateRequest(body = {}) {
  const provider = String(body.provider || "deepseek").trim();
  const model = String(body.model || "").trim();
  if (provider !== "deepseek" || model !== FLASH_MODEL) {
    const error = new Error("responses_model_not_supported");
    error.code = "responses_model_not_supported";
    error.httpStatus = 400;
    throw error;
  }
  if (body.conversation && body.previous_response_id) {
    const error = new Error("response_state_conflict");
    error.code = "response_state_conflict";
    error.httpStatus = 409;
    throw error;
  }
  if (body.store === false && body.previous_response_id) {
    const error = new Error("previous_response_mismatch");
    error.code = "previous_response_mismatch";
    error.httpStatus = 409;
    throw error;
  }
  return {
    provider,
    model,
    input: normalizeInput(body.input || []),
    instructions:
      body.instructions === null || body.instructions === undefined
        ? null
        : String(body.instructions),
    tools: normalizeHostedTools(Array.isArray(body.tools) ? body.tools : []),
    toolChoice: body.tool_choice || null,
    reasoning:
      body.reasoning && typeof body.reasoning === "object"
        ? body.reasoning
        : {},
    temperature: body.temperature,
    maxOutputTokens: body.max_output_tokens || null,
    store: body.store !== false,
    background: body.background === true,
    conversation: body.conversation?.id || body.conversation || null,
    previousResponseId: body.previous_response_id || null,
    athena: body.athena && typeof body.athena === "object" ? body.athena : {},
  };
}

module.exports = {
  FLASH_MODEL,
  RESPONSE_STATUSES,
  STREAM_EVENT_TYPES,
  TERMINAL_STATUSES,
  baseResponse,
  canonicalJson,
  commonPrefixLength,
  conversationId,
  itemId,
  normalizeInput,
  normalizeUsage,
  responseId,
  sha256,
  stateItemFingerprint,
  validateCreateRequest,
};
