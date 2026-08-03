const { normalizeUsage } = require("../responsesRuntime/contract");

const SUPPORTED_RESPONSE_KEYS = new Set([
  "provider",
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "reasoning",
  "temperature",
  "max_output_tokens",
  "stream",
]);

function validateProviderRequest(body = {}) {
  const unknown = Object.keys(body).filter(
    (key) => !SUPPORTED_RESPONSE_KEYS.has(key)
  );
  if (unknown.length) {
    const error = new Error("provider_protocol_incompatible");
    error.code = "provider_protocol_incompatible";
    error.httpStatus = 400;
    error.details = { unsupported: unknown };
    throw error;
  }
  if (body.provider !== "deepseek" || body.model !== "deepseek-v4-flash") {
    const error = new Error("provider_responses_model_not_supported");
    error.code = "provider_responses_model_not_supported";
    error.httpStatus = 400;
    throw error;
  }
  if (!Array.isArray(body.input) || body.input.length === 0) {
    const error = new Error("provider_responses_input_required");
    error.code = "provider_responses_input_required";
    error.httpStatus = 400;
    throw error;
  }
  return body;
}

function isRecoverableResponsesFailure(error) {
  const status = Number(error?.status || error?.httpStatus || 0);
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  if ([401, 403, 400, 422].includes(status)) return false;
  if (status >= 500 || [404, 405, 501].includes(status)) return true;
  return (
    [
      "etimedout",
      "econnreset",
      "econnrefused",
      "enotfound",
      "und_err_connect_timeout",
    ].includes(code) ||
    /timeout|temporarily unavailable|responses endpoint/.test(message)
  );
}

function toChatMessages(input = [], instructions = null) {
  const messages = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  for (const item of input) {
    if (item?.type && item.type !== "message") {
      if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content:
            typeof item.output === "string"
              ? item.output
              : JSON.stringify(item.output ?? null),
        });
      }
      continue;
    }
    messages.push({
      role: item.role || "user",
      content: item.content ?? "",
      ...(item.name ? { name: item.name } : {}),
      ...(item.tool_call_id ? { tool_call_id: item.tool_call_id } : {}),
    });
  }
  return messages;
}

function toChatTools(tools = []) {
  return tools
    .filter((tool) => tool?.type === "function" && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || { type: "object", properties: {} },
      },
    }));
}

function outputText(response = {}) {
  if (typeof response.output_text === "string") return response.output_text;
  return (response.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .filter((part) => part?.type === "output_text")
    .map((part) => part.text || "")
    .join("");
}

function normalizeResponse(
  response = {},
  protocol = "responses",
  reason = null
) {
  return {
    output: Array.isArray(response.output) ? response.output : [],
    output_text: outputText(response),
    usage: normalizeUsage(response.usage || {}),
    status: response.status || "completed",
    requestedProtocol: "responses",
    effectiveProtocol: protocol,
    degradedReason: reason,
  };
}

function chatCompletionToResponse(result = {}, usage = {}) {
  const text = result?.textResponse ?? result?.content ?? "";
  const toolCalls = result?.toolCalls || [];
  const output = [];
  if (text) {
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    });
  }
  for (const call of toolCalls) {
    output.push({
      type: "function_call",
      call_id: call.id,
      name: call.function?.name || "",
      arguments: call.function?.arguments || "{}",
      status: "completed",
    });
  }
  return normalizeResponse(
    { output, output_text: text, usage: usage || result?.metrics || {} },
    "chat_completions",
    "provider_responses_unavailable"
  );
}

async function deepSeekResponsesComplete(input, { providerFactory }) {
  validateProviderRequest(input);
  const provider = providerFactory(input);
  const request = {
    model: input.model,
    input: input.input,
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.tool_choice ? { tool_choice: input.tool_choice } : {}),
    ...(Object.keys(input.reasoning || {}).length
      ? { reasoning: input.reasoning }
      : {}),
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    ...(input.max_output_tokens
      ? { max_output_tokens: input.max_output_tokens }
      : {}),
  };
  try {
    const response = await provider.openai.responses.create(request);
    return normalizeResponse(response);
  } catch (error) {
    if (!isRecoverableResponsesFailure(error)) throw error;
    const messages = toChatMessages(input.input, input.instructions);
    const tools = toChatTools(input.tools);
    if (!tools.length) {
      const result = await provider.getChatCompletion(messages, {
        temperature: input.temperature,
        maxTokens: input.max_output_tokens,
        thinking: Object.keys(input.reasoning || {}).length
          ? "enabled"
          : "disabled",
        reasoningEffort: input.reasoning?.effort,
      });
      return chatCompletionToResponse(result, result?.metrics);
    }
    const stream = await provider.streamGetChatCompletion(messages, {
      temperature: input.temperature,
      maxTokens: input.max_output_tokens,
      tools,
      toolChoice: input.tool_choice,
      thinking: Object.keys(input.reasoning || {}).length
        ? "enabled"
        : "disabled",
      reasoningEffort: input.reasoning?.effort,
    });
    let text = "";
    let usage = {};
    const toolCalls = new Map();
    for await (const chunk of stream) {
      if (chunk?.usage) usage = chunk.usage;
      const delta = chunk?.choices?.[0]?.delta || {};
      text += delta.content || "";
      for (const toolCall of delta.tool_calls || []) {
        const index = Number(toolCall.index || 0);
        const existing = toolCalls.get(index) || {
          id: toolCall.id || `fallback_call_${index}`,
          function: { name: "", arguments: "" },
        };
        if (toolCall.id) existing.id = toolCall.id;
        if (toolCall.function?.name)
          existing.function.name = toolCall.function.name;
        existing.function.arguments += toolCall.function?.arguments || "";
        toolCalls.set(index, existing);
      }
    }
    return chatCompletionToResponse(
      { textResponse: text, toolCalls: [...toolCalls.values()] },
      usage
    );
  }
}

