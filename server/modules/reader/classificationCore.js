const CLASSIFICATION_LLM_TEXT_LIMIT = 3_000;
const CLASSIFICATION_CONFIDENCE_THRESHOLD = 0.55;
const READER_POSTPROCESS_TEXT_LIMIT = 100_000;

function compactClassificationText(text = "") {
  return String(text || "")
    .replaceAll(String.fromCharCode(0), "")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createClassificationAccumulator(
  limit = READER_POSTPROCESS_TEXT_LIMIT
) {
  return {
    parts: [],
    length: 0,
    append(text = "") {
      if (this.length >= limit) return 0;
      const next = compactClassificationText(text);
      if (!next) return 0;
      const remaining = limit - this.length;
      const slice = next.slice(0, remaining);
      this.parts.push(slice);
      this.length += slice.length;
      return slice.length;
    },
    text() {
      return compactClassificationText(this.parts.join("\n")).slice(0, limit);
    },
    full() {
      return this.length >= limit;
    },
  };
}

function strategyForClassificationLength(totalChars) {
  if (totalChars < 300) return null;
  if (totalChars < 1_200)
    return { sampleCount: 2, sampleSize: 200, positions: [0.25, 0.75] };
  if (totalChars < 5_000)
    return { sampleCount: 3, sampleSize: 300, positions: [0.15, 0.5, 0.85] };
  if (totalChars < 30_000)
    return {
      sampleCount: 4,
      sampleSize: 400,
      positions: [0.1, 0.35, 0.65, 0.9],
    };
  return {
    sampleCount: 5,
    sampleSize: 500,
    positions: [0.08, 0.28, 0.5, 0.72, 0.92],
  };
}

function cappedClassificationSamples(samples = []) {
  let used = 0;
  const capped = [];
  for (const rawSample of Array.isArray(samples) ? samples : []) {
    const remaining = CLASSIFICATION_LLM_TEXT_LIMIT - used;
    if (remaining <= 0) break;
    const text = String(rawSample?.text || "").slice(0, remaining);
    used += text.length;
    if (!text.trim()) continue;
    capped.push({
      index: Number(rawSample.index) || capped.length + 1,
      position: Number(rawSample.position) || null,
      text,
    });
  }
  return capped;
}

function classificationSampleCharCount(samples = []) {
  return samples.reduce(
    (sum, sample) => sum + String(sample.text || "").length,
    0
  );
}

function buildReaderClassificationSamples(text = "") {
  const normalized = compactClassificationText(text);
  const totalChars = normalized.length;
  const strategy = strategyForClassificationLength(totalChars);
  if (!strategy) {
    return {
      ok: false,
      reason: "可用于分类的文本过少。",
      totalChars,
      sampleCount: 0,
      sampleSize: 0,
      sampleStrategy: "too-short",
      samples: [],
    };
  }

  const samples = strategy.positions.map((position, index) => {
    const center = Math.floor(totalChars * position);
    const start = Math.max(0, center - Math.floor(strategy.sampleSize / 2));
    const end = Math.min(totalChars, start + strategy.sampleSize);
    return {
      index: index + 1,
      position,
      text: normalized.slice(start, end),
    };
  });
  const cappedSamples = cappedClassificationSamples(samples);
  const capped =
    classificationSampleCharCount(cappedSamples) <
    classificationSampleCharCount(samples);
  return {
    ok: true,
    totalChars,
    sampleCount: cappedSamples.length,
    sampleSize: strategy.sampleSize,
    sampleStrategy: `balanced-${strategy.sampleCount}x${strategy.sampleSize}${
      capped ? "-llm-cap-3000" : ""
    }`,
    samples: cappedSamples,
  };
}

function sanitizedPostprocessTasks(tasks = []) {
  const allowed = new Set([
    "preview",
    "thumbnail",
    "classification",
    "pdfManifest",
  ]);
  const source = Array.isArray(tasks) && tasks.length ? tasks : [...allowed];
  return [...new Set(source.filter((task) => allowed.has(task)))];
}

function safeClassificationReason(type = "failed") {
  const reasons = {
    missing_key: "分类模型未配置，已归入未知分类。",
    unavailable: "分类模型暂不可用，已归入未知分类。",
    timeout: "分类请求超时，已归入未知分类。",
    invalid_json: "分类模型返回格式异常，已归入未知分类。",
    invalid_category: "分类模型选择了不存在的分类，已归入未知分类。",
    low_confidence: "分类置信度较低，已归入未知分类。",
    empty_categories: "分类列表不可用，已归入未知分类。",
    failed: "自动分类失败，已归入未知分类。",
  };
  return reasons[type] || reasons.failed;
}

function sanitizedClassificationCategories(categories = []) {
  const byId = new Map();
  for (const rawCategory of Array.isArray(categories) ? categories : []) {
    const id = String(rawCategory?.id || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const name = String(rawCategory?.name || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 30);
    if (!id || !name || byId.has(id)) continue;
    byId.set(id, { id, name });
  }
  if (!byId.has("unknown"))
    byId.set("unknown", { id: "unknown", name: "未知分类" });
  return [...byId.values()];
}

function unknownClassificationCategory(categories = [], reason = "") {
  const unknown = categories.find((category) => category.id === "unknown") || {
    id: "unknown",
    name: "未知分类",
  };
  const now = new Date().toISOString();
  return {
    success: true,
    categoryStatus: "unknown",
    categoryStage: "unknownReason",
    categoryReason: reason,
    reason,
    category: {
      primaryCategoryId: unknown.id,
      primaryCategoryName: unknown.name,
      secondaryCategory: "",
      tags: [],
      confidence: 0,
      source: "fallback",
      reason,
      evidence: [],
      sampleStrategy: "",
      classifiedAt: now,
      updatedAt: now,
    },
  };
}

function classificationLookupKey(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[《》<>【】[\]（）(){}，,。.:：·・"'“”‘’/\\|]+/g, "");
}

function resolveClassificationCategory(result = {}, categories = []) {
  const candidates = [
    result.primaryCategoryId,
    result.primaryCategoryName,
    result.categoryId,
    result.categoryName,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const exact = categories.find((category) => category.id === candidate);
    if (exact) return exact;
  }

  const normalizedCandidates = candidates.map(classificationLookupKey);
  for (const candidate of normalizedCandidates) {
    const matched = categories.find(
      (category) =>
        classificationLookupKey(category.id) === candidate ||
        classificationLookupKey(category.name) === candidate
    );
    if (matched) return matched;
  }

  return null;
}

const FINANCE_TITLE_KEYWORDS = [
  "经济",
  "金融",
  "资本",
  "投资",
  "周期",
  "财富",
  "货币",
  "银行",
  "证券",
  "股票",
  "基金",
  "债券",
  "交易",
  "宏观",
  "产业",
  "财务",
  "商业",
  "market",
  "finance",
  "capital",
  "investment",
  "investing",
  "wealth",
  "cycle",
  "money",
  "bank",
];

function titleHasFinanceSignal(title = "") {
  const normalizedTitle = classificationLookupKey(title);
  if (!normalizedTitle) return false;
  return FINANCE_TITLE_KEYWORDS.some((keyword) =>
    normalizedTitle.includes(classificationLookupKey(keyword))
  );
}

function financeCategory(categories = []) {
  return (
    categories.find((category) => category.id === "finance") ||
    categories.find(
      (category) =>
        classificationLookupKey(category.name) ===
        classificationLookupKey("金融经济")
    ) ||
    categories.find((category) =>
      classificationLookupKey(category.name).includes(
        classificationLookupKey("金融")
      )
    )
  );
}

function titleFallbackClassification({
  title = "",
  categories = [],
  reason = "",
  sampleStrategy = "",
}) {
  const category = financeCategory(categories);
  if (!category || !titleHasFinanceSignal(title)) return null;
  const now = new Date().toISOString();
  const titleSnippet = String(title || "").slice(0, 80);
  const fallbackReason =
    String(reason || "")
      .replace("已归入未知分类", `已按书名关键词归入${category.name}`)
      .trim() || `自动分类未能可靠判断，已按书名关键词归入${category.name}。`;
  return {
    success: true,
    categoryStatus: "classified",
    categoryStage: "fallback-rule",
    categoryReason: fallbackReason,
    reason: fallbackReason,
    category: {
      primaryCategoryId: category.id,
      primaryCategoryName: category.name,
      secondaryCategory: "",
      tags: ["金融经济"],
      confidence: 0.49,
      source: "fallback-rule",
      reason: fallbackReason,
      evidence: titleSnippet ? [`书名关键词命中：${titleSnippet}`] : [],
      sampleStrategy,
      classifiedAt: now,
      updatedAt: now,
    },
  };
}

function classificationFallback({
  title = "",
  categories = [],
  reason = "",
  sampleStrategy = "",
}) {
  return (
    titleFallbackClassification({
      title,
      categories,
      reason,
      sampleStrategy,
    }) || unknownClassificationCategory(categories, reason)
  );
}

function extractFirstJsonObject(text = "") {
  const raw = String(text || "");
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (depth === 0) {
      if (char !== "{") continue;
      start = index;
      depth = 1;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) return raw.slice(start, index + 1);
    }
  }
  return "";
}

function parseClassificationJson(text = "") {
  const raw = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const withoutFence = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const jsonObject = extractFirstJsonObject(withoutFence);
    if (!jsonObject) throw new Error("classification_invalid_json");
    return JSON.parse(jsonObject);
  }
}

