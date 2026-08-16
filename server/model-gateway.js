const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "model-gateway";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();
const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const { getLLMProvider } = require("./utils/helpers");
const {
  createAgentProvider,
} = require("./utils/agents/aibitat/providers/factory");
const { TASK_REGISTRY } = require("./utils/llmTasks/taskRegistry");
const {
  deepSeekResponsesComplete,
  deepSeekResponsesStream,
  validateProviderRequest,
} = require("./utils/modelGateway/deepSeekResponses");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  secureDatabaseStart,
} = require("./utils/microModules");
const { startFastLaneServer } = require("./utils/athena3dCenter/fastLane");
const {
  ThreeDContextCache,
} = require("./utils/modelGateway/threeDContextCache");

const role = "model-gateway";
const port = Number(process.env.MODEL_GATEWAY_PORT || 3018);
const ALLOWED_OPTIONS = new Set([
  "temperature",
  "responseFormat",
  "tools",
  "toolChoice",
  "thinking",
  "reasoningEffort",
  "maxTokens",
]);

function completionRequest(body = {}) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    const error = new Error("model_messages_required");
    error.httpStatus = 400;
    throw error;
  }
  const serialized = JSON.stringify(body.messages);
  if (Buffer.byteLength(serialized) > 1_500_000) {
    const error = new Error("model_messages_too_large");
    error.httpStatus = 413;
    throw error;
  }
  const options = Object.fromEntries(
    Object.entries(body.options || {}).filter(([key]) =>
      ALLOWED_OPTIONS.has(key)
    )
  );
  return {
    provider: String(body.provider || "").trim() || null,
    model: String(body.model || "").trim() || null,
    messages: body.messages,
    options,
  };
}

function agentCompletionRequest(body = {}) {
  const input = completionRequest({
    ...body,
    options: body.completionOptions || {},
  });
  const functions = Array.isArray(body.functions)
    ? body.functions.slice(0, 256).map((fn) => ({
        name: String(fn?.name || "").slice(0, 160),
        description: String(fn?.description || "").slice(0, 4_096),
        parameters: fn?.parameters || { type: "object", properties: {} },
      }))
    : [];
  if (functions.some((fn) => !fn.name)) {
    const error = new Error("model_agent_function_invalid");
    error.httpStatus = 400;
    throw error;
  }
  return {
    ...input,
    functions,
    completionOptions: input.options,
  };
}

function responsesCompletionRequest(body = {}, stream = false) {
  const input = validateProviderRequest({ ...body, stream });
  const serialized = JSON.stringify(input.input);
  if (
    Buffer.byteLength(serialized) >
    Number(process.env.ATHENA_MODEL_GATEWAY_MAX_REQUEST_BYTES || 8_388_608)
  ) {
    const error = new Error("model_responses_input_too_large");
    error.httpStatus = 413;
    throw error;
  }
  return input;
}

const state = {
  accepting: true,
  activeCompletions: 0,
  completedCompletions: 0,
  failedCompletions: 0,
};
let threeDContextFastLane = null;
const threeDContextCache = new ThreeDContextCache();

async function withCompletion(
  request,
  operation,
  providerFactory = (input) =>
    getLLMProvider({
      provider: input.provider,
      model: input.model,
    })
) {
  if (!state.accepting) {
    const error = new Error("model_gateway_draining");
    error.httpStatus = 503;
    throw error;
  }
  state.activeCompletions += 1;
  try {
    const provider = providerFactory(request);
    const result = await operation(provider);
    state.completedCompletions += 1;
    return result;
  } catch (error) {
    state.failedCompletions += 1;
    throw error;
  } finally {
    state.activeCompletions = Math.max(0, state.activeCompletions - 1);
  }
}

