const crypto = require("crypto");
const LOW_CACHE_HIT_RATE_THRESHOLD = 0.5;

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

function deepSeekCompactionShape(compaction = null) {
  if (!compaction) return null;
  const capsuleJson = contentText(compaction.capsule_json);
  return {
    id: compaction.id ?? null,
    summary_format: compaction.summary_format ?? null,
    has_capsule: Boolean(capsuleJson),
    capsule_json_length: capsuleJson.length,
    capsule_json_sha256: capsuleJson ? sha256(capsuleJson) : null,
    covered_from_chat_id: compaction.covered_from_chat_id ?? null,
    covered_to_chat_id: compaction.covered_to_chat_id ?? null,
    covered_message_count: compaction.covered_message_count ?? null,
    token_before: compaction.token_before ?? null,
    token_after: compaction.token_after ?? null,
    reason: compaction.reason ?? null,
    created_at: compaction.created_at
      ? new Date(compaction.created_at).toISOString()
      : null,
    updated_at: compaction.updated_at
      ? new Date(compaction.updated_at).toISOString()
      : null,
  };
}

function deepSeekCompactionFingerprint(compaction = null) {
  const shape = deepSeekCompactionShape(compaction);
  if (!shape) return null;
  return sha256(stableStringify(shape));
}

function deepSeekPromptCacheDiagnostics({
  provider = null,
  model = null,
  messages = [],
  functions = [],
  historyWindow = null,
  compaction = null,
  providerPath = null,
} = {}) {
  const stablePrefix = Array.isArray(messages) ? messages.slice(0, -1) : [];
  const compactionShape = deepSeekCompactionShape(compaction);
  return {
    provider,
    model,
    providerPath,
    stablePrefixFingerprint: deepSeekPromptFingerprint(stablePrefix),
    stablePrefixMessageCount: stablePrefix.length,
    toolShapeFingerprint: deepSeekToolFingerprint(functions),
    toolCount: Array.isArray(functions) ? functions.length : 0,
    agentToolRerankerEnabled:
      providerPath === "agent"
        ? process.env.AGENT_SKILL_RERANKER_ENABLED === "true"
        : undefined,
    agentToolRerankerTopN:
      providerPath === "agent" && process.env.AGENT_SKILL_RERANKER_TOP_N
        ? Number(process.env.AGENT_SKILL_RERANKER_TOP_N)
        : undefined,
    historyWindow: deepSeekHistoryWindowShape(historyWindow),
    compactionFingerprint: compactionShape
      ? deepSeekCompactionFingerprint(compactionShape)
      : null,
    compaction: compactionShape
      ? {
          fingerprint: deepSeekCompactionFingerprint(compactionShape),
          id: compactionShape.id,
          summary_format: compactionShape.summary_format,
          has_capsule: compactionShape.has_capsule,
          capsule_json_length: compactionShape.capsule_json_length,
          capsule_json_sha256: compactionShape.capsule_json_sha256,
          covered_from_chat_id: compactionShape.covered_from_chat_id,
          covered_to_chat_id: compactionShape.covered_to_chat_id,
          covered_message_count: compactionShape.covered_message_count,
        }
      : null,
  };
}

function numericMetricValue(metrics = {}, key) {
  if (!Object.prototype.hasOwnProperty.call(metrics, key)) return null;
  const value = Number(metrics[key]);
  return Number.isFinite(value) ? value : null;
}

function deepSeekCacheUsage(metrics = {}) {
  const hit = numericMetricValue(metrics, "prompt_cache_hit_tokens");
  const miss = numericMetricValue(metrics, "prompt_cache_miss_tokens");
  const explicitRate = numericMetricValue(metrics, "prompt_cache_hit_rate");
  const hasCacheUsage = hit !== null || miss !== null;
  const total = (hit || 0) + (miss || 0);
  const hitRate =
    explicitRate !== null
      ? explicitRate
      : total > 0
        ? (hit || 0) / total
        : null;
  return {
    hit,
    miss,
    total,
    hitRate,
    hasCacheUsage,
  };
}

