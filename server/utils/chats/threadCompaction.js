const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const WorkspaceChatCompaction = lazyDataAccessFacade("workspaceChatCompaction");
const { getTaskConnector, resolveTaskProviderModel } = require("../llmTasks");
const { TokenManager } = require("../helpers/tiktoken");
const { convertToPromptHistory } = require("../helpers/chat/responses");
const { recentChatHistory } = require("./index");
const { jsonrepair } = require("jsonrepair");

const DEFAULT_KEEP_RECENT_MESSAGES = 10;
const DEFAULT_TRIGGER_RATIO = 0.65;
const DEFAULT_MAX_SUMMARY_TOKENS = 2500;
const DEFAULT_COMPACTION_CONTEXT_WINDOW_TOKENS = 400_000;
const DEFAULT_MANUAL_TARGET_RATIO = 0.2;
const DEFAULT_AUTO_TARGET_RATIO = 0.2;
const DEFAULT_TARGET_ABSOLUTE_TOKENS = 150_000;
const DEFAULT_TARGET_MIN_SUMMARY_TOKENS = 12_000;
const DEFAULT_TARGET_MAX_SUMMARY_TOKENS = 60_000;
const DEFAULT_TARGET_SUMMARY_BUDGET_RATIO = 0.5;
const MANUAL_COMPACT_RATIO = 0.8;
const AUTO_COOLDOWN_MS = 5 * 60 * 1000;
const TARGET_RATIO_MIN = 0.1;
const TARGET_RATIO_MAX = 0.2;
const CONVERSATION_CAPSULE_TAG = "athena_conversation_capsule";
const DEFAULT_TEMPORARY_CONTEXT_TTL = 3;
const COMPACTION_STATUS_TTL_MS = 3_000;
const COMPACTION_STATUS_CACHE_MAX = 250;
const inFlightCompactions = new Set();
const recentAutoCompactions = new Map();
const recentTargetFailures = new Map();
const compactionStatusCache = new Map();

function envBool(name, defaultValue = false) {
  if (process.env[name] === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(
    String(process.env[name]).toLowerCase()
  );
}

function envNumber(name, defaultValue) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

function envString(name, defaultValue = null) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === "")
    return defaultValue;
  return String(value).trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getConfig() {
  const compactionProviderModel = resolveTaskProviderModel("thread_compaction");
  const minSummaryTokens = Math.max(
    1,
    Math.floor(
      envNumber(
        "THREAD_COMPACTION_TARGET_MIN_SUMMARY_TOKENS",
        DEFAULT_TARGET_MIN_SUMMARY_TOKENS
      )
    )
  );
  const maxSummaryTokens = Math.max(
    minSummaryTokens,
    Math.floor(
      envNumber(
        "THREAD_COMPACTION_TARGET_MAX_SUMMARY_TOKENS",
        DEFAULT_TARGET_MAX_SUMMARY_TOKENS
      )
    )
  );
  return {
    enabled: envBool("THREAD_COMPACTION_ENABLED", true),
    autoEnabled: envBool("THREAD_COMPACTION_AUTO_ENABLED", false),
    compactionProvider: compactionProviderModel.provider,
    compactionModel: compactionProviderModel.model,
    compactionContextWindowTokens: Math.max(
      1,
      Math.floor(
        envNumber(
          "THREAD_COMPACTION_CONTEXT_WINDOW_TOKENS",
          DEFAULT_COMPACTION_CONTEXT_WINDOW_TOKENS
        )
      )
    ),
    targetBase: envString("THREAD_COMPACTION_TARGET_BASE", null),
    targetAbsoluteTokens: Math.max(
      1,
      Math.floor(
        envNumber(
          "THREAD_COMPACTION_TARGET_ABSOLUTE_TOKENS",
          DEFAULT_TARGET_ABSOLUTE_TOKENS
        )
      )
    ),
    manualTargetRatio: clamp(
      envNumber(
        "THREAD_COMPACTION_MANUAL_TARGET_RATIO",
        envNumber("THREAD_COMPACTION_TARGET_RATIO", DEFAULT_MANUAL_TARGET_RATIO)
      ),
      TARGET_RATIO_MIN,
      TARGET_RATIO_MAX
    ),
    autoTargetRatio: clamp(
      envNumber(
        "THREAD_COMPACTION_AUTO_TARGET_RATIO",
        envNumber("THREAD_COMPACTION_TARGET_RATIO", DEFAULT_AUTO_TARGET_RATIO)
      ),
      TARGET_RATIO_MIN,
      TARGET_RATIO_MAX
    ),
    targetMinSummaryTokens: minSummaryTokens,
    targetMaxSummaryTokens: maxSummaryTokens,
    targetSummaryBudgetRatio: clamp(
      envNumber(
        "THREAD_COMPACTION_TARGET_SUMMARY_BUDGET_RATIO",
        DEFAULT_TARGET_SUMMARY_BUDGET_RATIO
      ),
      0.05,
      0.95
    ),
    minKeepRecentMessages: Math.max(
      0,
      Math.floor(envNumber("THREAD_COMPACTION_MIN_KEEP_RECENT_MESSAGES", 1))
    ),
    triggerRatio: envNumber(
      "THREAD_COMPACTION_TRIGGER_RATIO",
      DEFAULT_TRIGGER_RATIO
    ),
    keepRecentMessages: Math.max(
      1,
      Math.floor(
        envNumber(
          "THREAD_COMPACTION_KEEP_RECENT_MESSAGES",
          DEFAULT_KEEP_RECENT_MESSAGES
        )
      )
    ),
    maxSummaryTokens: Math.max(
      500,
      Math.floor(
        envNumber(
          "THREAD_COMPACTION_MAX_SUMMARY_TOKENS",
          DEFAULT_MAX_SUMMARY_TOKENS
        )
      )
    ),
  };
}

function buildCompactionScope({
  workspace,
  workspaceId = null,
  user = null,
  userId = undefined,
  thread = null,
  threadId = undefined,
  apiSessionId = null,
  api_session_id = undefined,
} = {}) {
  return WorkspaceChatCompaction.normalizeScope({
    workspace_id: workspace?.id || workspaceId,
    user_id: userId !== undefined ? userId : user?.id || null,
    thread_id: threadId !== undefined ? threadId : thread?.id || null,
    api_session_id:
      api_session_id !== undefined ? api_session_id : apiSessionId || null,
  });
}

function scopeKey(scope = {}) {
  const normalized = WorkspaceChatCompaction.normalizeScope(scope);
  return [
    normalized.workspace_id,
    normalized.user_id === null ? "null" : normalized.user_id,
    normalized.thread_id === null ? "null" : normalized.thread_id,
    normalized.api_session_id === null ? "null" : normalized.api_session_id,
  ].join(":");
}

function invalidateThreadCompactionStatus(options = {}) {
  let scope;
  try {
    scope =
      options.workspace_id || options.workspaceId
        ? buildCompactionScope(options)
        : buildCompactionScope({
            workspace: options.workspace,
            user: options.user,
            thread: options.thread,
            apiSessionId: options.apiSessionId,
          });
  } catch {
    return 0;
  }
  const prefix = `${scopeKey(scope)}:`;
  let deleted = 0;
  for (const key of compactionStatusCache.keys()) {
    if (!key.startsWith(prefix)) continue;
    compactionStatusCache.delete(key);
    deleted += 1;
  }
  return deleted;
}

