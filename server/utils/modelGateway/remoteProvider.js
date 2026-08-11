const crypto = require("crypto");
const {
  requestInternalService,
  requestInternalStream,
} = require("../microModules");
const { createProviderAdapter } = require("../AiProviders/providerAdapter");
const { readAicpNdjson } = require("../modulePlatform/aicp");

function gatewayEnabled(env = process.env) {
  const role = String(env.ATHENA_RUNTIME_ROLE || "").toLowerCase();
  return (
    env.ATHENA_MODEL_GATEWAY_CUTOVER === "true" &&
    Boolean(String(env.ATHENA_MODEL_GATEWAY_URL || "").trim()) &&
    ["chat-runtime", "agent-runtime", "background-worker"].includes(role)
  );
}

function requestBody(provider, model, messages, options) {
  return {
    provider,
    model,
    messages,
    options,
  };
}

async function* ndjsonChunks(response) {
  for await (const { payload: parsed } of readAicpNdjson(response)) {
    if (!parsed) continue;
    if (parsed.chunk) yield parsed.chunk;
    if (parsed.error) {
      const error = new Error(parsed.error);
      error.code = parsed.error;
      throw error;
    }
  }
}

function wrapWithModelGateway(
  delegate,
  { provider, model, env = process.env } = {}
) {
  const {
    wrapWithResponsesRuntime,
  } = require("../responsesRuntime/chatAdapter");
  const responsesDelegate = wrapWithResponsesRuntime(delegate, {
    provider,
    model,
    env,
  });
  if (responsesDelegate !== delegate) return responsesDelegate;
  if (!gatewayEnabled(env)) return delegate;
  const baseUrl = String(env.ATHENA_MODEL_GATEWAY_URL).replace(/\/+$/, "");
  const callerRole = String(env.ATHENA_RUNTIME_ROLE);
  return createProviderAdapter(delegate, {
    className: delegate.className,
    model: delegate.model || model,
    modelGateway: true,
    getChatCompletion: async (messages, options = {}) => {
      const response = await requestInternalService({
        callerRole,
        targetModule: "model-gateway",
        capability: "model.stream",
        contractVersion: "1.0",
        url: `${baseUrl}/internal/v1/models/complete`,
        body: requestBody(provider, model, messages, options),
        idempotencyKey: crypto
          .createHash("sha256")
          .update(JSON.stringify({ provider, model, messages, options }))
          .digest("hex"),
        env,
        timeoutMs: Number(env.ATHENA_MODEL_GATEWAY_TIMEOUT_MS || 120_000),
      });
      return response.result;
    },
    streamGetChatCompletion: async (messages, options = {}) => {
      const response = await requestInternalStream({
        callerRole,
        targetModule: "model-gateway",
        capability: "model.stream",
        contractVersion: "1.0",
        url: `${baseUrl}/internal/v1/models/stream`,
        body: requestBody(provider, model, messages, options),
        idempotencyKey: crypto.randomUUID(),
        env,
        timeoutMs: Number(env.ATHENA_MODEL_GATEWAY_TIMEOUT_MS || 300_000),
      });
      const stream = ndjsonChunks(response);
      stream.endMeasurement = () => {};
      return stream;
    },
  });
}

module.exports = {
  gatewayEnabled,
  ndjsonChunks,
  wrapWithModelGateway,
};