async function dispatchThreeDContext(operation, payload) {
  switch (operation) {
    case "context.install":
      return threeDContextCache.install(payload);
    case "context.complete": {
      const prepared = threeDContextCache.completionInput(payload);
      const input = responsesCompletionRequest(prepared.input, false);
      const result = await withCompletion(input, () =>
        deepSeekResponsesComplete(input, {
          providerFactory: (requestInput) =>
            getLLMProvider({
              provider: requestInput.provider,
              model: requestInput.model,
            }),
        })
      );
      threeDContextCache.recordCompletion(payload.context_ref, input, result);
      return { result, slot_hit: true };
    }
    case "context.finalize": {
      const prepared = threeDContextCache.finalizationInput(payload);
      const input = responsesCompletionRequest(prepared.input, false);
      const result = await withCompletion(input, () =>
        deepSeekResponsesComplete(input, {
          providerFactory: (requestInput) =>
            getLLMProvider({
              provider: requestInput.provider,
              model: requestInput.model,
            }),
        })
      );
      return {
        result,
        cache_mode: "exact_prefix",
        prefix_sha256: prepared.prefixSha256,
      };
    }
    case "context.commit": {
      const inactive = [
        "soft_closed",
        "suspended",
        "ended",
        "cancelled",
      ].includes(String(payload.status || ""));
      if (inactive && payload.retain_for_long_term !== true) {
        threeDContextCache.invalidate({
          session_id: payload.session_id,
          context_ref: payload.previous_context_ref,
        });
        return { committed: true, retained: false };
      }
      return {
        committed: true,
        retained: true,
        ...threeDContextCache.commit(payload),
      };
    }
    case "context.status":
      return threeDContextCache.status(payload);
    case "context.invalidate":
      return threeDContextCache.invalidate(payload);
    default: {
      const error = new Error("athena_3d_context_operation_unknown");
      error.code = "athena_3d_context_operation_unknown";
      error.httpStatus = 404;
      throw error;
    }
  }
}