function trimCompactionStatusCache(now = Date.now()) {
  for (const [key, entry] of compactionStatusCache) {
    if (!entry.promise && entry.expiresAt <= now) {
      compactionStatusCache.delete(key);
    }
  }
  while (compactionStatusCache.size >= COMPACTION_STATUS_CACHE_MAX) {
    compactionStatusCache.delete(compactionStatusCache.keys().next().value);
  }
}

function stripProviderReasoning(input = "") {
  return String(input || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .trim();
}

function legacySummaryContextBlock(summary = "") {
  summary = normalizeCompactionSummary(summary);
  if (!summary) return "";
  return `<athena_legacy_thread_memory_summary>
${summary}
</athena_legacy_thread_memory_summary>`;
}

function blankConversationCapsule() {
  return {
    topic: "",
    currentGoal: "",
    confirmedFacts: [],
    confirmedDecisions: [],
    openQuestions: [],
    temporaryContext: [],
    recentDirection: "",
    architectureDecisions: [],
    generatedAt: "",
    coveredToChatId: "",
  };
}

function extractJsonObject(input = "") {
  const stripped = stripProviderReasoning(input)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {}
  try {
    return JSON.parse(jsonrepair(stripped));
  } catch {}

  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      const sliced = stripped.slice(first, last + 1);
      return JSON.parse(sliced);
    } catch {}
    try {
      return JSON.parse(jsonrepair(stripped.slice(first, last + 1)));
    } catch {}
  }
  return null;
}

function cleanText(value = "", maxLength = 2_000) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanStringArray(
  value = [],
  { maxItems = 30, maxLength = 1_000 } = {}
) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const item of value) {
    const text = cleanText(item, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
    if (output.length >= maxItems) break;
  }
  return output;
}

function normalizeTemporaryContext(value = []) {
  if (!Array.isArray(value)) return [];
  const output = [];
  const seen = new Set();
  for (const item of value) {
    const text = cleanText(typeof item === "string" ? item : item?.text, 1_000);
    if (!text || seen.has(text)) continue;
    const ttl = Math.floor(
      Number(item?.expiresAfterCompactions ?? DEFAULT_TEMPORARY_CONTEXT_TTL)
    );
    if (!Number.isFinite(ttl) || ttl <= 0) continue;
    seen.add(text);
    output.push({
      text,
      expiresAfterCompactions: Math.min(ttl, DEFAULT_TEMPORARY_CONTEXT_TTL),
    });
    if (output.length >= 12) break;
  }
  return output;
}

function parseConversationCapsule(input = null, fallback = null) {
  if (!input) return fallback;
  if (typeof input === "object" && !Array.isArray(input)) return input;
  const parsed = extractJsonObject(input);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
    return parsed;
  return fallback;
}

function normalizeConversationCapsule(
  input = {},
  { generatedAt = null, coveredToChatId = null } = {}
) {
  const source = parseConversationCapsule(input, {}) || {};
  const normalized = blankConversationCapsule();
  normalized.topic = cleanText(source.topic, 300);
  normalized.currentGoal = cleanText(source.currentGoal, 600);
  normalized.confirmedFacts = cleanStringArray(source.confirmedFacts);
  normalized.confirmedDecisions = cleanStringArray(source.confirmedDecisions);
  normalized.openQuestions = cleanStringArray(source.openQuestions);
  normalized.temporaryContext = normalizeTemporaryContext(
    source.temporaryContext
  );
  normalized.recentDirection = cleanText(source.recentDirection, 600);
  normalized.architectureDecisions = cleanStringArray(
    source.architectureDecisions,
    { maxItems: 40, maxLength: 1_000 }
  );
  normalized.generatedAt = cleanText(
    generatedAt ?? source.generatedAt ?? new Date().toISOString(),
    80
  );
  normalized.coveredToChatId = cleanText(
    coveredToChatId ?? source.coveredToChatId,
    80
  );
  return normalized;
}

function decrementTemporaryContextTtl(capsule = null) {
  const normalized = normalizeConversationCapsule(capsule);
  return {
    ...normalized,
    temporaryContext: normalized.temporaryContext
      .map((item) => ({
        ...item,
        expiresAfterCompactions: Number(item.expiresAfterCompactions || 0) - 1,
      }))
      .filter((item) => item.expiresAfterCompactions > 0),
  };
}

function capsuleJson(capsule = {}) {
  return JSON.stringify(normalizeConversationCapsule(capsule), null, 2);
}

function conversationCapsuleBlock(capsule = null) {
  const parsed = parseConversationCapsule(capsule, null);
  if (!parsed) return "";
  return `<${CONVERSATION_CAPSULE_TAG}>
${capsuleJson(parsed)}
</${CONVERSATION_CAPSULE_TAG}>`;
}

function compactionContextBlock(compaction = null) {
  if (!compaction) return "";
  const capsule = parseConversationCapsule(compaction.capsule_json, null);
  if (capsule) return conversationCapsuleBlock(capsule);
  return legacySummaryContextBlock(compaction.summary || "");
}

function contextTextsWithCompaction(contextTexts = [], compaction = null) {
  const block = compactionContextBlock(compaction);
  if (!block) return contextTexts || [];
  return [block, ...(contextTexts || [])];
}

function estimateHistoryTokens(llm, chats = []) {
  if (!chats.length) return 0;
  const tokenManager = new TokenManager(llm?.model);
  return tokenManager.statsFrom(convertToPromptHistory(chats));
}

function estimateStringTokens(llm, input = "") {
  if (!input) return 0;
  const tokenManager = new TokenManager(llm?.model);
  return tokenManager.countFromString(input);
}

function safeJsonParse(input, fallback = {}) {
  try {
    return JSON.parse(input || "{}");
  } catch {
    return fallback;
  }
}

function normalizedTargetRatio(value, fallback) {
  return clamp(Number(value ?? fallback), TARGET_RATIO_MIN, TARGET_RATIO_MAX);
}

function resolveCompactionLLM(workspace) {
  const {
    connector: llm,
    provider,
    model,
  } = getTaskConnector("thread_compaction", { workspace });
  return {
    llm,
    provider,
    model,
    fallbackUsed: false,
  };
}

function defaultTargetBase() {
  return "compaction_window";
}

function resolveTargetBudgets({
  chatLLM: _chatLLM,
  compactionLLM: _compactionLLM,
  targetRatio = null,
  mode = "manual",
} = {}) {
  const config = getConfig();
  const compactionInputLimit = config.compactionContextWindowTokens;
  const targetBase = defaultTargetBase();
  const chatInjectionLimit = compactionInputLimit;

  const ratio = normalizedTargetRatio(
    targetRatio,
    mode === "auto" ? config.autoTargetRatio : config.manualTargetRatio
  );
  const targetTokens = Math.floor(chatInjectionLimit * ratio);
  const estimatedSummaryBudget = clamp(
    Math.floor(targetTokens * config.targetSummaryBudgetRatio),
    config.targetMinSummaryTokens,
    config.targetMaxSummaryTokens
  );

  return {
    compactionInputLimit,
    chatInjectionLimit,
    targetBase,
    targetRatio: ratio,
    targetTokens,
    estimatedSummaryBudget,
    recentRawBudget: Math.max(0, targetTokens - estimatedSummaryBudget),
  };
}

function normalizeCompactionSummary(summary = "") {
  if (!summary) return "";
  let normalized = stripProviderReasoning(summary);

  const headingIndex = normalized.indexOf("# Thread Compact Summary");
  if (headingIndex >= 0) normalized = normalized.slice(headingIndex).trim();
  normalized = normalized.replace(/^<think>\s*/i, "").trim();

  return normalized;
}

async function latestCompaction(scope = {}) {
  try {
    return await WorkspaceChatCompaction.latest(scope);
  } catch (error) {
    console.warn("[ThreadCompaction] latest lookup failed", error.message);
    return null;
  }
}

