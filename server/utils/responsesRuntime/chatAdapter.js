const crypto = require("crypto");
const {
  requestInternalService,
  requestInternalStream,
} = require("../microModules");
const { FLASH_MODEL } = require("./contract");

function enabled({ provider, model, env = process.env } = {}) {
  const role = String(env.ATHENA_RUNTIME_ROLE || "");
  return (
    env.ATHENA_RESPONSES_RUNTIME_CUTOVER === "true" &&
    Boolean(String(env.ATHENA_RESPONSES_RUNTIME_URL || "").trim()) &&
    ["chat-runtime", "agent-runtime"].includes(role) &&
    String(provider) === "deepseek" &&
    String(model) === FLASH_MODEL
  );
}

function runtimeUrl(env = process.env) {
  return String(env.ATHENA_RESPONSES_RUNTIME_URL || "").replace(/\/+$/, "");
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

function requestBody(messages, options = {}, metadata = {}) {
  const thinkingEnabled = options.thinking === "enabled";
  return {
    provider: "deepseek",
    model: FLASH_MODEL,
    input: messages,
    store: true,
    background: false,
    tools: responsesTools(options.tools || []),
    tool_choice: options.toolChoice || null,
    reasoning: thinkingEnabled
      ? { effort: options.reasoningEffort || "high" }
      : {},
    ...(!thinkingEnabled && options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options.maxTokens != null
      ? { max_output_tokens: options.maxTokens }
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

function toChatStream(events) {
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
      if (
        event.type === "response.completed" ||
        event.type === "response.incomplete"
      ) {
        metrics = chatUsage(event.response?.usage || {});
        yield {
          choices: [
            {
              delta: {},
              finish_reason:
                event.type === "response.incomplete" ? "length" : "stop",
            },
          ],
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

function wrapWithResponsesRuntime(
  delegate,
  { provider, model, env = process.env } = {}
) {
  if (!enabled({ provider, model, env })) return delegate;
  const baseUrl = runtimeUrl(env);
  const callerRole = String(env.ATHENA_RUNTIME_ROLE);
  const remote = Object.create(delegate);
  remote.responsesRuntime = true;
  remote.getChatCompletion = async (messages, options = {}) => {
    const body = requestBody(messages, options, options.runtimeContext || {});
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
        requested_protocol: response.athena?.requestedProtocol,
        effective_protocol: response.athena?.effectiveProtocol,
        degraded_reason: response.athena?.degradedReason,
        response_id: response.id,
        conversation_id: response.conversation?.id || null,
      },
    };
  };
  remote.streamGetChatCompletion = async (messages, options = {}) => {
    const body = requestBody(messages, options, options.runtimeContext || {});
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
    return toChatStream(responseEvents(response));
  };
  return remote;
}

module.exports = {
  chatUsage,
  enabled,
  requestBody,
  responseEvents,
  responsesTools,
  toChatStream,
  wrapWithResponsesRuntime,
};
