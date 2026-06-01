const {
  WorkspaceChatCompaction,
} = require("../../models/workspaceChatCompaction");
const { getLLMProvider } = require("../helpers");
const { getTaskConnector, resolveTaskProviderModel } = require("../llmTasks");
const { TokenManager } = require("../helpers/tiktoken");
const { convertToPromptHistory } = require("../helpers/chat/responses");
const { recentChatHistory } = require("./index");

const DEFAULT_KEEP_RECENT_MESSAGES = 10;
const DEFAULT_TRIGGER_RATIO = 0.65;
const DEFAULT_MAX_SUMMARY_TOKENS = 2500;
const DEFAULT_COMPACTION_CONTEXT_WINDOW_TOKENS = 400_000;
const DEFAULT_MANUAL_TARGET_RATIO = 0.15;
const DEFAULT_AUTO_TARGET_RATIO = 0.2;
const DEFAULT_TARGET_ABSOLUTE_TOKENS = 150_000;
const DEFAULT_TARGET_MIN_SUMMARY_TOKENS = 12_000;
const DEFAULT_TARGET_MAX_SUMMARY_TOKENS = 60_000;
const DEFAULT_TARGET_SUMMARY_BUDGET_RATIO = 0.5;
const MANUAL_COMPACT_RATIO = 0.8;
const AUTO_COOLDOWN_MS = 5 * 60 * 1000;
const TARGET_RATIO_MIN = 0.1;
const TARGET_RATIO_MAX = 0.2;
const inFlightCompactions = new Set();
const recentAutoCompactions = new Map();
const recentTargetFailures = new Map();

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

function compactMemoryBlock(summary = "") {
  summary = normalizeCompactionSummary(summary);
  if (!summary) return "";
  return `Thread Memory Summary:
[BEGIN COMPACTED THREAD MEMORY]
${summary}
[END COMPACTED THREAD MEMORY]`;
}

function agentCompactMemoryBlock(summary = "") {
  summary = normalizeCompactionSummary(summary);
  if (!summary) return "";
  return `<compacted_thread_memory>
${summary}
</compacted_thread_memory>`;
}

function injectCompactionIntoSystemPrompt(
  systemPrompt = "",
  compaction = null
) {
  if (!compaction?.summary) return systemPrompt;
  return `${systemPrompt}

${compactMemoryBlock(compaction.summary)}`;
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
  const fallbackProvider = workspace?.chatProvider;
  const fallbackModel = workspace?.chatModel;

  try {
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
  } catch (error) {
    console.warn(
      "[ThreadCompaction] configured compaction provider unavailable, falling back",
      error.message
    );
  }

  const llm = getLLMProvider({
    provider: fallbackProvider,
    model: fallbackModel,
  });
  return {
    llm,
    provider: fallbackProvider || null,
    model: llm?.model || fallbackModel || null,
    fallbackUsed: true,
  };
}

