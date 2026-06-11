const crypto = require("crypto");

function numericUsageValue(usage = {}, key) {
  if (!Object.prototype.hasOwnProperty.call(usage, key)) return null;
  const value = Number(usage[key]);
  return Number.isFinite(value) ? value : null;
}

function deepSeekUsageMetrics(usage = {}) {
  const metrics = {};
  const promptTokens = numericUsageValue(usage, "prompt_tokens");
  const completionTokens = numericUsageValue(usage, "completion_tokens");
  const totalTokens = numericUsageValue(usage, "total_tokens");
  const cacheHitTokens = numericUsageValue(usage, "prompt_cache_hit_tokens");
  const cacheMissTokens = numericUsageValue(usage, "prompt_cache_miss_tokens");

  if (promptTokens !== null) metrics.prompt_tokens = promptTokens;
  if (completionTokens !== null) metrics.completion_tokens = completionTokens;
  if (totalTokens !== null) metrics.total_tokens = totalTokens;
  if (cacheHitTokens !== null) metrics.prompt_cache_hit_tokens = cacheHitTokens;
  if (cacheMissTokens !== null)
    metrics.prompt_cache_miss_tokens = cacheMissTokens;

  if (cacheHitTokens !== null || cacheMissTokens !== null) {
    const totalCacheTokens = (cacheHitTokens || 0) + (cacheMissTokens || 0);
    if (totalCacheTokens > 0)
      metrics.prompt_cache_hit_rate = (cacheHitTokens || 0) / totalCacheTokens;
  }

  return metrics;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function sha256(input = "") {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  return stableStringify(content);
}

function deepSeekPromptShape(messages = []) {
  return messages.map((message, index) => {
    const content = contentText(message?.content);
    return {
      index,
      role: message?.role || "",
      contentLength: content.length,
      contentSha256: sha256(content),
    };
  });
}

function deepSeekPromptFingerprint(messages = []) {
  return sha256(stableStringify(deepSeekPromptShape(messages)));
}

function deepSeekToolShape(functions = []) {
  return (Array.isArray(functions) ? functions : []).map((fn, index) => {
    const parameters = stableStringify(fn?.parameters || {});
    const description = String(fn?.description || "");
    return {
      index,
      name: String(fn?.name || ""),
      descriptionLength: description.length,
      descriptionSha256: sha256(description),
      parametersLength: parameters.length,
      parametersSha256: sha256(parameters),
    };
  });
}

function deepSeekToolFingerprint(functions = []) {
  return sha256(stableStringify(deepSeekToolShape(functions)));
}

function deepSeekHistoryWindowShape(historyWindow = null) {
  if (!historyWindow) return null;
  return {
    strategy: historyWindow.strategy,
    blockSize: historyWindow.blockSize,
    maxBlocks: historyWindow.maxBlocks,
    totalCount: historyWindow.totalCount,
    offset: historyWindow.offset,
    limit: historyWindow.limit,
    windowStartOrdinal: historyWindow.windowStartOrdinal,
    windowEndOrdinal: historyWindow.windowEndOrdinal,
    currentBlockIndex: historyWindow.currentBlockIndex,
  };
}

function deepSeekPromptCacheDiagnostics({
  provider = null,
  model = null,
  messages = [],
  functions = [],
  historyWindow = null,
  providerPath = null,
} = {}) {
  const stablePrefix = Array.isArray(messages) ? messages.slice(0, -1) : [];
  return {
    provider,
    model,
    providerPath,
    stablePrefixFingerprint: deepSeekPromptFingerprint(stablePrefix),
    stablePrefixMessageCount: stablePrefix.length,
    toolShapeFingerprint: deepSeekToolFingerprint(functions),
    toolCount: Array.isArray(functions) ? functions.length : 0,
    historyWindow: deepSeekHistoryWindowShape(historyWindow),
  };
}

module.exports = {
  deepSeekUsageMetrics,
  deepSeekPromptShape,
  deepSeekPromptFingerprint,
  deepSeekToolShape,
  deepSeekToolFingerprint,
  deepSeekPromptCacheDiagnostics,
  deepSeekHistoryWindowShape,
};
