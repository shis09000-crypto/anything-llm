const crypto = require("crypto");
const { safeJsonParse } = require("../http");
const {
  requestInternalService,
  requestInternalStream,
} = require("../microModules");
const {
  formatFunctionsToTools,
} = require("../agents/aibitat/providers/helpers/tooled");
const { enabled, responseEvents, responsesTools } = require("./chatAdapter");
const { prepareResponsesInput } = require("./multimodalInput");
const { invalidateBindings } = require("../imageAssets/adapter");
const { functionsVisibleToResponsesModel } = require("./toolExposure");
const {
  ReasoningStreamProjector,
  completedReasoningFromEvent,
  reasoningDeltaFromEvent,
} = require("./reasoningStream");

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
    chatRunId: invocation.clientTurnId || null,
    agentRunId: invocation.uuid || null,
    invocationId: invocation.uuid || null,
    clientTurnId: invocation.clientTurnId || null,
    taskPriority: invocation.taskPriority || "P0",
    taskIntent: invocation.taskIntent || "agent_run",
  };
}

function imageFileFailure(value) {
  const text = String(value || "").toLowerCase();
  return (
    /(?:file|image).*(?:expired|invalid|not[_\s-]?found|missing)/i.test(text) ||
    /(?:expired|invalid|not[_\s-]?found|missing).*(?:file|image)/i.test(text)
  );
}

function failedEventCode(event = {}) {
  return (
    event.response?.error?.code ||
    event.response?.error?.message ||
    event.error?.code ||
    event.error?.message ||
    ""
  );
}

async function waitForDurableToolCheckpoint({
  baseUrl,
  responseId,
  athena,
  env,
}) {
  const query = new URLSearchParams(
    Object.entries({
      workspaceId: athena.workspaceId,
      threadId: athena.threadId,
      userId: athena.userId,
      chatRunId: athena.chatRunId,
      agentRunId: athena.agentRunId,
    })
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)])
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await requestInternalService({
      callerRole: "agent-runtime",
      targetModule: "responses-runtime",
      capability: "responses.retrieve",
      contractVersion: "1.0",
      url: `${baseUrl}/internal/v1/responses/${responseId}?${query}`,
      method: "GET",
      env,
      timeoutMs: 5_000,
    });
    if (result?.response?.athena?.persistenceStatus !== "pending") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const error = new Error("response_tool_checkpoint_unavailable");
  error.code = "RESPONSE_TOOL_CHECKPOINT_UNAVAILABLE";
  throw error;
}

