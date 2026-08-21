const crypto = require("crypto");
const {
  requestInternalService,
  requestInternalStream,
} = require("../microModules");

function baseUrl(env = process.env) {
  const value = String(env.ATHENA_MODEL_GATEWAY_URL || "").replace(/\/+$/, "");
  if (!value) {
    const error = new Error("model_gateway_url_missing");
    error.code = "model_gateway_url_missing";
    throw error;
  }
  return value;
}

function providerInput(input = []) {
  return input.map((item) => {
    if (!Array.isArray(item?.content) && !Array.isArray(item?.output))
      return item;
    const sanitizeParts = (parts) =>
      parts.map((part) => {
        if (part?.type !== "input_image") return part;
        const { athena_asset_id: _assetId, ...providerPart } = part;
        return providerPart;
      });
    return {
      ...item,
      ...(Array.isArray(item.content)
        ? { content: sanitizeParts(item.content) }
        : {}),
      ...(Array.isArray(item.output)
        ? { output: sanitizeParts(item.output) }
        : {}),
    };
  });
}

function providerBody(request, stream) {
  return {
    provider: request.provider,
    model: request.model,
    input: providerInput(request.input),
    instructions: request.instructions,
    tools: request.tools,
    tool_choice: request.toolChoice,
    response_format: request.responseFormat,
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

module.exports = { complete, events, providerBody, providerInput, stream };
