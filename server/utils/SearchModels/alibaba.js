const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.7-plus";
const { readSecret } = require("../security/secretStore");

function cleanBaseUrl(baseUrl = DEFAULT_BASE_URL) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function readApiKey(value) {
  return String(readSecret(value || "") || "").trim();
}

function searchModelConfigStatus(env = process.env) {
  const provider = String(env.SEARCH_MODEL_PROVIDER || "none").trim();
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

  const model = String(env.SEARCH_MODEL_PREF || DEFAULT_MODEL).trim();
  const apiKey = String(env.SEARCH_MODEL_API_KEY || "").trim();
  const baseUrl = String(env.SEARCH_MODEL_BASE_URL || DEFAULT_BASE_URL).trim();
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

function isSearchModelConfigured(env = process.env) {
  return searchModelConfigStatus(env).configured;
}

function searchModelProviderOptions(env = process.env) {
  const status = searchModelConfigStatus(env);
  if (!status.configured) {
    const error = new Error(`Search Model is not configured: ${status.reason}`);
    error.status = 400;
    error.code = "SEARCH_MODEL_NOT_CONFIGURED";
    throw error;
  }

  return {
    provider: status.provider,
    model: String(env.SEARCH_MODEL_PREF || DEFAULT_MODEL).trim(),
    apiKey: readApiKey(env.SEARCH_MODEL_API_KEY),
    baseUrl: cleanBaseUrl(env.SEARCH_MODEL_BASE_URL || DEFAULT_BASE_URL),
  };
}

function extractTextFromCompletion(payload = {}) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function normalizeSearchResult(result = {}, index = 0) {
  const link =
    result.url ||
    result.link ||
    result.website ||
    result.source_url ||
    result.link_clean ||
    "";
  return {
    index: result.index ?? index + 1,
    title: result.title || result.name || link || `Source ${index + 1}`,
    link,
    snippet:
      result.snippet ||
      result.summary ||
      result.content ||
      result.text ||
      result.description ||
      "",
  };
}

function extractSearchResults(payload = {}) {
  const candidates = [
    payload?.search_info?.search_results,
    payload?.output?.search_info?.search_results,
    payload?.choices?.[0]?.message?.search_info?.search_results,
    payload?.choices?.[0]?.message?.metadata?.search_results,
    payload?.search_results,
  ];

  const results = candidates.find(Array.isArray);
  if (!results) return [];
  return results.map(normalizeSearchResult).filter((result) => result.link);
}

async function searchWithAlibabaModel({
  query,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return { text: "", results: [], raw: null };

  const options = searchModelProviderOptions(env);
  const response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        {
          role: "user",
          content: cleanQuery,
        },
      ],
      enable_search: true,
      search_options: {
        search_strategy: "turbo",
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.message ||
        "Search Model provider request failed."
    );
  }

  return {
    text: extractTextFromCompletion(payload),
    results: extractSearchResults(payload),
    raw: payload,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  cleanBaseUrl,
  extractSearchResults,
  extractTextFromCompletion,
  isSearchModelConfigured,
  readApiKey,
  searchModelConfigStatus,
  searchModelProviderOptions,
  searchWithAlibabaModel,
};