async function responsesInput(messages = [], options = {}) {
  return prepareResponsesInput(messages, options);
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
      const athena = metadata(this.handlerProps);
      const modelVisibleFunctions = functionsVisibleToResponsesModel(functions);
      const requiresWorkspaceSearch =
        this.handlerProps?.invocation?.workspace?.chatMode === "query" &&
        this.handlerProps?.workspaceSearchPerformed !== true &&
        modelVisibleFunctions.some((fn) => fn?.name === "workspace_search");
      let prepared = await responsesInput(messages, {
        model,
        env,
        workspaceId: athena.workspaceId,
      });
      let body = {
        provider,
        model: prepared.model,
        input: prepared.input,
        store: true,
        background: false,
        persistence_mode: "foreground_deferred",
        tools: responsesTools(formatFunctionsToTools(modelVisibleFunctions)),
        tool_choice: requiresWorkspaceSearch
          ? { type: "function", name: "workspace_search" }
          : modelVisibleFunctions.length
            ? "auto"
            : null,
        reasoning: {
          effort:
            options?.reasoningEffort ||
            this.handlerProps?.agentReasoningEffort ||
            "high",
        },
        ...(options?.maxTokens != null
          ? { max_output_tokens: options.maxTokens }
          : {}),
        athena: {
          ...athena,
          requestedModel: model,
          multimodal: prepared.sawImage,
        },
      };
      const openResponse = (requestBody) =>
        requestInternalStream({
          callerRole: "agent-runtime",
          targetModule: "responses-runtime",
          capability: "responses.stream",
          contractVersion: "1.0",
          url: `${baseUrl}/internal/v1/responses/stream`,
          body: requestBody,
          idempotencyKey: crypto
            .createHash("sha256")
            .update(JSON.stringify(requestBody))
            .digest("hex"),
          env,
          timeoutMs: Number(env.ATHENA_RESPONSES_RUNTIME_TIMEOUT_MS || 300_000),
        });
      let response = await openResponse(body);
      const call = { id: null, name: "", arguments: "" };
      let textResponse = "";
      let responseUuid = null;
      let usage = null;
      let sawReasoningDelta = false;
      let answerStarted = false;
      const reasoning = new ReasoningStreamProjector({
        emit: (content) =>
          eventHandler?.("reportStreamEvent", {
            ...content,
            uuid: `${responseUuid || athena.agentRunId || "responses-runtime"}:reasoning:${content.sequence || content.type}`,
          }),
      });
      for (let imageAttempt = 0; imageAttempt < 2; imageAttempt += 1) {
        let retryImage = false;
        try {
          for await (const event of responseEvents(response)) {
            if (event.response_id) responseUuid = event.response_id;
            if (event.type === "response.created")
              responseUuid = event.response?.id || responseUuid;
            const reasoningDelta = reasoningDeltaFromEvent(event);
            if (reasoningDelta) {
              sawReasoningDelta = true;
              reasoning.push(reasoningDelta);
            } else if (!sawReasoningDelta) {
              const completedReasoning = completedReasoningFromEvent(event);
              if (completedReasoning) reasoning.push(completedReasoning);
            }
            if (event.type === "response.output_text.delta") {
              if (!answerStarted && event.delta) {
                answerStarted = true;
                reasoning.finish("completed");
              }
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
            if (
              event.type === "response.completed" ||
              event.type === "response.incomplete"
            ) {
              reasoning.finish(
                event.type === "response.completed" ? "completed" : "incomplete"
              );
              usage = {
                ...(event.response?.usage || {}),
                model: event.response?.model || prepared.model,
                provider,
                requested_protocol:
                  event.response?.athena?.requestedProtocol || "responses",
                effective_protocol:
                  event.response?.athena?.effectiveProtocol || "responses",
                response_id: event.response?.id || null,
                execution_source: "responses_runtime",
              };
              responseUuid = event.response?.id || responseUuid;
            }
            if (event.type === "response.failed") {
              const code = failedEventCode(event);
              if (
                imageAttempt === 0 &&
                (prepared.bindingIds || []).length > 0 &&
                !answerStarted &&
                !call.name &&
                imageFileFailure(code)
              ) {
                retryImage = true;
                break;
              }
              reasoning.finish("failed");
            }
          }
        } catch (error) {
          if (
            imageAttempt === 0 &&
            (prepared.bindingIds || []).length > 0 &&
            !answerStarted &&
            !call.name &&
            imageFileFailure(error.code || error.message)
          ) {
            retryImage = true;
          } else {
            throw error;
          }
        }
        if (!retryImage) break;
        await invalidateBindings(
          prepared.bindingIds || [],
          "provider_image_file_invalid"
        );
        prepared = await responsesInput(messages, {
          model,
          env,
          workspaceId: athena.workspaceId,
          forceRefresh: true,
        });
        body = {
          ...body,
          model: prepared.model,
          input: prepared.input,
          athena: { ...body.athena, multimodal: prepared.sawImage },
        };
        response = await openResponse(body);
        responseUuid = null;
      }
      reasoning.finish("completed");
      if (call.name && responseUuid) {
        await waitForDurableToolCheckpoint({
          baseUrl,
          responseId: responseUuid,
          athena,
          env,
        });
      }
      this.lastUsage = usage || {};
      return {
        textResponse,
        functionCall: call.name
          ? {
              id: call.id || `call_${crypto.randomUUID()}`,
              name: call.name,
              arguments: safeJsonParse(call.arguments || "{}", {}),
              ...(reasoning.rawText()
                ? { reasoning_content: reasoning.rawText() }
                : {}),
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
  functionsVisibleToResponsesModel,
  metadata,
  responsesInput,
};
