const crypto = require("crypto");
const {
  requestInternalService,
  requestInternalStream,
} = require("../microModules");

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
  let buffered = "";
  for await (const raw of response) {
    buffered += raw.toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        const parsed = JSON.parse(line);
        if (parsed.chunk) yield parsed.chunk;
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
    if (parsed.chunk) yield parsed.chunk;
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
  const remote = Object.create(delegate);
  remote.className = delegate.className;
  remote.model = delegate.model || model;
  remote.modelGateway = true;
  remote.getChatCompletion = async (messages, options = {}) => {
    const response = await requestInternalService({
      callerRole,
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
  };
  remote.streamGetChatCompletion = async (messages, options = {}) => {
    const response = await requestInternalStream({
      callerRole,
      url: `${baseUrl}/internal/v1/models/stream`,
      body: requestBody(provider, model, messages, options),
      idempotencyKey: crypto.randomUUID(),
      env,
      timeoutMs: Number(env.ATHENA_MODEL_GATEWAY_TIMEOUT_MS || 300_000),
    });
    const stream = ndjsonChunks(response);
    stream.endMeasurement = () => {};
    return stream;
  };
  return remote;
}

module.exports = {
  gatewayEnabled,
  ndjsonChunks,
  wrapWithModelGateway,
};
