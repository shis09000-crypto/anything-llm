const crypto = require("crypto");
const {
  requestInternalService,
  requestInternalStream,
} = require("../microModules");
const { readAicpNdjson } = require("../modulePlatform/aicp");

function baseUrl(env = process.env) {
  const value = String(env.ATHENA_MODEL_GATEWAY_URL || "").replace(/\/+$/, "");
  if (!value) {
    const error = new Error("model_gateway_url_missing");
    error.code = "model_gateway_url_missing";
    throw error;
  }
  return value;
}

function providerBody(request, stream) {
  return {
    provider: request.provider,
    model: request.model,
    input: request.input,
    instructions: request.instructions,
    tools: request.tools,
    tool_choice: request.toolChoice,
    reasoning: request.reasoning,
    temperature: request.temperature,
    max_output_tokens: request.maxOutputTokens,
    stream,
  };
}

async function complete(request, env = process.env) {
  const body = providerBody(request, false);
  const response = await requestInternalService({
    callerRole: "responses-runtime",
    targetModule: "model-gateway",
    capability: "model.responses.complete",
    contractVersion: "1.0",
    url: `${baseUrl(env)}/internal/v1/models/responses/complete`,
    body,
    idempotencyKey: crypto
      .createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex"),
    env,
    timeoutMs: Number(env.ATHENA_MODEL_GATEWAY_TIMEOUT_MS || 300_000),
  });
  return response.result;
}

async function stream(request, env = process.env) {
  const body = providerBody(request, true);
  const response = await requestInternalStream({
    callerRole: "responses-runtime",
    targetModule: "model-gateway",
    capability: "model.responses.stream",
    contractVersion: "1.0",
    url: `${baseUrl(env)}/internal/v1/models/responses/stream`,
    body,
    idempotencyKey: crypto.randomUUID(),
    env,
    timeoutMs: Number(env.ATHENA_MODEL_GATEWAY_TIMEOUT_MS || 300_000),
  });
  return response;
}

async function* events(response) {
  for await (const { payload: parsed } of readAicpNdjson(response)) {
    if (!parsed) continue;
    if (parsed.event) yield parsed.event;
    if (parsed.error) {
      const error = new Error(parsed.error);
      error.code = parsed.error;
      throw error;
    }
  }
}

module.exports = { complete, events, providerBody, stream };
