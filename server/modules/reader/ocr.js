const {
  DEFAULT_BASE_URL: DEFAULT_ALIBABA_OCR_BASE_URL,
  DEFAULT_MODEL: DEFAULT_ALIBABA_OCR_MODEL,
  assertImageDataUrl,
  recognizeImage,
} = require("../../utils/OcrProviders/alibaba");

function readerOcrConfigStatus(env = process.env) {
  const provider = String(env.READER_OCR_PROVIDER || "none").trim();
  if (provider === "none") {
    return {
      success: true,
      configured: false,
      provider,
      modelConfigured: false,
      apiKeyConfigured: false,
      baseUrlConfigured: false,
      reason: "disabled",
    };
  }

  if (provider !== "alibaba") {
    return {
      success: true,
      configured: false,
      provider,
      modelConfigured: false,
      apiKeyConfigured: false,
      baseUrlConfigured: false,
      reason: "invalid_provider",
    };
  }

  const model = String(env.READER_OCR_MODEL_PREF || "").trim();
  const apiKey = String(env.READER_OCR_API_KEY || "").trim();
  const baseUrl = String(env.READER_OCR_BASE_URL || "").trim();
  const modelConfigured = model.length > 0;
  const apiKeyConfigured = apiKey.length > 0;
  const baseUrlConfigured = baseUrl.length > 0;
  const configured = modelConfigured && apiKeyConfigured && baseUrlConfigured;
  const reason = configured
    ? "configured"
    : !modelConfigured && !apiKeyConfigured && !baseUrlConfigured
      ? "missing_model_api_key_and_base_url"
      : !modelConfigured
        ? "missing_model"
        : !apiKeyConfigured
          ? "missing_api_key"
          : "missing_base_url";

  return {
    success: true,
    configured,
    provider,
    modelConfigured,
    apiKeyConfigured,
    baseUrlConfigured,
    reason,
  };
}

function readerOcrProviderOptions(env = process.env) {
  const status = readerOcrConfigStatus(env);
  if (!status.configured) {
    const error = new Error(`Reader OCR is not configured: ${status.reason}`);
    error.status = 400;
    throw error;
  }
  return {
    provider: status.provider,
    model: String(
      env.READER_OCR_MODEL_PREF || DEFAULT_ALIBABA_OCR_MODEL
    ).trim(),
    apiKey: String(env.READER_OCR_API_KEY || "").trim(),
    baseUrl: String(
      env.READER_OCR_BASE_URL || DEFAULT_ALIBABA_OCR_BASE_URL
    ).trim(),
  };
}

async function recognizeReaderScreenshot(payload = {}, env = process.env) {
  const imageDataUrl = assertImageDataUrl(payload.imageDataUrl);
  const options = readerOcrProviderOptions(env);
  if (options.provider !== "alibaba") {
    const error = new Error("Unsupported OCR provider.");
    error.status = 400;
    throw error;
  }

  const startedAt = Date.now();
  const result = await recognizeImage({
    imageDataUrl,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
  });
  return {
    success: true,
    provider: options.provider,
    model: options.model,
    text: result.text || "",
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  readerOcrConfigStatus,
  readerOcrProviderOptions,
  recognizeReaderScreenshot,
};