async function recentChatHistoryWithCompaction({
  user = null,
  workspace,
  thread = null,
  messageLimit = 20,
  apiSessionId = null,
  historyStrategy = null,
} = {}) {
  const config = getConfig();
  if (!config.enabled) {
    return await recentChatHistory({
      user,
      workspace,
      thread,
      messageLimit,
      apiSessionId,
      historyStrategy,
    });
  }

  const scope = buildCompactionScope({
    workspace,
    user,
    thread,
    apiSessionId,
  });
  const compaction = await latestCompaction(scope);
  if (!compaction?.covered_to_chat_id) {
    return await recentChatHistory({
      user,
      workspace,
      thread,
      messageLimit,
      apiSessionId,
      historyStrategy,
    });
  }

  try {
    if (historyStrategy) {
      const history = await recentChatHistory({
        user,
        workspace,
        thread,
        messageLimit,
        apiSessionId,
        afterChatId: compaction.covered_to_chat_id,
        historyStrategy,
      });
      return {
        compaction,
        ...history,
      };
    }

    const rawHistory = (
      await WorkspaceChatCompaction.where(scope, {
        afterChatId: compaction.covered_to_chat_id,
        limit: messageLimit,
        orderBy: "desc",
      })
    ).reverse();
    return {
      compaction,
      rawHistory,
      chatHistory: convertToPromptHistory(rawHistory),
    };
  } catch (error) {
    console.warn(
      "[ThreadCompaction] compaction-aware history failed",
      error.message
    );
    return await recentChatHistory({
      user,
      workspace,
      thread,
      messageLimit,
      apiSessionId,
      historyStrategy,
    });
  }
}

async function compactionCandidates(scope = {}, keepRecentMessages = 10) {
  const latest = await latestCompaction(scope);
  const rawHistory = await WorkspaceChatCompaction.where(scope, {
    afterChatId: latest?.covered_to_chat_id || null,
    limit: null,
    orderBy: "asc",
  });
  const keepCount = Math.max(1, Number(keepRecentMessages || 10));
  const compactable =
    rawHistory.length > keepCount ? rawHistory.slice(0, -keepCount) : [];
  return { latest, rawHistory, compactable };
}

function targetCompactionPlan({ llm, rawHistory = [], budgets = {} } = {}) {
  const perChatTokens = rawHistory.map((chat) =>
    estimateHistoryTokens(llm, [chat])
  );
  const retained = [];
  let retainedTokens = 0;
  let cannotReachTargetReason = null;

  for (let index = rawHistory.length - 1; index >= 0; index--) {
    const chatTokens = perChatTokens[index] || 0;
    const nextTokens = retainedTokens + chatTokens;
    if (nextTokens <= budgets.recentRawBudget) {
      retained.unshift(rawHistory[index]);
      retainedTokens = nextTokens;
      continue;
    }

    if (retained.length === 0 && rawHistory[index]?.prompt) {
      const promptTokens = estimateStringTokens(llm, rawHistory[index].prompt);
      if (promptTokens <= budgets.targetTokens) {
        cannotReachTargetReason =
          "latest_assistant_response_folded_to_meet_target";
      } else {
        cannotReachTargetReason = "latest_user_message_exceeds_target";
      }
    }
    break;
  }

  const retainedIds = new Set(retained.map((chat) => chat.id));
  const compactable = rawHistory.filter((chat) => !retainedIds.has(chat.id));
  if (budgets.estimatedSummaryBudget > budgets.targetTokens) {
    cannotReachTargetReason = "minimum_summary_budget_exceeds_target";
  }

  return {
    compactable,
    retained,
    retainedTokens,
    targetCompactableMessageCount: compactable.length,
    retainedRecentMessageCount: retained.length,
    cannotReachTargetReason,
  };
}

function compactionInputTokens(llm, previousState = "", chats = []) {
  return (
    estimateStringTokens(llm, String(previousState || "")) +
    estimateStringTokens(
      llm,
      chats.map(formatChatForSummary).join("\n\n---\n\n")
    )
  );
}