function buildReaderClassificationPrompt({
  title,
  documentType,
  categories,
  samples,
  sampleStrategy,
  totalChars,
}) {
  return `请根据抽样文本为书籍选择一个主分类。

硬性规则：
- 只能从给定分类列表中选择 primaryCategoryId，不得创造新分类。
- primaryCategoryName 必须与 primaryCategoryId 对应。
- 如果文本不可用、无法判断或置信度不足，选择 unknown。
- 如果文本可用但不属于任何现有分类，优先选择 other（如果分类列表存在 other），否则选择 unknown。
- evidence 只能引用抽样片段中出现的信息，不要编造书名、作者、章节或不存在的概念。
- 只输出严格 JSON，不要 Markdown，不要解释。

输出 JSON 结构：
{"primaryCategoryId":"","primaryCategoryName":"","secondaryCategory":"","confidence":0,"reason":"","evidence":[],"tags":[]}

分类列表：
${JSON.stringify(categories)}

书籍信息：
${JSON.stringify({
  title: String(title || "").slice(0, 160),
  documentType,
  totalChars,
  sampleStrategy,
  sampleTextChars: classificationSampleCharCount(samples),
})}

抽样片段：
${JSON.stringify(samples)}`;
}

function validateClassificationResult({
  result,
  categories,
  sampleStrategy,
  title = "",
}) {
  const category = resolveClassificationCategory(result, categories);
  if (!category)
    return classificationFallback({
      title,
      categories,
      reason: safeClassificationReason("invalid_category"),
      sampleStrategy,
    });
  const confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  if (confidence < CLASSIFICATION_CONFIDENCE_THRESHOLD)
    return classificationFallback({
      title,
      categories,
      reason: safeClassificationReason("low_confidence"),
      sampleStrategy,
    });
  const now = new Date().toISOString();
  return {
    success: true,
    categoryStatus: "classified",
    categoryStage: "classified",
    categoryReason: String(result.reason || "").slice(0, 180),
    category: {
      primaryCategoryId: category.id,
      primaryCategoryName: category.name,
      secondaryCategory: String(result.secondaryCategory || "")
        .trim()
        .slice(0, 40),
      tags: Array.isArray(result.tags)
        ? result.tags
            .map((tag) => String(tag).trim())
            .filter(Boolean)
            .slice(0, 6)
        : [],
      confidence,
      source: "llm",
      reason: String(result.reason || "")
        .trim()
        .slice(0, 180),
      evidence: Array.isArray(result.evidence)
        ? result.evidence
            .map((item) => String(item).trim())
            .filter(Boolean)
            .slice(0, 4)
        : [],
      sampleStrategy,
      classifiedAt: now,
      updatedAt: now,
    },
  };
}

module.exports = {
  buildReaderClassificationSamples,
  buildReaderClassificationPrompt,
  cappedClassificationSamples,
  classificationFallback,
  classificationLookupKey,
  classificationSampleCharCount,
  compactClassificationText,
  createClassificationAccumulator,
  financeCategory,
  parseClassificationJson,
  resolveClassificationCategory,
  safeClassificationReason,
  sanitizedClassificationCategories,
  sanitizedPostprocessTasks,
  titleFallbackClassification,
  titleHasFinanceSignal,
  unknownClassificationCategory,
  validateClassificationResult,
};
