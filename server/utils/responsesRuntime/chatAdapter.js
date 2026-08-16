const crypto = require("crypto");
const {
  requestInternalService,
  requestInternalStream,
} = require("../microModules");
const { FLASH_MODEL } = require("./contract");

function enabled({ provider, model, env = process.env } = {}) {
  const role = String(env.ATHENA_RUNTIME_ROLE || "");
  return (
    ["chat-runtime", "agent-runtime"].includes(role) &&
    String(provider) === "deepseek" &&
    Boolean(String(model || "").trim())
  );
}

function runtimeUrl(env = process.env) {
  const value = String(env.ATHENA_RESPONSES_RUNTIME_URL || "").replace(
    /\/+$/,
    ""
  );
  if (!value) {
    const error = new Error("responses_runtime_url_missing");
    error.code = "responses_runtime_url_missing";
    throw error;
  }
  return value;
}

function responsesTools(tools = []) {
  return tools.map((tool) => {
    if (tool?.type !== "function" || !tool.function) return tool;
    return {
      type: "function",
      name: tool.function.name,
      description: tool.function.description || "",
      parameters: tool.function.parameters || {
        type: "object",
        properties: {},
      },
      strict: tool.function.strict === true,
    };
  });
}

function requestBody(
  messages,
  options = {},
  metadata = {},
  { provider = "deepseek", model = FLASH_MODEL } = {}
) {
  const thinkingEnabled = options.thinking === "enabled";
  return {
    provider,
    model,
    input: messages,
    store: options.store !== false,
    background: false,
    tools: responsesTools(options.tools || []),
    tool_choice: options.toolChoice || (options.tools?.length ? "auto" : null),
    reasoning: thinkingEnabled
      ? { effort: options.reasoningEffort || "high" }
      : {},
    ...(!thinkingEnabled && options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options.maxTokens != null
      ? { max_output_tokens: options.maxTokens }
      : {}),
    ...(options.responseFormat
      ? { response_format: options.responseFormat }
      : {}),
    athena: metadata,
  };
}

async function* responseEvents(response) {
  let buffered = "";
  for await (const raw of response) {
    buffered += raw.toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        const parsed = JSON.parse(line);
        if (parsed.event) yield parsed.event;
        if (parsed.error) {
          const error = new Error(parsed.error);
          error.code = parsed.error;
          throw error;
        }
      }
      newline = buffered.indexOf("\n");
    }
  }
  if (buffered.trim()) {
    const parsed = JSON.parse(buffered);
    if (parsed.event) yield parsed.event;
  }
}

function chatUsage(usage = {}) {
  return {
    prompt_tokens: Number(usage.input_tokens || 0),
    completion_tokens: Number(usage.output_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
    prompt_tokens_details: {
      cached_tokens: Number(usage?.input_tokens_details?.cached_tokens || 0),
      cache_miss_tokens: Number(
        usage?.input_tokens_details?.cache_miss_tokens || 0
      ),
    },
    completion_tokens_details: {
      reasoning_tokens: Number(
        usage?.output_tokens_details?.reasoning_tokens || 0
      ),
    },
  };
}

function toChatStream(
  events,
  { provider = "deepseek", model = FLASH_MODEL } = {}
) {
  const toolIndexes = new Map();
  let nextToolIndex = 0;
  let metrics = {};
  const stream = (async function* () {
    for await (const event of events) {
      if (event.type === "response.output_text.delta") {
        yield { choices: [{ delta: { content: event.delta || "" } }] };
        continue;
      }
      if (
        event.type === "response.output_item.added" &&
        event.item?.type === "function_call"
      ) {
        const key =
          event.item.id || event.item.call_id || String(nextToolIndex);
        const index = nextToolIndex++;
        toolIndexes.set(key, index);
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: event.item.call_id || event.item.id,
                    type: "function",
                    function: { name: event.item.name || "", arguments: "" },
                  },
                ],
              },
            },
          ],
        };
        continue;
      }
      if (event.type === "response.function_call_arguments.delta") {
        const key = event.item_id || event.call_id || "0";
        const index = toolIndexes.has(key) ? toolIndexes.get(key) : 0;
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: event.call_id || event.item_id || null,
                    type: "function",
                    function: {
                      name: event.name || "",
                      arguments: event.delta || "",
                    },
                  },
                ],
              },
            },
          ],
        };
        continue;
      }
      if (event.type === "response.completed") {
        metrics = {
          ...chatUsage(event.response?.usage || {}),
          model: event.response?.model || model,
          provider,
          requested_protocol:
            event.response?.athena?.requestedProtocol || "responses",
          effective_protocol:
            event.response?.athena?.effectiveProtocol || "responses",
          response_id: event.response?.id || null,
          execution_source: "responses_runtime",
        };
        yield {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: metrics,
        };
      }
    }
  })();
  stream.endMeasurement = (usage = {}) => {
    stream.metrics = { ...metrics, ...usage };
  };
  return stream;
}