function chunkChatsForCompaction({
  llm,
  previousSummary = "",
  previousState = "",
  chats = [],
  compactionInputLimit,
} = {}) {
  const reserve = Math.max(4_000, Math.floor(compactionInputLimit * 0.05));
  const chunkLimit = Math.max(1, compactionInputLimit - reserve);
  const chunks = [];
  let chunk = [];
  let chunkTokens = estimateStringTokens(
    llm,
    previousState || normalizeCompactionSummary(previousSummary)
  );

  for (const chat of chats) {
    const chatTokens = estimateStringTokens(llm, formatChatForSummary(chat));
    if (chunk.length > 0 && chunkTokens + chatTokens > chunkLimit) {
      chunks.push(chunk);
      chunk = [];
      chunkTokens = 0;
    }
    chunk.push(chat);
    chunkTokens += chatTokens;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks.length ? chunks : [[]];
}

function truncateChatsForCompaction({
  llm,
  previousSummary = "",
  previousState = "",
  chats = [],
  compactionInputLimit,
} = {}) {
  const retained = [];
  let tokens = estimateStringTokens(
    llm,
    previousState || normalizeCompactionSummary(previousSummary)
  );
  for (const chat of chats) {
    const chatTokens = estimateStringTokens(llm, formatChatForSummary(chat));
    if (retained.length > 0 && tokens + chatTokens > compactionInputLimit)
      break;
    retained.push(chat);
    tokens += chatTokens;
  }
  return retained;
}

function compactionMetadata(compaction = null) {
  if (!compaction) return null;
  const metadata = safeJsonParse(compaction.metadata_json, {});
  return {
    id: compaction.id,
    summary_format: compaction.summary_format,
    hasCapsule: Boolean(
      parseConversationCapsule(compaction.capsule_json, null)
    ),
    covered_from_chat_id: compaction.covered_from_chat_id,
    covered_to_chat_id: compaction.covered_to_chat_id,
    covered_message_count: compaction.covered_message_count,
    token_before: compaction.token_before,
    token_after: compaction.token_after,
    metadata,
    reason: compaction.reason,
    created_at: compaction.created_at,
    updated_at: compaction.updated_at,
  };
}

function formatChatForSummary(chat = {}) {
  let responseText = "";
  try {
    responseText = JSON.parse(chat.response || "{}")?.text || "";
  } catch {}
  return `Chat #${chat.id}
User:
${chat.prompt}

Assistant:
${responseText}`;
}

function exactValueCandidateText(chat = {}) {
  let responseText = "";
  try {
    responseText = JSON.parse(chat.response || "{}")?.text || "";
  } catch {}
  return cleanText(`${chat.prompt || ""}\n${responseText || ""}`, 20_000);
}

function isTransientTestText(text = "") {
  const normalized = cleanText(text, 800);
  if (!normalized) return false;
  return (
    normalized.length < 600 &&
    /(只回复|回复\s*[“"'`]?ok|第\s*\d+\s*轮|缓存.*测试|cache.*test|一致性测试|完成即可|只需回复)/i.test(
      normalized
    )
  );
}

function extractDurableTopicHints(chats = [], { limit = 12 } = {}) {
  const hints = [];
  const seen = new Set();
  for (const chat of chats.slice().reverse()) {
    const text = exactValueCandidateText(chat);
    if (!text || isTransientTestText(text)) continue;
    const hasSignal =
      text.length >= 160 ||
      /(红色资本|中国|金融|银行|财政部|人民银行|汇金|朱镕基|房地产|股市|社保|人口|债务|资本|改革开放)/.test(
        text
      );
    if (!hasSignal) continue;
    const snippet = cleanText(text.slice(0, 420), 420);
    if (!snippet || seen.has(snippet)) continue;
    seen.add(snippet);
    hints.unshift(`Chat #${chat.id}: ${snippet}`);
    if (hints.length >= limit) break;
  }
  return hints;
}

function extractExactValueCandidates(
  chats = [],
  { limit = 90, recentLimit = 30 } = {}
) {
  const candidates = [];
  const seen = new Set();
  const recentChats = chats.slice(-Math.max(1, recentLimit));
  const scanChats = [...recentChats, ...chats];
  const pattern =
    /(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|(?:[A-Z][A-Z0-9_]{2,}(?:=[A-Za-z0-9_.:/-]+)?)|(?:\d{4}(?:[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?)?)|(?:\d+(?:\.\d+)?\s*(?:万亿|亿元|亿|万美元|亿美元|人民币|美元|%|％|tokens?|token|TTL|次|轮|条|个|名|页|年|月|日|倍|MB|GB|KB|ms|s|秒|分钟|小时))|(?:财政部|人民银行|央行|国务院|证监会|银监会|建设银行|工商银行|中国银行|资产管理公司)|(?:[\u4e00-\u9fff]{2,12}(?:银行|公司|政府))|(?:[\u4e00-\u9fff]{2,4}(?:时期|时代|说|认为|提出|指出|主导))/gi;

  for (const chat of scanChats) {
    const text = exactValueCandidateText(chat);
    if (!text) continue;
    for (const match of text.matchAll(pattern)) {
      const value = cleanText(match[0], 120);
      if (!value) continue;
      const key = `${chat.id}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const start = Math.max(0, match.index - 48);
      const end = Math.min(text.length, match.index + value.length + 48);
      candidates.push(
        `Chat #${chat.id}: ${cleanText(text.slice(start, end), 220)}`
      );
      if (candidates.length >= limit) return candidates;
    }
  }
  return candidates;
}

function buildCapsulePrompt({
  previousCapsule = null,
  previousSummary = null,
  chats = [],
  compactInstructions = "",
  summaryTokenBudget = null,
  coveredToChatId = null,
} = {}) {
  const priorCapsule = previousCapsule ? capsuleJson(previousCapsule) : "未知";
  const legacyPrior = normalizeCompactionSummary(previousSummary);
  const exactValueCandidates = extractExactValueCandidates(chats);
  const durableTopicHints = extractDurableTopicHints(chats);
  return `Create a Conversation State Capsule for this Athena thread.

Rules:
- Output strict JSON only. No Markdown, commentary, code fences, reasoning, or hidden-thinking text.
- The JSON must match exactly these keys: topic, currentGoal, confirmedFacts, confirmedDecisions, openQuestions, temporaryContext, recentDirection, architectureDecisions, generatedAt, coveredToChatId.
- Compress conversation state, not knowledge content. Do not summarize all chat content.
- Do not invent facts. If a detail is uncertain or only inferred by the assistant, omit it.
- Only store facts and decisions confirmed by the user, codebase, tool output, or accepted prior capsule.
- This fold covers ${chats.length} raw chat records. For a substantial domain-analysis thread, do not return an ultra-short capsule. Preserve enough confirmed state for continuity: normally 8-20 concise confirmedFacts when the covered history contains that much confirmed analytical state.
- For book/history/finance analysis threads, confirmedFacts may include compact factual anchors, user-accepted interpretations, key people, institutions, dates, amounts, and ratios. This is allowed when those anchors are needed to continue the user's reasoning.
- If exact value candidates contain confirmed, central historical data or user-emphasized numbers, preserve the most important ones with their meaning. Do not omit all precise numbers from a long analytical thread.
- Do not let transient test instructions become the topic, currentGoal, or recentDirection. Ignore echo tests, cache tests, numbered test rounds, "只回复/only reply" prompts, and one-off completion checks unless the whole thread is actually about testing. At most put still-relevant transient test state in temporaryContext with TTL.
- If there is durable domain analysis plus transient tests, choose the durable domain topic/currentGoal and preserve the important confirmed analytical state.
- Preserve concrete file paths, function names, table names, config names, route names, user constraints, and technical boundaries only when they are confirmed and important to the current state.
- This is deterministic thread state, not RAG memory and not a citation source.
- Do not store rejected plans, failed attempts, wrong conclusions, temporary guesses, verbose explanations, ephemeral RAG context, citations, pinned docs, parsed files, graph context, attachments, or tool output transcripts unless a durable conclusion from them is necessary for the task state.
- Treat persistent context such as system prompt, workspace prompt, and project rules as re-injected context. Do not copy them into the compact state unless the user explicitly made them part of the task.
- Analyze every number mentioned in the conversation. Preserve exact numbers only when they are confirmed and important to the current goal, such as ports, versions, IDs, TTLs, token budgets, ratios, dates, limits, config values, database field values, thresholds, and user-stated numeric requirements.
- Pay special attention to exact historical data, years, money amounts, percentages, institutions, and people that the user relies on for the current analysis. Preserve the exact value and its meaning when confirmed.
- Do not preserve temporary error counts, transient test numbers, estimates, or numbers that belong only to rejected approaches.
- If a number is a user requirement, system boundary, architecture constraint, or accepted decision, place it in confirmedFacts, confirmedDecisions, or architectureDecisions.
- temporaryContext items must be objects with text and expiresAfterCompactions. Use expiresAfterCompactions: 3 for new temporary state unless the user specified another confirmed TTL.
- generatedAt must be an ISO timestamp. coveredToChatId must be "${coveredToChatId ?? ""}".
${summaryTokenBudget ? `- Keep the capsule within about ${summaryTokenBudget} tokens while preserving state quality.` : ""}
${compactInstructions ? `- Additional compaction instructions: ${compactInstructions}` : ""}

Required JSON shape:
{
  "topic": "",
  "currentGoal": "",
  "confirmedFacts": [],
  "confirmedDecisions": [],
  "openQuestions": [],
  "temporaryContext": [
    { "text": "", "expiresAfterCompactions": 3 }
  ],
  "recentDirection": "",
  "architectureDecisions": [],
  "generatedAt": "",
  "coveredToChatId": ""
}

Previous Conversation State Capsule, if any:
${priorCapsule}

Legacy Thread Memory Summary fallback, if any:
${legacyPrior || "未知"}

Durable topic hints to prefer over transient tests:
${durableTopicHints.length ? durableTopicHints.join("\n") : "无"}

Recent exact value candidates to evaluate carefully:
${exactValueCandidates.length ? exactValueCandidates.join("\n") : "无"}

Raw chat history to fold into the capsule:
${chats.map(formatChatForSummary).join("\n\n---\n\n")}`;
}

function buildTightenCapsulePrompt({ capsule = null, maxSummaryTokens }) {
  return `Tighten this Conversation State Capsule without losing confirmed state or precise important numbers.

Rules:
- Output strict JSON only.
- Preserve confirmed facts, confirmed decisions, open questions, architecture decisions, current goal, recent direction, and precise important numbers.
- Drop verbosity, duplicate items, stale temporary context, and non-essential detail.
- Do not invent facts.
- Keep it within about ${maxSummaryTokens} tokens.

Current capsule:
${capsuleJson(capsule || blankConversationCapsule())}`;
}

function buildRepairCapsulePrompt({ rawOutput = "", coveredToChatId = null }) {
  return `Repair this Conversation State Capsule output into valid strict JSON.

Rules:
- Output strict JSON only.
- Preserve only the confirmed state already present in the raw output.
- Do not add new facts.
- Use exactly these keys: topic, currentGoal, confirmedFacts, confirmedDecisions, openQuestions, temporaryContext, recentDirection, architectureDecisions, generatedAt, coveredToChatId.
- temporaryContext must be an array of objects with text and expiresAfterCompactions.
- coveredToChatId must be "${coveredToChatId ?? ""}".

Raw output:
${String(rawOutput || "").slice(0, 120_000)}`;
}

function capsuleLooksTooSparse(capsule = null, chats = []) {
  const normalized = normalizeConversationCapsule(capsule);
  if (chats.length < 50) return false;
  if (normalized.confirmedFacts.length >= 8) return false;
  return (
    extractDurableTopicHints(chats, { limit: 6 }).length >= 3 ||
    extractExactValueCandidates(chats, { limit: 20 }).length >= 10
  );
}

function buildExpandSparseCapsulePrompt({
  capsule = null,
  chats = [],
  maxSummaryTokens = null,
  coveredToChatId = null,
}) {
  const exactValueCandidates = extractExactValueCandidates(chats, {
    limit: 120,
  });
  const durableTopicHints = extractDurableTopicHints(chats, { limit: 16 });
  return `The current Conversation State Capsule is too sparse for this long thread. Expand it into valid strict JSON without inventing facts.

Rules:
- Output strict JSON only.
- Keep the same schema keys.
- Preserve the durable topic/current goal, not transient cache tests or echo tests.
- Add concise confirmedFacts for central, confirmed analytical state from the covered history.
- Preserve important exact dates, amounts, ratios, people, institutions, and user-accepted interpretations with their meaning.
- Do not add rejected ideas, failed attempts, temporary guesses, or verbose explanations.
- Aim for 8-20 confirmedFacts when supported by the evidence.
- coveredToChatId must be "${coveredToChatId ?? ""}".
${maxSummaryTokens ? `- Keep the capsule within about ${maxSummaryTokens} tokens.` : ""}

Current sparse capsule:
${capsuleJson(capsule || blankConversationCapsule())}

Durable topic hints:
${durableTopicHints.length ? durableTopicHints.join("\n") : "无"}

Exact value candidates:
${exactValueCandidates.length ? exactValueCandidates.join("\n") : "无"}`;
}

function capsuleToMarkdownSummary(capsule = null) {
  const normalized = normalizeConversationCapsule(capsule);
  const lines = [
    "# Conversation State Capsule",
    "## 当前讨论主题",
    normalized.topic || "未知",
    "## 当前目标",
    normalized.currentGoal || "未知",
    "## 已确认事实",
    ...(normalized.confirmedFacts.length
      ? normalized.confirmedFacts.map((item) => `- ${item}`)
      : ["- 未知"]),
    "## 已确认决策",
    ...(normalized.confirmedDecisions.length
      ? normalized.confirmedDecisions.map((item) => `- ${item}`)
      : ["- 未知"]),
    "## 未解决问题",
    ...(normalized.openQuestions.length
      ? normalized.openQuestions.map((item) => `- ${item}`)
      : ["- 未知"]),
    "## 临时上下文",
    ...(normalized.temporaryContext.length
      ? normalized.temporaryContext.map(
          (item) =>
            `- ${item.text} (expiresAfterCompactions=${item.expiresAfterCompactions})`
        )
      : ["- 无"]),
    "## 最近方向",
    normalized.recentDirection || "未知",
    "## 架构级决策",
    ...(normalized.architectureDecisions.length
      ? normalized.architectureDecisions.map((item) => `- ${item}`)
      : ["- 未知"]),
  ];
  return lines.join("\n");
}

function trimCapsuleToTokenBudget(
  llm,
  capsule = null,
  maxSummaryTokens = 2500
) {
  const normalized = normalizeConversationCapsule(capsule);
  const tokenManager = new TokenManager(llm?.model);
  const withinBudget = (candidate) =>
    tokenManager.countFromString(capsuleJson(candidate)) <= maxSummaryTokens;
  if (withinBudget(normalized)) return normalized;

  const trimmed = { ...normalized };
  for (const field of [
    "temporaryContext",
    "openQuestions",
    "confirmedFacts",
    "confirmedDecisions",
    "architectureDecisions",
  ]) {
    while (Array.isArray(trimmed[field]) && trimmed[field].length > 0) {
      trimmed[field] = trimmed[field].slice(0, -1);
      if (withinBudget(trimmed)) return normalizeConversationCapsule(trimmed);
    }
  }
  return normalizeConversationCapsule({
    ...trimmed,
    topic: trimmed.topic,
    currentGoal: trimmed.currentGoal,
    recentDirection: trimmed.recentDirection,
  });
}

async function generateCapsule({
  workspace,
  user = null,
  previousCapsule = null,
  previousSummary,
  chats,
  llm = null,
  maxSummaryTokens = null,
  compactInstructions = "",
  coveredToChatId = null,
}) {
  const capsuleLLM = llm || resolveCompactionLLM(workspace).llm;
  const systemPrompt =
    "You produce deterministic Conversation State Capsule JSON for long-running Athena chat threads. Return strict JSON only, with no reasoning or hidden-thinking text.";
  const userPrompt = buildCapsulePrompt({
    previousCapsule,
    previousSummary,
    chats,
    compactInstructions,
    summaryTokenBudget: maxSummaryTokens,
    coveredToChatId,
  });
  const messages = await capsuleLLM.compressMessages(
    {
      systemPrompt,
      userPrompt,
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const result = await capsuleLLM.getChatCompletion(messages, {
    temperature: 0,
    user,
    responseFormat: { type: "json_object" },
  });
  let parsed = parseConversationCapsule(result?.textResponse || "", null);
  if (!parsed) {
    parsed = await repairCapsuleOutput({
      llm: capsuleLLM,
      user,
      rawOutput: result?.textResponse || "",
      coveredToChatId,
    });
  }
  if (!parsed) throw new Error("invalid_conversation_capsule_json");
  const normalized = normalizeConversationCapsule(parsed, {
    generatedAt: new Date().toISOString(),
    coveredToChatId,
  });
  const capsule = maxSummaryTokens
    ? trimCapsuleToTokenBudget(capsuleLLM, normalized, maxSummaryTokens)
    : normalized;
  if (capsuleLooksTooSparse(capsule, chats)) {
    const expanded = await expandSparseCapsule({
      llm: capsuleLLM,
      user,
      capsule,
      chats,
      maxSummaryTokens,
      coveredToChatId,
    });
    if (expanded && !capsuleLooksTooSparse(expanded, chats)) {
      const nextCapsule = maxSummaryTokens
        ? trimCapsuleToTokenBudget(capsuleLLM, expanded, maxSummaryTokens)
        : normalizeConversationCapsule(expanded, {
            generatedAt: new Date().toISOString(),
            coveredToChatId,
          });
      return {
        llm: capsuleLLM,
        capsule: nextCapsule,
        capsuleJson: capsuleJson(nextCapsule),
        summary: capsuleToMarkdownSummary(nextCapsule),
      };
    }
  }
  return {
    llm: capsuleLLM,
    capsule,
    capsuleJson: capsuleJson(capsule),
    summary: capsuleToMarkdownSummary(capsule),
  };
}

async function expandSparseCapsule({
  llm,
  user = null,
  capsule = null,
  chats = [],
  maxSummaryTokens = null,
  coveredToChatId = null,
}) {
  const systemPrompt =
    "You expand sparse Conversation State Capsule JSON for long Athena threads. Return strict JSON only.";
  const messages = await llm.compressMessages(
    {
      systemPrompt,
      userPrompt: buildExpandSparseCapsulePrompt({
        capsule,
        chats,
        maxSummaryTokens,
        coveredToChatId,
      }),
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const result = await llm.getChatCompletion(messages, {
    temperature: 0,
    user,
    responseFormat: { type: "json_object" },
  });
  let parsed = parseConversationCapsule(result?.textResponse || "", null);
  if (!parsed) {
    parsed = await repairCapsuleOutput({
      llm,
      user,
      rawOutput: result?.textResponse || "",
      coveredToChatId,
    });
  }
  return parsed
    ? normalizeConversationCapsule(parsed, {
        generatedAt: new Date().toISOString(),
        coveredToChatId,
      })
    : null;
}

async function repairCapsuleOutput({
  llm,
  user = null,
  rawOutput = "",
  coveredToChatId = null,
}) {
  if (!rawOutput) return null;
  const systemPrompt =
    "You repair Conversation State Capsule JSON. Return strict JSON only.";
  const messages = await llm.compressMessages(
    {
      systemPrompt,
      userPrompt: buildRepairCapsulePrompt({ rawOutput, coveredToChatId }),
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const result = await llm.getChatCompletion(messages, {
    temperature: 0,
    user,
    responseFormat: { type: "json_object" },
  });
  return parseConversationCapsule(result?.textResponse || "", null);
}

async function tightenCapsule({ llm, user = null, capsule, maxSummaryTokens }) {
  const systemPrompt =
    "You tighten Conversation State Capsule JSON. Return strict JSON only, no hidden thinking.";
  const messages = await llm.compressMessages(
    {
      systemPrompt,
      userPrompt: buildTightenCapsulePrompt({ capsule, maxSummaryTokens }),
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const result = await llm.getChatCompletion(messages, {
    temperature: 0,
    user,
    responseFormat: { type: "json_object" },
  });
  let parsed = parseConversationCapsule(result?.textResponse || "", null);
  if (!parsed) {
    parsed = await repairCapsuleOutput({
      llm,
      user,
      rawOutput: result?.textResponse || "",
      coveredToChatId: capsule?.coveredToChatId || null,
    });
  }
  if (!parsed) return trimCapsuleToTokenBudget(llm, capsule, maxSummaryTokens);
  return trimCapsuleToTokenBudget(llm, parsed, maxSummaryTokens);
}

async function compactThread({
  workspace,
  user = null,
  thread = null,
  apiSessionId = null,
  force = false,
  reason = "manual",
  keepRecentMessages = null,
  mode = "target",
  targetRatio = null,
  compactInstructions = "",
} = {}) {
  const config = getConfig();
  if (!config.enabled && !force)
    return { success: false, error: "thread_compaction_disabled" };

  const scope = buildCompactionScope({ workspace, user, thread, apiSessionId });
  const key = scopeKey(scope);
  if (!force && inFlightCompactions.has(key)) {
    return { success: true, skipped: true, reason: "already_in_progress" };
  }

  inFlightCompactions.add(key);
  try {
    const compactionInfo = resolveCompactionLLM(workspace);
    const compactionLLM = compactionInfo.llm;
    const isTargetMode = mode === "target";
    const targetMode = reason === "auto" ? "auto" : "manual";
    const budgets = resolveTargetBudgets({
      workspace,
      chatLLM: compactionLLM,
      compactionLLM,
      compactionInfo,
      targetRatio,
      mode: targetMode,
    });
    const candidateSet = await compactionCandidates(
      scope,
      isTargetMode ? 0 : keepRecentMessages || config.keepRecentMessages
    );
    const targetPlan = isTargetMode
      ? targetCompactionPlan({
          llm: compactionLLM,
          rawHistory: candidateSet.rawHistory,
          budgets,
        })
      : {
          compactable: candidateSet.compactable,
          retained: candidateSet.rawHistory.slice(
            candidateSet.compactable.length
          ),
          retainedTokens: estimateHistoryTokens(
            compactionLLM,
            candidateSet.rawHistory.slice(candidateSet.compactable.length)
          ),
          targetCompactableMessageCount: candidateSet.compactable.length,
          retainedRecentMessageCount:
            candidateSet.rawHistory.length - candidateSet.compactable.length,
          cannotReachTargetReason: null,
        };
    const { latest } = candidateSet;
    let compactable = targetPlan.compactable;

    if (compactable.length === 0) {
      return {
        success: true,
        compactionId: null,
        coveredMessageCount: 0,
        tokenBefore: 0,
        tokenAfter: 0,
        skipped: true,
        reason: "not_enough_history",
      };
    }

    let rollingCompactionUsed = false;
    let cannotReachTargetReason = targetPlan.cannotReachTargetReason;
    let previousCapsule = parseConversationCapsule(latest?.capsule_json, null);
    if (previousCapsule)
      previousCapsule = decrementTemporaryContextTtl(previousCapsule);
    let previousSummary = previousCapsule
      ? ""
      : normalizeCompactionSummary(latest?.summary || null);
    let priorState = previousCapsule
      ? capsuleJson(previousCapsule)
      : previousSummary;
    let capsule = null;
    let capsuleJsonString = "";
    let summary = "";
    const maxSummaryTokens = isTargetMode
      ? budgets.estimatedSummaryBudget
      : config.maxSummaryTokens;

    const inputTokens = compactionInputTokens(
      compactionLLM,
      priorState,
      compactable
    );
    if (isTargetMode && inputTokens > budgets.compactionInputLimit) {
      try {
        const chunks = chunkChatsForCompaction({
          llm: compactionLLM,
          previousSummary,
          previousState: priorState,
          chats: compactable,
          compactionInputLimit: budgets.compactionInputLimit,
        });
        rollingCompactionUsed = chunks.length > 1;
        for (const chunk of chunks) {
          const generated = await generateCapsule({
            workspace,
            user,
            llm: compactionLLM,
            previousCapsule,
            previousSummary,
            chats: chunk,
            maxSummaryTokens,
            compactInstructions,
            coveredToChatId: chunk.at(-1)?.id || null,
          });
          previousCapsule = generated.capsule;
          previousSummary = "";
          priorState = generated.capsuleJson;
        }
        capsule = previousCapsule;
        capsuleJsonString = priorState;
        summary = capsuleToMarkdownSummary(capsule);
      } catch (error) {
        console.warn(
          "[ThreadCompaction] rolling compaction failed; truncating input",
          error.message
        );
        cannotReachTargetReason = "input_exceeded_compaction_window_truncated";
        const truncated = truncateChatsForCompaction({
          llm: compactionLLM,
          previousSummary,
          previousState: priorState,
          chats: compactable,
          compactionInputLimit: budgets.compactionInputLimit,
        });
        compactable = truncated;
        const generated = await generateCapsule({
          workspace,
          user,
          llm: compactionLLM,
          previousCapsule,
          previousSummary,
          chats: truncated,
          maxSummaryTokens,
          compactInstructions,
          coveredToChatId: truncated.at(-1)?.id || null,
        });
        capsule = generated.capsule;
        capsuleJsonString = generated.capsuleJson;
        summary = generated.summary;
      }
    } else {
      const generated = await generateCapsule({
        workspace,
        user,
        llm: compactionLLM,
        previousCapsule,
        previousSummary,
        chats: compactable,
        maxSummaryTokens,
        compactInstructions,
        coveredToChatId: compactable.at(-1)?.id || null,
      });
      capsule = generated.capsule;
      capsuleJsonString = generated.capsuleJson;
      summary = generated.summary;
    }
    if (!capsuleJsonString) throw new Error("empty_conversation_capsule");

    let tokenAfter = estimateStringTokens(compactionLLM, capsuleJsonString);
    let capsuleInjectionTokens = estimateStringTokens(
      compactionLLM,
      conversationCapsuleBlock(capsule)
    );
    let usedTokensAfterCompact =
      capsuleInjectionTokens + targetPlan.retainedTokens;
    let targetReached =
      !isTargetMode || usedTokensAfterCompact <= budgets.targetTokens;

    if (
      isTargetMode &&
      !targetReached &&
      budgets.estimatedSummaryBudget <= budgets.targetTokens &&
      tokenAfter > config.targetMinSummaryTokens
    ) {
      capsule = await tightenCapsule({
        llm: compactionLLM,
        user,
        capsule,
        maxSummaryTokens: Math.max(
          config.targetMinSummaryTokens,
          Math.min(tokenAfter - 1, budgets.estimatedSummaryBudget)
        ),
      });
      capsuleJsonString = capsuleJson(capsule);
      summary = capsuleToMarkdownSummary(capsule);
      tokenAfter = estimateStringTokens(compactionLLM, capsuleJsonString);
      capsuleInjectionTokens = estimateStringTokens(
        compactionLLM,
        conversationCapsuleBlock(capsule)
      );
      usedTokensAfterCompact =
        capsuleInjectionTokens + targetPlan.retainedTokens;
      targetReached = usedTokensAfterCompact <= budgets.targetTokens;
    }

    if (
      isTargetMode &&
      !targetReached &&
      budgets.estimatedSummaryBudget > budgets.targetTokens
    ) {
      cannotReachTargetReason = "minimum_summary_budget_exceeds_target";
    }

    const tokenBefore = estimateHistoryTokens(compactionLLM, compactable);
    const metadata = isTargetMode
      ? {
          mode: "target",
          provider: compactionInfo.provider,
          model: compactionInfo.model,
          compactionInputLimit: budgets.compactionInputLimit,
          chatInjectionLimit: budgets.chatInjectionLimit,
          targetBase: budgets.targetBase,
          targetReached,
          targetRatio: budgets.targetRatio,
          targetTokens: budgets.targetTokens,
          estimatedSummaryBudget: budgets.estimatedSummaryBudget,
          recentRawBudget: budgets.recentRawBudget,
          usedTokensAfterCompact,
          ratioAfterCompact:
            budgets.chatInjectionLimit > 0
              ? usedTokensAfterCompact / budgets.chatInjectionLimit
              : 0,
          retainedRecentMessageCount: targetPlan.retainedRecentMessageCount,
          targetCompactableMessageCount:
            targetPlan.targetCompactableMessageCount,
          cannotReachTargetReason,
          rollingCompactionUsed,
          providerFallbackUsed: compactionInfo.fallbackUsed,
        }
      : { mode: "keep_recent" };

    const compaction = await WorkspaceChatCompaction.create({
      ...scope,
      summary,
      summary_format: WorkspaceChatCompaction.CAPSULE_FORMAT,
      capsule_json: capsuleJsonString,
      covered_chat_ids: JSON.stringify(compactable.map((chat) => chat.id)),
      covered_from_chat_id:
        latest?.covered_from_chat_id || compactable[0]?.id || null,
      covered_to_chat_id: compactable.at(-1)?.id || null,
      covered_message_count:
        (latest?.covered_message_count || 0) + compactable.length,
      token_before: tokenBefore,
      token_after: tokenAfter,
      metadata_json: JSON.stringify(metadata),
      reason,
    });
    invalidateThreadCompactionStatus({
      workspace,
      user,
      thread,
      apiSessionId,
    });

    recentAutoCompactions.set(key, Date.now());
    if (
      isTargetMode &&
      metadata.ratioAfterCompact > MANUAL_COMPACT_RATIO &&
      cannotReachTargetReason
    ) {
      recentTargetFailures.set(key, {
        reason: cannotReachTargetReason,
        at: Date.now(),
      });
    }
    return {
      success: true,
      compaction,
      compactionId: compaction?.id || null,
      coveredMessageCount: compactable.length,
      tokenBefore,
      tokenAfter,
      ...metadata,
    };
  } catch (error) {
    console.warn("[ThreadCompaction] compaction failed", error.message);
    return {
      success: false,
      error: error.message,
      compactionId: null,
      coveredMessageCount: 0,
      tokenBefore: 0,
      tokenAfter: 0,
    };
  } finally {
    inFlightCompactions.delete(key);
  }
}

async function getThreadCompactionStatus({
  workspace,
  user = null,
  thread = null,
  apiSessionId = null,
  historyRevision = undefined,
} = {}) {
  const scope = buildCompactionScope({ workspace, user, thread, apiSessionId });
  const revision =
    historyRevision === undefined
      ? thread?.historyRevision ?? "unknown"
      : historyRevision;
  const key = `${scopeKey(scope)}:${String(revision)}`;
  const now = Date.now();
  trimCompactionStatusCache(now);
  const cached = compactionStatusCache.get(key);
  if (cached?.promise) return cached.promise;
  if (cached && cached.expiresAt > now) {
    compactionStatusCache.delete(key);
    compactionStatusCache.set(key, cached);
    return cached.value;
  }

  let statusPromise;
  statusPromise = computeThreadCompactionStatus({
    workspace,
    user,
    thread,
    apiSessionId,
    scope,
  })
    .then((value) => {
      if (compactionStatusCache.get(key)?.promise === statusPromise) {
        compactionStatusCache.set(key, {
          value,
          promise: null,
          expiresAt: Date.now() + COMPACTION_STATUS_TTL_MS,
        });
      }
      return value;
    })
    .catch((error) => {
      if (compactionStatusCache.get(key)?.promise === statusPromise) {
        compactionStatusCache.delete(key);
      }
      throw error;
    });
  compactionStatusCache.set(key, {
    value: null,
    promise: statusPromise,
    expiresAt: Number.POSITIVE_INFINITY,
  });
  return statusPromise;
}

async function computeThreadCompactionStatus({ workspace, scope } = {}) {
  const config = getConfig();
  const compactionInfo = resolveCompactionLLM(workspace);
  const compactionLLM = compactionInfo.llm;
  const budgets = resolveTargetBudgets({
    workspace,
    chatLLM: compactionLLM,
    compactionLLM,
    compactionInfo,
    mode: "manual",
  });
  const latest = await latestCompaction(scope);
  const rawHistory = await WorkspaceChatCompaction.where(scope, {
    afterChatId: latest?.covered_to_chat_id || null,
    limit: null,
    orderBy: "asc",
  });
  const keepCount = Math.max(1, Number(config.keepRecentMessages || 10));
  const compactable =
    rawHistory.length > keepCount ? rawHistory.slice(0, -keepCount) : [];
  const targetPlan = targetCompactionPlan({
    llm: compactionLLM,
    rawHistory,
    budgets,
  });

  const summaryTokens = latest
    ? estimateStringTokens(compactionLLM, compactionContextBlock(latest))
    : 0;
  const recentHistoryTokens = estimateHistoryTokens(compactionLLM, rawHistory);
  const usedTokens = summaryTokens + recentHistoryTokens;
  const limitTokens = budgets.chatInjectionLimit;
  const ratio = limitTokens > 0 ? usedTokens / limitTokens : 0;
  const latestMetadata = safeJsonParse(latest?.metadata_json, {});
  const latestTargetReason =
    latestMetadata.targetBase === "chat_window"
      ? null
      : latestMetadata.cannotReachTargetReason || null;
  const projectedUsedTokensAfterCompact =
    budgets.estimatedSummaryBudget + targetPlan.retainedTokens;
  const projectedRatioAfterCompact =
    limitTokens > 0 ? projectedUsedTokensAfterCompact / limitTokens : 0;

  return {
    enabled: config.enabled,
    autoEnabled: config.autoEnabled,
    usedTokens,
    limitTokens,
    ratio,
    compactionProvider: compactionInfo.provider,
    compactionModel: compactionInfo.model,
    summaryTokens,
    recentHistoryTokens,
    compactableMessageCount: compactable.length,
    targetRatio: budgets.targetRatio,
    targetTokens: budgets.targetTokens,
    targetBase: budgets.targetBase,
    compactionInputLimit: budgets.compactionInputLimit,
    chatInjectionLimit: budgets.chatInjectionLimit,
    estimatedSummaryBudget: budgets.estimatedSummaryBudget,
    recentRawBudget: budgets.recentRawBudget,
    targetCompactableMessageCount: targetPlan.targetCompactableMessageCount,
    projectedUsedTokensAfterCompact,
    projectedRatioAfterCompact,
    retainedRecentMessageCount: targetPlan.retainedRecentMessageCount,
    cannotReachTargetReason:
      targetPlan.cannotReachTargetReason || latestTargetReason,
    latestTargetResult:
      latestMetadata.mode === "target" &&
      latestMetadata.targetBase !== "chat_window"
        ? {
            targetReached: latestMetadata.targetReached,
            targetRatio: latestMetadata.targetRatio,
            targetTokens: latestMetadata.targetTokens,
            usedTokensAfterCompact: latestMetadata.usedTokensAfterCompact,
            ratioAfterCompact: latestMetadata.ratioAfterCompact,
            cannotReachTargetReason: latestMetadata.cannotReachTargetReason,
          }
        : null,
    latestCompaction: compactionMetadata(latest),
    canCompactAtRatio: MANUAL_COMPACT_RATIO,
    excludes: [
      "RAG context",
      "pinned docs",
      "parsed files",
      "graph context",
      "current attachments",
    ],
  };
}

function estimatePromptTokens({
  llm,
  systemPrompt = "",
  compaction = null,
  chatHistory = [],
  userPrompt = "",
  contextTexts = [],
  attachments = [],
} = {}) {
  try {
    const messages = llm.constructPrompt({
      systemPrompt,
      userPrompt,
      contextTexts: contextTextsWithCompaction(contextTexts, compaction),
      chatHistory,
      attachments,
    });
    return new TokenManager(llm.model).statsFrom(messages);
  } catch {
    // Some providers have custom prompt shapes. If full-prompt estimation is not
    // available, auto compaction falls back to history pressure and the existing
    // messageArrayCompressor remains the final token safety net.
    return new TokenManager(llm?.model).statsFrom(chatHistory);
  }
}

async function maybeAutoCompact({
  workspace,
  user = null,
  thread = null,
  apiSessionId = null,
  llm,
  systemPrompt = "",
  chatHistory = [],
  userPrompt = "",
  contextTexts = [],
  attachments = [],
  compaction = null,
  keepRecentMessages = null,
  historyPressureLimit = null,
  phase = "prompt_assembly",
} = {}) {
  const config = getConfig();
  if (!config.enabled || !config.autoEnabled)
    return { success: true, skipped: true };
  if (phase !== "turn_end")
    return { success: true, skipped: true, reason: "not_turn_end" };

  const scope = buildCompactionScope({ workspace, user, thread, apiSessionId });
  const key = scopeKey(scope);
  if (inFlightCompactions.has(key))
    return { success: true, skipped: true, reason: "already_in_progress" };

  const lastAutoAt = recentAutoCompactions.get(key) || 0;
  if (Date.now() - lastAutoAt < AUTO_COOLDOWN_MS)
    return { success: true, skipped: true, reason: "cooldown" };
  if (compaction?.created_at) {
    const latestCreatedAt = new Date(compaction.created_at).getTime();
    if (Number.isFinite(latestCreatedAt)) {
      const ageMs = Date.now() - latestCreatedAt;
      if (ageMs >= 0 && ageMs < AUTO_COOLDOWN_MS)
        return { success: true, skipped: true, reason: "recent_compaction" };
    }
  }
  const latest = compaction || (await latestCompaction(scope));
  const latestMetadata = safeJsonParse(latest?.metadata_json, {});
  const recentFailure = recentTargetFailures.get(key);
  if (
    latestMetadata.mode === "target" &&
    Number(latestMetadata.ratioAfterCompact || 0) > MANUAL_COMPACT_RATIO &&
    latestMetadata.cannotReachTargetReason
  ) {
    const latestCreatedAt = new Date(latest?.created_at).getTime();
    if (
      Number.isFinite(latestCreatedAt) &&
      Date.now() - latestCreatedAt < AUTO_COOLDOWN_MS
    ) {
      return {
        success: true,
        skipped: true,
        reason: "target_compaction_recently_unreachable",
        cannotReachTargetReason: latestMetadata.cannotReachTargetReason,
      };
    }
  }
  if (
    recentFailure?.reason &&
    Date.now() - recentFailure.at < AUTO_COOLDOWN_MS
  ) {
    return {
      success: true,
      skipped: true,
      reason: "target_compaction_recently_unreachable",
      cannotReachTargetReason: recentFailure.reason,
    };
  }

  const promptTokens = estimatePromptTokens({
    llm,
    systemPrompt,
    compaction,
    chatHistory,
    userPrompt,
    contextTexts,
    attachments,
  });
  const triggerTokens = llm.promptWindowLimit() * config.triggerRatio;
  const chatPairs = chatHistory.length / 2;
  const hasCustomHistoryPressureLimit =
    historyPressureLimit !== null &&
    historyPressureLimit !== undefined &&
    Number.isFinite(Number(historyPressureLimit));
  const customHistoryPressureLimit = Number(historyPressureLimit);
  const historyLimitPressure = hasCustomHistoryPressureLimit
    ? chatPairs > customHistoryPressureLimit
    : chatPairs >= Number(workspace?.openAiHistory || 20);

  if (promptTokens < triggerTokens && !historyLimitPressure) {
    return { success: true, skipped: true, reason: "below_threshold" };
  }

  return await compactThread({
    workspace,
    user,
    thread,
    apiSessionId,
    reason: "auto",
    mode: "target",
    targetRatio: config.autoTargetRatio,
    keepRecentMessages:
      keepRecentMessages || Math.max(config.keepRecentMessages, 12),
  });
}

async function agentThreadMemory({
  workspace,
  user = null,
  thread = null,
  apiSessionId = null,
}) {
  if (!getConfig().enabled) return "";
  const compaction = await latestCompaction(
    buildCompactionScope({ workspace, user, thread, apiSessionId })
  );
  return compactionContextBlock(compaction);
}

module.exports = {
  agentThreadMemory,
  buildCompactionScope,
  capsuleJson,
  compactionContextBlock,
  compactThread,
  contextTextsWithCompaction,
  conversationCapsuleBlock,
  decrementTemporaryContextTtl,
  extractDurableTopicHints,
  extractExactValueCandidates,
  getConfig,
  getThreadCompactionStatus,
  invalidateThreadCompactionStatus,
  maybeAutoCompact,
  normalizeCompactionSummary,
  normalizeConversationCapsule,
  parseConversationCapsule,
  recentChatHistoryWithCompaction,
  resolveTargetBudgets,
  targetCompactionPlan,
  recentAutoCompactions,
  recentTargetFailures,
  inFlightCompactions,
};
