const crypto = require("crypto");
const {
  requestInternalService,
  requestInternalStream,
} = require("../microModules");
const { gatewayEnabled } = require("./remoteProvider");
const { readAicpNdjson } = require("../modulePlatform/aicp");

function sanitizedFunctions(functions = []) {
  return functions.slice(0, 256).map((fn) => ({
    name: String(fn?.name || "").slice(0, 160),
    description: String(fn?.description || "").slice(0, 4_096),
    parameters: fn?.parameters || { type: "object", properties: {} },
  }));
}

function requestBody(provider, model, messages, functions, options = null) {
  return {
    provider,
    model,
    messages,
    functions: sanitizedFunctions(functions),
    completionOptions: options,
  };
}

function agentGatewayEnabled(env = process.env) {
  return gatewayEnabled(env) && env.ATHENA_RUNTIME_ROLE === "agent-runtime";
}

async function consumeAgentStream(response, eventHandler = null) {
  let result = null;
  let usage = null;
  const processValue = (parsed) => {
    if (!parsed) return;
    if (parsed.event)
      eventHandler?.(parsed.event.type, parsed.event.data || {});
    if (Object.prototype.hasOwnProperty.call(parsed, "result"))
      result = parsed.result;
    if (parsed.usage) usage = parsed.usage;
    if (parsed.error) {
      const error = new Error(parsed.error);
      error.code = parsed.error;
      throw error;
    }
  };
  for await (const { payload } of readAicpNdjson(response))
    processValue(payload);
  if (result === null) {
    const error = new Error("model_gateway_agent_result_missing");
    error.code = "model_gateway_agent_result_missing";
    throw error;
  }
  return { result, usage };
}

function createRemoteAgentProvider({
  provider,
  model,
  env = process.env,
} = {}) {
  if (!agentGatewayEnabled(env)) {
    const error = new Error("model_gateway_agent_not_enabled");
    error.code = "MODEL_GATEWAY_AGENT_NOT_ENABLED";
    throw error;
  }
  const baseUrl = String(env.ATHENA_MODEL_GATEWAY_URL).replace(/\/+$/, "");
  return {
    name: String(provider || "model-gateway"),
    model: model || null,
    modelGateway: true,
    supportsAgentStreaming: true,
    handlerProps: {},
    lastUsage: {},
    attachHandlerProps(handlerProps = {}) {
      this.handlerProps = handlerProps || {};
    },
    getUsage() {
      return this.lastUsage || {};
    },
    async complete(messages, functions = [], options = null) {
      const body = requestBody(provider, model, messages, functions, options);
      const response = await requestInternalService({
        callerRole: "agent-runtime",
        targetModule: "model-gateway",
        capability: "model.agent.complete",
        contractVersion: "1.0",
        url: `${baseUrl}/internal/v1/models/agent/complete`,
        body,
        idempotencyKey: crypto
          .createHash("sha256")
          .update(JSON.stringify(body))
          .digest("hex"),
        env,
        timeoutMs: Number(env.ATHENA_MODEL_GATEWAY_TIMEOUT_MS || 300_000),
      });
      if (response.usage) this.lastUsage = response.usage;
      return response.result;
    },
    async stream(messages, functions = [], eventHandler = null) {
      const response = await requestInternalStream({
        callerRole: "agent-runtime",
        targetModule: "model-gateway",
        capability: "model.agent.stream",
        contractVersion: "1.0",
        url: `${baseUrl}/internal/v1/models/agent/stream`,
        body: requestBody(provider, model, messages, functions),
        idempotencyKey: crypto.randomUUID(),
        env,
        timeoutMs: Number(env.ATHENA_MODEL_GATEWAY_TIMEOUT_MS || 300_000),
      });
      const completion = await consumeAgentStream(response, eventHandler);
      if (completion.usage) this.lastUsage = completion.usage;
      return completion.result;
    },
  };
}

function wrapAgentProviderWithModelGateway(
  delegate,
  { provider, model, env = process.env } = {}
) {
  if (!agentGatewayEnabled(env)) return delegate;
  return createRemoteAgentProvider({ provider, model, env });
}

module.exports = {
  agentGatewayEnabled,
  consumeAgentStream,
  createRemoteAgentProvider,
  sanitizedFunctions,
  wrapAgentProviderWithModelGateway,
};
