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
  MicroModuleServiceHost,
  installStandaloneShutdown,
  secureDatabaseStart,
} = require("./utils/microModules");

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

const state = {
  accepting: true,
  activeCompletions: 0,
  completedCompletions: 0,
  failedCompletions: 0,
};

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

const host = new MicroModuleServiceHost({
  manifestId: "model-gateway",
  role,
  port,
  jsonLimit: "2mb",
  readiness: () => ({ ...state }),
  onStart: () => secureDatabaseStart(role),
  onDrain: async () => {
    state.accepting = false;
    const deadline =
      Date.now() +
      Number(process.env.ATHENA_RUNTIME_DRAIN_TIMEOUT_MS || 120_000);
    while (state.activeCompletions > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
  },
  registerRoutes: (app) => {
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
      await withCompletion(input, async (provider) => {
        const stream = await provider.streamGetChatCompletion(
          input.messages,
          input.options
        );
        let usage = null;
        for await (const chunk of stream) {
          if (response.destroyed) break;
          if (chunk?.usage) usage = chunk.usage;
          response.write(`${JSON.stringify({ chunk })}\n`);
        }
        stream?.endMeasurement?.(usage || {});
      });
      if (!response.destroyed)
        response.end(`${JSON.stringify({ end: true })}\n`);
    });
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
      await withCompletion(
        input,
        async (provider) => {
          const result = provider.supportsAgentStreaming
            ? await provider.stream(
                input.messages,
                input.functions,
                (type, data) => {
                  if (!response.destroyed)
                    response.write(
                      `${JSON.stringify({ event: { type, data } })}\n`
                    );
                }
              )
            : await provider.complete(input.messages, input.functions);
          if (!response.destroyed) {
            response.write(
              `${JSON.stringify({
                result,
                usage: provider.getUsage?.() || null,
              })}\n`
            );
          }
        },
        createAgentProvider
      );
      if (!response.destroyed)
        response.end(`${JSON.stringify({ end: true })}\n`);
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