async function* deepSeekResponsesStream(input, { providerFactory }) {
  validateProviderRequest(input);
  const provider = providerFactory(input);
  const request = {
    model: input.model,
    input: input.input,
    stream: true,
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.tool_choice ? { tool_choice: input.tool_choice } : {}),
    ...(Object.keys(input.reasoning || {}).length
      ? { reasoning: input.reasoning }
      : {}),
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    ...(input.max_output_tokens
      ? { max_output_tokens: input.max_output_tokens }
      : {}),
  };
  try {
    const stream = await provider.openai.responses.create(request);
    for await (const event of stream) yield event;
    return;
  } catch (error) {
    if (!isRecoverableResponsesFailure(error)) throw error;
  }

  const messages = toChatMessages(input.input, input.instructions);
  const stream = await provider.streamGetChatCompletion(messages, {
    temperature: input.temperature,
    maxTokens: input.max_output_tokens,
    tools: toChatTools(input.tools),
    toolChoice: input.tool_choice,
    thinking: Object.keys(input.reasoning || {}).length
      ? "enabled"
      : "disabled",
    reasoningEffort: input.reasoning?.effort,
  });
  let sequence = 0;
  let text = "";
  let usage = {};
  const pendingToolCalls = new Map();
  for await (const chunk of stream) {
    if (chunk?.usage) usage = chunk.usage;
    const delta = chunk?.choices?.[0]?.delta || {};
    if (delta.content) {
      text += delta.content;
      yield {
        type: "response.output_text.delta",
        sequence_number: sequence++,
        delta: delta.content,
        athena: {
          requestedProtocol: "responses",
          effectiveProtocol: "chat_completions",
          degradedReason: "provider_responses_unavailable",
        },
      };
    }
    for (const toolCall of delta.tool_calls || []) {
      const index = Number(toolCall.index || 0);
      const existing = pendingToolCalls.get(index) || {
        type: "function_call",
        id: toolCall.id || `fallback_call_${index}`,
        call_id: toolCall.id || `fallback_call_${index}`,
        name: "",
        arguments: "",
        status: "in_progress",
      };
      if (!pendingToolCalls.has(index)) {
        pendingToolCalls.set(index, existing);
        yield {
          type: "response.output_item.added",
          sequence_number: sequence++,
          output_index: index,
          item: { ...existing },
          athena: {
            requestedProtocol: "responses",
            effectiveProtocol: "chat_completions",
            degradedReason: "provider_responses_unavailable",
          },
        };
      }
      if (toolCall.id) {
        existing.id = toolCall.id;
        existing.call_id = toolCall.id;
      }
      if (toolCall.function?.name) existing.name = toolCall.function.name;
      existing.arguments += toolCall.function?.arguments || "";
      yield {
        type: "response.function_call_arguments.delta",
        sequence_number: sequence++,
        item_id: existing.id,
        call_id: existing.call_id,
        output_index: index,
        name: toolCall.function?.name || "",
        delta: toolCall.function?.arguments || "",
        athena: {
          requestedProtocol: "responses",
          effectiveProtocol: "chat_completions",
          degradedReason: "provider_responses_unavailable",
        },
      };
    }
  }
  const output = [];
  if (text) {
    const item = {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    };
    output.push(item);
    yield {
      type: "response.output_item.done",
      sequence_number: sequence++,
      output_index: 0,
      item,
    };
  }
  for (const [index, call] of pendingToolCalls) {
    const item = { ...call, status: "completed" };
    output.push(item);
    yield {
      type: "response.output_item.done",
      sequence_number: sequence++,
      output_index: index,
      item,
    };
  }
  yield {
    type: "response.completed",
    sequence_number: sequence,
    response: normalizeResponse(
      { output, output_text: text, usage },
      "chat_completions",
      "provider_responses_unavailable"
    ),
  };
}

module.exports = {
  chatCompletionToResponse,
  deepSeekResponsesComplete,
  deepSeekResponsesStream,
  isRecoverableResponsesFailure,
  normalizeResponse,
  toChatMessages,
  toChatTools,
  validateProviderRequest,
};