function resolveChatLLM(workspace) {
  return getLLMProvider({
    provider: workspace?.chatProvider,
    model: workspace?.chatModel,
  });
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
  let normalized = String(summary)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .trim();

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
} = {}) {
  const config = getConfig();
  if (!config.enabled) {
    return await recentChatHistory({
      user,
      workspace,
      thread,
      messageLimit,
      apiSessionId,
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
    });
  }

  try {
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

function compactionInputTokens(llm, previousSummary = "", chats = []) {
  return (
    estimateStringTokens(llm, normalizeCompactionSummary(previousSummary)) +
    estimateStringTokens(
      llm,
      chats.map(formatChatForSummary).join("\n\n---\n\n")
    )
  );
}

function chunkChatsForCompaction({
  llm,
  previousSummary = "",
  chats = [],
  compactionInputLimit,
} = {}) {
  const reserve = Math.max(4_000, Math.floor(compactionInputLimit * 0.05));
  const chunkLimit = Math.max(1, compactionInputLimit - reserve);
  const chunks = [];
  let chunk = [];
  let chunkTokens = estimateStringTokens(
    llm,
    normalizeCompactionSummary(previousSummary)
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
  chats = [],
  compactionInputLimit,
} = {}) {
  const retained = [];
  let tokens = estimateStringTokens(
    llm,
    normalizeCompactionSummary(previousSummary)
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

function buildSummaryPrompt({
  previousSummary = null,
  chats = [],
  compactInstructions = "",
  summaryTokenBudget = null,
} = {}) {
  const prior = normalizeCompactionSummary(previousSummary);
  return `Create a compact thread handoff summary for this AnythingLLM thread.

Rules:
- Output Markdown only.
- Do not include casual commentary.
- Do not invent facts the user did not state.
- If a required detail is uncertain, write "未知".
- Preserve concrete file paths, function names, table names, config names, route names, user constraints, and technical boundaries.
- This is deterministic thread state, not RAG memory and not a citation source.
- Do not store ephemeral RAG context, citations, pinned docs, parsed files, graph context, attachments, or tool output transcripts unless a durable conclusion from them is necessary for the task state.
- Treat persistent context such as system prompt, workspace prompt, and project rules as re-injected context. Do not copy them into the compact state unless the user explicitly made them part of the task.
- Never include reasoning, chain-of-thought, <think> tags, or analysis prose outside the required Markdown.
- Start the response exactly with "# Thread Compact Summary".
${summaryTokenBudget ? `- Keep the summary within about ${summaryTokenBudget} tokens while preserving handoff quality.` : ""}
${compactInstructions ? `- Additional compaction instructions: ${compactInstructions}` : ""}

Required format:
# Thread Compact Summary
## 当前任务目标
## 最近用户意图
## 用户强约束
## 已完成内容
## 当前架构判断
## 关键文件/函数/路由/数据表
## 技术决策
## 已排除方案
## 未完成事项
## 下一步建议
## 风险与注意事项
## 不可丢失事实

Previous compact summary, if any:
${prior || "未知"}

Raw chat history to fold into the summary:
${chats.map(formatChatForSummary).join("\n\n---\n\n")}`;
}

function buildTightenPrompt({ summary = "", maxSummaryTokens }) {
  return `Tighten this compact thread state without losing important handoff information.

Rules:
- Output Markdown only.
- Start exactly with "# Thread Compact Summary".
- Preserve concrete paths, function names, API routes, database tables, fields, config names, user constraints, completed work, unfinished work, and risks.
- Do not invent facts.
- Keep it within about ${maxSummaryTokens} tokens.

Current compact state:
${normalizeCompactionSummary(summary) || "未知"}`;
}

function clippedSummary(llm, summary = "", maxSummaryTokens = 2500) {
  if (!summary) return summary;
  const tokenManager = new TokenManager(llm?.model);
  if (tokenManager.countFromString(summary) <= maxSummaryTokens) return summary;
  const tokens = tokenManager
    .tokensFromString(summary)
    .slice(0, maxSummaryTokens);
  return `${tokenManager.bytesFromTokens(tokens)}\n\n[summary truncated to configured token budget]`;
}

async function generateSummary({
  workspace,
  user = null,
  previousSummary,
  chats,
  llm = null,
  maxSummaryTokens = null,
  compactInstructions = "",
}) {
  const summaryLLM = llm || resolveCompactionLLM(workspace).llm;
  const systemPrompt =
    "You produce concise, structured handoff summaries for long-running chat threads. Return only the requested Markdown summary, with no reasoning or hidden-thinking text.";
  const userPrompt = buildSummaryPrompt({
    previousSummary,
    chats,
    compactInstructions,
    summaryTokenBudget: maxSummaryTokens,
  });
  const messages = await summaryLLM.compressMessages(
    {
      systemPrompt,
      userPrompt,
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const result = await summaryLLM.getChatCompletion(messages, {
    temperature: 0,
    user,
  });
  return {
    llm: summaryLLM,
    summary: clippedSummary(
      summaryLLM,
      normalizeCompactionSummary(result?.textResponse || ""),
      maxSummaryTokens || getConfig().maxSummaryTokens
    ),
  };
}

async function tightenSummary({ llm, user = null, summary, maxSummaryTokens }) {
  const systemPrompt =
    "You tighten compact thread state summaries. Return only Markdown, no hidden thinking.";
  const messages = await llm.compressMessages(
    {
      systemPrompt,
      userPrompt: buildTightenPrompt({ summary, maxSummaryTokens }),
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const result = await llm.getChatCompletion(messages, {
    temperature: 0,
    user,
  });
  return clippedSummary(
    llm,
    normalizeCompactionSummary(result?.textResponse || ""),
    maxSummaryTokens
  );
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
    const chatLLM = resolveChatLLM(workspace);
    const compactionInfo = resolveCompactionLLM(workspace);
    const compactionLLM = compactionInfo.llm;
    const isTargetMode = mode === "target";
    const targetMode = reason === "auto" ? "auto" : "manual";
    const budgets = resolveTargetBudgets({
      workspace,
      chatLLM,
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
          llm: chatLLM,
          rawHistory: candidateSet.rawHistory,
          budgets,
        })
      : {
          compactable: candidateSet.compactable,
          retained: candidateSet.rawHistory.slice(
            candidateSet.compactable.length
          ),
          retainedTokens: estimateHistoryTokens(
            chatLLM,
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
    let previousSummary = normalizeCompactionSummary(latest?.summary || null);
    let summary = "";
    const maxSummaryTokens = isTargetMode
      ? budgets.estimatedSummaryBudget
      : config.maxSummaryTokens;

    const inputTokens = compactionInputTokens(
      compactionLLM,
      previousSummary,
      compactable
    );
    if (isTargetMode && inputTokens > budgets.compactionInputLimit) {
      try {
        const chunks = chunkChatsForCompaction({
          llm: compactionLLM,
          previousSummary,
          chats: compactable,
          compactionInputLimit: budgets.compactionInputLimit,
        });
        rollingCompactionUsed = chunks.length > 1;
        for (const chunk of chunks) {
          const generated = await generateSummary({
            workspace,
            user,
            llm: compactionLLM,
            previousSummary,
            chats: chunk,
            maxSummaryTokens,
            compactInstructions,
          });
          previousSummary = generated.summary;
        }
        summary = previousSummary;
      } catch (error) {
        console.warn(
          "[ThreadCompaction] rolling compaction failed; truncating input",
          error.message
        );
        cannotReachTargetReason = "input_exceeded_compaction_window_truncated";
        const truncated = truncateChatsForCompaction({
          llm: compactionLLM,
          previousSummary,
          chats: compactable,
          compactionInputLimit: budgets.compactionInputLimit,
        });
        compactable = truncated;
        const generated = await generateSummary({
          workspace,
          user,
          llm: compactionLLM,
          previousSummary,
          chats: truncated,
          maxSummaryTokens,
          compactInstructions,
        });
        summary = generated.summary;
      }
    } else {
      const generated = await generateSummary({
        workspace,
        user,
        llm: compactionLLM,
        previousSummary,
        chats: compactable,
        maxSummaryTokens,
        compactInstructions,
      });
      summary = generated.summary;
    }
    if (!summary) throw new Error("empty_compaction_summary");

    let tokenAfter = estimateStringTokens(compactionLLM, summary);
    let summaryInjectionTokens = estimateStringTokens(chatLLM, summary);
    let usedTokensAfterCompact =
      summaryInjectionTokens + targetPlan.retainedTokens;
    let targetReached =
      !isTargetMode || usedTokensAfterCompact <= budgets.targetTokens;

    if (
      isTargetMode &&
      !targetReached &&
      budgets.estimatedSummaryBudget <= budgets.targetTokens &&
      tokenAfter > config.targetMinSummaryTokens
    ) {
      summary = await tightenSummary({
        llm: compactionLLM,
        user,
        summary,
        maxSummaryTokens: Math.max(
          config.targetMinSummaryTokens,
          Math.min(tokenAfter - 1, budgets.estimatedSummaryBudget)
        ),
      });
      tokenAfter = estimateStringTokens(compactionLLM, summary);
      summaryInjectionTokens = estimateStringTokens(chatLLM, summary);
      usedTokensAfterCompact =
        summaryInjectionTokens + targetPlan.retainedTokens;
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
} = {}) {
  const config = getConfig();
  const scope = buildCompactionScope({ workspace, user, thread, apiSessionId });
  const chatLLM = resolveChatLLM(workspace);
  const compactionInfo = resolveCompactionLLM(workspace);
  const compactionLLM = compactionInfo.llm;
  const budgets = resolveTargetBudgets({
    workspace,
    chatLLM,
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
  const { compactable } = await compactionCandidates(
    scope,
    config.keepRecentMessages
  );
  const targetPlan = targetCompactionPlan({
    llm: chatLLM,
    rawHistory,
    budgets,
  });

  const summaryTokens = latest?.summary
    ? estimateStringTokens(chatLLM, normalizeCompactionSummary(latest.summary))
    : 0;
  const recentHistoryTokens = estimateHistoryTokens(chatLLM, rawHistory);
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
      systemPrompt: injectCompactionIntoSystemPrompt(systemPrompt, compaction),
      userPrompt,
      contextTexts,
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
  const historyLimitPressure =
    chatHistory.length / 2 >= Number(workspace?.openAiHistory || 20);

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
  return agentCompactMemoryBlock(compaction?.summary || "");
}

module.exports = {
  agentCompactMemoryBlock,
  agentThreadMemory,
  buildCompactionScope,
  compactMemoryBlock,
  compactThread,
  getConfig,
  getThreadCompactionStatus,
  injectCompactionIntoSystemPrompt,
  maybeAutoCompact,
  normalizeCompactionSummary,
  recentChatHistoryWithCompaction,
  resolveTargetBudgets,
  targetCompactionPlan,
  recentAutoCompactions,
  recentTargetFailures,
  inFlightCompactions,
};