const host = new MicroModuleServiceHost({
  manifestId: "model-gateway",
  role,
  port,
  jsonLimit: process.env.ATHENA_MODEL_GATEWAY_JSON_LIMIT || "10mb",
  readiness: () => ({
    ...state,
    threeDContext: threeDContextCache.status(),
    threeDContextFastLane: threeDContextFastLane
      ? { ready: true, port: threeDContextFastLane.port }
      : { ready: false },
  }),
  onStart: async () => {
    await secureDatabaseStart(role);
    if (process.env.ATHENA_3D_CONTEXT_FAST_LANE_ENABLED !== "false")
      threeDContextFastLane = await startFastLaneServer({
        role,
        port: Number(process.env.ATHENA_3D_CONTEXT_FAST_LANE_PORT || 3118),
        host: process.env.ATHENA_3D_CONTEXT_FAST_LANE_HOST || "127.0.0.1",
        jsonLimit: process.env.ATHENA_3D_CONTEXT_FAST_LANE_JSON_LIMIT || "48mb",
        handler: dispatchThreeDContext,
      });
  },
  onDrain: async () => {
    state.accepting = false;
    const deadline =
      Date.now() +
      Number(process.env.ATHENA_RUNTIME_DRAIN_TIMEOUT_MS || 120_000);
    while (state.activeCompletions > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    await threeDContextFastLane?.close?.();
    threeDContextFastLane = null;
  },
  onStop: async () => {
    await threeDContextFastLane?.close?.();
    threeDContextFastLane = null;
  },
  registerRoutes: (app) => {
    app.get(
      "/internal/v1/models/responses/capabilities",
      (_request, response) => {
        const models = ["deepseek-v4-flash", "deepseek-v4-pro"];
        const ready = models.every((model) => {
          const provider = getLLMProvider({ provider: "deepseek", model });
          return typeof provider?.openai?.responses?.create === "function";
        });
        response.json({
          success: true,
          ready,
          provider: "deepseek",
          models,
          protocols: ["responses"],
        });
      }
    );
    app.get("/internal/v1/models/health", (_request, response) => {
      const provider = getLLMProvider({});
      const ready =
        typeof provider?.getChatCompletion === "function" &&
        typeof provider?.streamGetChatCompletion === "function";
      response.json({
        success: true,
        ready,
        dependencies: {
          modelProvider: {
            ready,
            reasonCode: ready ? null : "model_provider_contract_invalid",
          },
        },
      });
    });
    app.get("/internal/v1/models/catalog", (_request, response) => {
      response.json({
        success: true,
        tasks: Object.entries(TASK_REGISTRY).map(([task, config]) => ({
          task,
          tier: config.tier || null,
          dynamic: config.dynamic || null,
        })),
      });
    });
    app.post("/internal/v1/models/complete", async (request, response) => {
      const input = completionRequest(request.body);
      const result = await withCompletion(input, (provider) =>
        provider.getChatCompletion(input.messages, input.options)
      );
      response.json({ success: true, result });
    });
    app.post("/internal/v1/models/stream", async (request, response) => {
      const input = completionRequest(request.body);
      response.status(200);
      response.setHeader("Content-Type", "application/x-ndjson");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();
      const writer = new AicpNdjsonWriter(response, {
        aicp: response.locals.aicp,
      });
      writer.open({ capability: "model.stream" });
      try {
        await withCompletion(input, async (provider) => {
          const stream = await provider.streamGetChatCompletion(
            input.messages,
            input.options
          );
          let usage = null;
          for await (const chunk of stream) {
            if (response.destroyed) break;
            if (chunk?.usage) usage = chunk.usage;
            writer.data({ chunk });
          }
          stream?.endMeasurement?.(usage || {});
        });
        if (!response.destroyed) writer.end("completed");
      } catch (error) {
        if (!response.destroyed)
          writer.end("failed", {
            error: String(error?.code || "model_stream_failed").slice(0, 160),
          }, { error: "model_stream_failed" });
      }
    });
    app.post(
      "/internal/v1/models/responses/complete",
      async (request, response) => {
        const input = responsesCompletionRequest(request.body, false);
        const result = await withCompletion(input, () =>
          deepSeekResponsesComplete(input, {
            providerFactory: (requestInput) =>
              getLLMProvider({
                provider: requestInput.provider,
                model: requestInput.model,
              }),
          })
        );
        response.json({ success: true, result });
      }
    );
    app.post(
      "/internal/v1/models/responses/stream",
      async (request, response) => {
        const input = responsesCompletionRequest(request.body, true);
        response.status(200);
        response.setHeader("Content-Type", "application/x-ndjson");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders?.();
        await withCompletion(input, async () => {
          const stream = deepSeekResponsesStream(input, {
            providerFactory: (requestInput) =>
              getLLMProvider({
                provider: requestInput.provider,
                model: requestInput.model,
              }),
          });
          for await (const event of stream) {
            if (response.destroyed) break;
            response.write(`${JSON.stringify({ event })}\n`);
          }
        });
        if (!response.destroyed)
          response.end(`${JSON.stringify({ end: true })}\n`);
      }
    );
    app.post(
      "/internal/v1/models/agent/complete",
      async (request, response) => {
        const input = agentCompletionRequest(request.body);
        const result = await withCompletion(
          input,
          async (provider) => {
            const completion = await provider.complete(
              input.messages,
              input.functions,
              input.completionOptions
            );
            return {
              completion,
              usage: provider.getUsage?.() || null,
            };
          },
          createAgentProvider
        );
        response.json({
          success: true,
          result: result.completion,
          usage: result.usage,
        });
      }
    );
    app.post("/internal/v1/models/agent/stream", async (request, response) => {
      const input = agentCompletionRequest(request.body);
      response.status(200);
      response.setHeader("Content-Type", "application/x-ndjson");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();
      const writer = new AicpNdjsonWriter(response, {
        aicp: response.locals.aicp,
      });
      writer.open({ capability: "model.agent.stream" });
      try {
        await withCompletion(
          input,
          async (provider) => {
            const result = provider.supportsAgentStreaming
              ? await provider.stream(
                  input.messages,
                  input.functions,
                  (type, data) => writer.data({ event: { type, data } })
                )
              : await provider.complete(input.messages, input.functions);
            if (!response.destroyed)
              writer.data({
                result,
                usage: provider.getUsage?.() || null,
              });
          },
          createAgentProvider
        );
        if (!response.destroyed) writer.end("completed");
      } catch (error) {
        if (!response.destroyed)
          writer.end("failed", {
            error: String(error?.code || "model_agent_stream_failed").slice(
              0,
              160
            ),
          }, { error: "model_agent_stream_failed" });
      }
    });
  },
});

installStandaloneShutdown(host, { name: "ModelGateway" });
host
  .start()
  .then((snapshot) =>
    console.log(`[ModelGateway] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[ModelGateway] failed to start", error);
    process.exitCode = 1;
  });
