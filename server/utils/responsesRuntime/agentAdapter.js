const crypto = require("crypto");
const { safeJsonParse } = require("../http");
const { requestInternalStream } = require("../microModules");
const {
  formatFunctionsToTools,
  formatMessagesForTools,
} = require("../agents/aibitat/providers/helpers/tooled");
const { enabled, responseEvents, responsesTools } = require("./chatAdapter");

function agentEnabled({ provider, model, env = process.env } = {}) {
  return (
    env.ATHENA_RUNTIME_ROLE === "agent-runtime" &&
    enabled({ provider, model, env })
  );
}

function metadata(handlerProps = {}) {
  const invocation = handlerProps.invocation || {};
  return {
    workspaceId: invocation.workspace_id ?? invocation.workspace?.id ?? null,
    threadId: invocation.thread_id ?? null,
    userId: invocation.user_id ?? null,
    agentRunId: invocation.uuid || null,
    invocationId: invocation.uuid || null,
    clientTurnId: invocation.clientTurnId || null,
    taskPriority: invocation.taskPriority || "P0",
    taskIntent: invocation.taskIntent || "agent_run",
  };
}

function responsesInput(messages = []) {
  const formatted = formatMessagesForTools(messages, {
    injectReasoningContent: true,
  });
  const input = [];
  for (const { reasoning_content: _reasoning, ...message } of formatted) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content ?? "",
      });
      continue;
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      if (message.content)
        input.push({
          type: "message",
          role: "assistant",
          content: message.content,
        });
      for (const toolCall of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function?.name || "",
          arguments: toolCall.function?.arguments || "{}",
        });
      }
      continue;
    }
    input.push(message);
  }
  return input;
}

function createResponsesAgentProvider({
  provider,
  model,
  env = process.env,
} = {}) {
  if (!agentEnabled({ provider, model, env })) {
    const error = new Error("responses_runtime_agent_not_enabled");
    error.code = "RESPONSES_RUNTIME_AGENT_NOT_ENABLED";
    throw error;
  }
  const baseUrl = String(env.ATHENA_RESPONSES_RUNTIME_URL).replace(/\/+$/, "");
  return {
    name: provider,
    model,
    responsesRuntime: true,
    supportsAgentStreaming: true,
    cacheStableHistory: true,
    verbose: true,
    handlerProps: {},
    lastUsage: {},
    attachHandlerProps(handlerProps = {}) {
      this.handlerProps = handlerProps || {};
    },
    getUsage() {
      return this.lastUsage || {};
    },
    async complete(messages, functions = [], options = null) {
      return this.stream(messages, functions, null, options);
    },
    async stream(
      messages,
      functions = [],
      eventHandler = null,
      options = null
    ) {
      const body = {
        provider,
        model,
        input: responsesInput(messages),
        store: true,
        background: false,
        tools: responsesTools(formatFunctionsToTools(functions)),
        tool_choice: functions.length ? "auto" : null,
        reasoning: { effort: options?.reasoningEffort || "high" },
        ...(options?.maxTokens != null
          ? { max_output_tokens: options.maxTokens }
          : {}),
        athena: metadata(this.handlerProps),
      };
      const response = await requestInternalStream({
        callerRole: "agent-runtime",
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
      const call = { id: null, name: "", arguments: "" };
      let textResponse = "";
      let responseUuid = null;
      let usage = null;
      for await (const event of responseEvents(response)) {
        if (event.response_id) responseUuid = event.response_id;
        if (event.type === "response.created")
          responseUuid = event.response?.id || responseUuid;
        if (event.type === "response.output_text.delta") {
          textResponse += event.delta || "";
          eventHandler?.("reportStreamEvent", {
            type: "textResponseChunk",
            uuid: responseUuid || "responses-runtime",
            content: event.delta || "",
          });
        }
        if (
          event.type === "response.output_item.added" &&
          event.item?.type === "function_call"
        ) {
          call.id = event.item.call_id || event.item.id || call.id;
          call.name = event.item.name || call.name;
        }
        if (event.type === "response.function_call_arguments.delta") {
          call.id = event.call_id || event.item_id || call.id;
          if (event.name && !call.name) call.name = event.name;
          call.arguments += event.delta || "";
          eventHandler?.("reportStreamEvent", {
            type: "toolCallInvocation",
            uuid: `${responseUuid || "responses-runtime"}:tool_call_invocation`,
            content: `Assembling Tool Call: ${call.name}(${call.arguments})`,
          });
        }
        if (
          event.type === "response.output_item.done" &&
          event.item?.type === "function_call"
        ) {
          call.id = event.item.call_id || event.item.id || call.id;
          call.name = event.item.name || call.name;
          call.arguments = event.item.arguments || call.arguments;
        }
        if (event.type === "response.completed") {
          usage = event.response?.usage || null;
          responseUuid = event.response?.id || responseUuid;
        }
      }
      this.lastUsage = usage || {};
      return {
        textResponse,
        functionCall: call.name
          ? {
              id: call.id || `call_${crypto.randomUUID()}`,
              name: call.name,
              arguments: safeJsonParse(call.arguments || "{}", {}),
            }
          : null,
        uuid: responseUuid || crypto.randomUUID(),
        usage,
      };
    },
  };
}

module.exports = {
  agentEnabled,
  createResponsesAgentProvider,
  metadata,
  responsesInput,
};