function historyWindowBoundaryChanged(current = null, previous = null) {
  if (!current || !previous) return false;
  return (
    current.strategy !== previous.strategy ||
    current.offset !== previous.offset ||
    current.windowStartOrdinal !== previous.windowStartOrdinal ||
    current.currentBlockIndex !== previous.currentBlockIndex
  );
}

function hasDeepSeekCacheDiagnostics(metrics = {}) {
  const diagnostics = metrics?.promptCacheDiagnostics;
  if (!diagnostics) return false;
  return Boolean(
    diagnostics.providerPath ||
      diagnostics.stablePrefixFingerprint ||
      diagnostics.toolShapeFingerprint
  );
}

function diagnosticValueChanged(current = null, previous = null) {
  return Boolean((current || previous) && current !== previous);
}

function deepSeekCacheDiagnosis({
  metrics = {},
  previousMetrics = null,
  lowHitRateThreshold = LOW_CACHE_HIT_RATE_THRESHOLD,
} = {}) {
  const diagnostics = metrics?.promptCacheDiagnostics || {};
  const previousDiagnostics = previousMetrics?.promptCacheDiagnostics || {};
  const usage = deepSeekCacheUsage(metrics);
  const cacheUsageMissing = !usage.hasCacheUsage;
  const lowHitRate =
    usage.hitRate !== null ? usage.hitRate < lowHitRateThreshold : false;
  const previousStablePrefixFingerprint =
    previousDiagnostics.stablePrefixFingerprint || null;
  const stablePrefixChanged = Boolean(
    previousStablePrefixFingerprint &&
      diagnostics.stablePrefixFingerprint &&
      previousStablePrefixFingerprint !== diagnostics.stablePrefixFingerprint
  );
  const toolShapeChanged = Boolean(
    previousDiagnostics.toolShapeFingerprint &&
      diagnostics.toolShapeFingerprint &&
      previousDiagnostics.toolShapeFingerprint !==
        diagnostics.toolShapeFingerprint
  );
  const compactionChanged = diagnosticValueChanged(
    diagnostics.compactionFingerprint || null,
    previousDiagnostics.compactionFingerprint || null
  );
  const historyWindowChanged = historyWindowBoundaryChanged(
    diagnostics.historyWindow,
    previousDiagnostics.historyWindow
  );

  let reason = "stable_or_high_hit";
  if (cacheUsageMissing) reason = "cache_usage_missing";
  else if (!previousMetrics)
    reason = lowHitRate ? "cold_cache_or_unknown" : reason;
  else if (lowHitRate) {
    if (compactionChanged) reason = "compaction_changed";
    else if (historyWindowChanged) reason = "history_window_boundary_changed";
    else if (toolShapeChanged) reason = "tool_shape_changed";
    else if (stablePrefixChanged) reason = "stable_prefix_changed";
    else reason = "cold_cache_or_unknown";
  }

  return {
    reason,
    lowHitRateThreshold,
    hitRate: usage.hitRate,
    cacheUsageMissing,
    previousStablePrefixFingerprint,
    stablePrefixChanged,
    toolShapeChanged,
    historyWindowBoundaryChanged: historyWindowChanged,
    compactionChanged,
  };
}

function withDeepSeekCacheDiagnosis(metrics = {}, previousMetrics = null) {
  if (!hasDeepSeekCacheDiagnostics(metrics)) return metrics || {};
  return {
    ...(metrics || {}),
    cacheDiagnosis: deepSeekCacheDiagnosis({ metrics, previousMetrics }),
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
  deepSeekCompactionShape,
  deepSeekCompactionFingerprint,
  deepSeekCacheUsage,
  deepSeekCacheDiagnosis,
  withDeepSeekCacheDiagnosis,
  hasDeepSeekCacheDiagnostics,
};