/**
 * Overlay remote transport methods without changing the receiver used by the
 * provider's own methods. Some providers (including DeepSeekLLM) use private
 * class methods, which reject an Object.create(delegate) wrapper because that
 * wrapper does not carry the class's private brand.
 */
function createBoundDelegateProxy(delegate, overrides = {}) {
  const boundMethods = new Map();
  return new Proxy(delegate, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property))
        return overrides[property];
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!boundMethods.has(property))
        boundMethods.set(property, value.bind(target));
      return boundMethods.get(property);
    },
    set(target, property, value) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        overrides[property] = value;
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
  });
}

function createResponsesRuntimeConnector(
  delegate,
  {
    provider,
    model,
    env = process.env,
    callerRole = String(env.ATHENA_RUNTIME_ROLE || "api"),
  } = {}
) {
  const baseUrl = runtimeUrl(env);
  const overrides = { responsesRuntime: true };
  overrides.getChatCompletion = async (messages, options = {}) => {
    const body = requestBody(messages, options, options.runtimeContext || {}, {
      provider,
      model,
    });
    const result = await requestInternalService({
      callerRole,
      targetModule: "responses-runtime",
      capability: "responses.create",
      contractVersion: "1.0",
      url: `${baseUrl}/internal/v1/responses`,
      body,
      idempotencyKey: crypto
        .createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex"),
      env,
      timeoutMs: Number(env.ATHENA_RESPONSES_RUNTIME_TIMEOUT_MS || 300_000),
    });
    const response = result.response;
    return {
      textResponse: response.output_text || "",
      metrics: {
        ...chatUsage(response.usage),
        model: response.model || model,
        provider,
        requested_protocol: response.athena?.requestedProtocol,
        effective_protocol: response.athena?.effectiveProtocol,
        degraded_reason: response.athena?.degradedReason,
        response_id: response.id,
        conversation_id: response.conversation?.id || null,
        execution_source: "responses_runtime",
      },
    };
  };
  overrides.streamGetChatCompletion = async (messages, options = {}) => {
    const body = requestBody(messages, options, options.runtimeContext || {}, {
      provider,
      model,
    });
    const response = await requestInternalStream({
      callerRole,
      targetModule: "responses-runtime",
      capability: "responses.stream",
      contractVersion: "1.0",
      url: `${baseUrl}/internal/v1/responses/stream`,
      body,
      idempotencyKey: crypto
        .createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex"),
      env,
      timeoutMs: Number(env.ATHENA_RESPONSES_RUNTIME_TIMEOUT_MS || 300_000),
    });
    return toChatStream(responseEvents(response), { provider, model });
  };
  return createBoundDelegateProxy(delegate, overrides);
}

function wrapWithResponsesRuntime(
  delegate,
  { provider, model, env = process.env } = {}
) {
  if (!enabled({ provider, model, env })) return delegate;
  return createResponsesRuntimeConnector(delegate, { provider, model, env });
}

module.exports = {
  chatUsage,
  createBoundDelegateProxy,
  createResponsesRuntimeConnector,
  enabled,
  requestBody,
  responseEvents,
  responsesTools,
  toChatStream,
  wrapWithResponsesRuntime,
};
