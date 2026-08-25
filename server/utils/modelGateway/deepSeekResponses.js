const { normalizeUsage } = require("../responsesRuntime/contract");
const { resolveResponsesModel } = require("../responsesRuntime/modelRouting");

const SUPPORTED_RESPONSE_KEYS = new Set([
  "provider",
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "response_format",
  "reasoning",
  "temperature",
  "max_output_tokens",
  "stream",
]);
const RESPONSE_FORMAT_TYPES = new Set(["text", "json_object", "json_schema"]);

function responseError(code) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = 400;
  return error;
}

function validateResponseFormat(format) {
  if (format === undefined || format === null) return;
  if (!format || typeof format !== "object" || Array.isArray(format))
    throw responseError("provider_response_format_not_supported");
  const type = String(format.type || "");
  if (!RESPONSE_FORMAT_TYPES.has(type))
    throw responseError("provider_response_format_not_supported");
  if (
    type === "json_schema" &&
    (!String(format.name || "").trim() ||
      !format.schema ||
      typeof format.schema !== "object" ||
      Array.isArray(format.schema))
  )
    throw responseError("provider_response_schema_invalid");
}

function validateProviderRequest(body = {}) {
  const unknown = Object.keys(body).filter(
    (key) => !SUPPORTED_RESPONSE_KEYS.has(key)
  );
  if (unknown.length) {
    const error = responseError("provider_protocol_incompatible");
    error.details = { unsupported: unknown };
    throw error;
  }
  if (!String(body.provider || "").trim() || !String(body.model || "").trim())
    throw responseError("provider_responses_model_not_supported");
  if (!Array.isArray(body.input) || body.input.length === 0)
    throw responseError("provider_responses_input_required");
  validateResponseFormat(body.response_format);
  const modelRoute = resolveResponsesModel({
    provider: body.provider,
    requestedModel: body.athena?.requestedModel || body.model,
  });
  return { ...body, model: modelRoute.effectiveModel };
}

function outputText(response = {}) {
  if (typeof response.output_text === "string") return response.output_text;
  return (response.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .filter((part) => part?.type === "output_text")
    .map((part) => part.text || "")
    .join("");
}

function normalizeResponse(response = {}) {
  return {
    output: Array.isArray(response.output) ? response.output : [],
    output_text: outputText(response),
    usage: normalizeUsage(response.usage || {}),
    status: response.status || "completed",
    model: response.model || null,
    requestedProtocol: "responses",
    effectiveProtocol: "responses",
    degradedReason: null,
  };
}

function providerResponsesClient(provider) {
  const create = provider?.openai?.responses?.create;
  if (typeof create !== "function") {
    const error = new Error("provider_responses_unavailable");
    error.code = "provider_responses_unavailable";
    error.httpStatus = 503;
    throw error;
  }
  return create.bind(provider.openai.responses);
}

function providerRequest(input, { stream = false } = {}) {
  return {
    model: input.model,
    input: input.input,
    ...(stream ? { stream: true } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.tool_choice ? { tool_choice: input.tool_choice } : {}),
    ...(Object.keys(input.reasoning || {}).length
      ? { reasoning: input.reasoning }
      : {}),
    ...(input.response_format
      ? { text: { format: input.response_format } }
      : {}),
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    ...(input.max_output_tokens != null
      ? { max_output_tokens: input.max_output_tokens }
      : {}),
  };
}

async function deepSeekResponsesComplete(input, { providerFactory }) {
  const normalizedInput = validateProviderRequest(input);
  const provider = providerFactory(normalizedInput);
  const response = await providerResponsesClient(provider)(
    providerRequest(normalizedInput)
  );
  return normalizeResponse(response);
}

async function* deepSeekResponsesStream(input, { providerFactory }) {
  const normalizedInput = validateProviderRequest(input);
  const provider = providerFactory(normalizedInput);
  const stream = await providerResponsesClient(provider)(
    providerRequest(normalizedInput, { stream: true })
  );
  for await (const event of stream) yield event;
}

module.exports = {
  deepSeekResponsesComplete,
  deepSeekResponsesStream,
  normalizeResponse,
  providerRequest,
  providerResponsesClient,
  validateProviderRequest,
  validateResponseFormat,
};
