const {
  DEFAULT_DIFFICULTY,
  DEFAULT_QUESTION_TYPE_COUNTS,
  DEFAULT_TOTAL_QUESTIONS,
  QUIZ_DIFFICULTIES,
  QUIZ_PLAN_MODEL,
  QUIZ_TYPES,
} = require("./constants");
const { completeJsonWithRetry } = require("./llm");

function normalizeDifficulty(value) {
  const difficulty = String(value || "").toLowerCase();
  return QUIZ_DIFFICULTIES.includes(difficulty)
    ? difficulty
    : DEFAULT_DIFFICULTY;
}

function scaledCounts(total) {
  const ratio = DEFAULT_QUESTION_TYPE_COUNTS;
  const baseTotal = DEFAULT_TOTAL_QUESTIONS;
  const counts = {
    single_choice: Math.round((total * ratio.single_choice) / baseTotal),
    multiple_choice: Math.round((total * ratio.multiple_choice) / baseTotal),
    fill_blank: Math.round((total * ratio.fill_blank) / baseTotal),
  };
  let diff =
    total - Object.values(counts).reduce((sum, value) => sum + value, 0);
  const order = ["single_choice", "multiple_choice", "fill_blank"];
  let idx = 0;
  while (diff !== 0) {
    const key = order[idx % order.length];
    if (diff > 0) {
      counts[key] += 1;
      diff -= 1;
    } else if (counts[key] > 0) {
      counts[key] -= 1;
      diff += 1;
    }
    idx += 1;
  }
  return counts;
}

function normalizeCounts(
  rawCounts = {},
  totalQuestions = DEFAULT_TOTAL_QUESTIONS
) {
  const hasAnyCount = QUIZ_TYPES.some((type) => Number(rawCounts?.[type]) > 0);
  const counts = hasAnyCount
    ? QUIZ_TYPES.reduce((acc, type) => {
        acc[type] = Math.max(0, Math.floor(Number(rawCounts?.[type]) || 0));
        return acc;
      }, {})
    : scaledCounts(totalQuestions);

  let currentTotal = Object.values(counts).reduce(
    (sum, value) => sum + value,
    0
  );
  if (currentTotal === totalQuestions) return counts;

  const order = ["single_choice", "multiple_choice", "fill_blank"];
  let idx = 0;
  while (currentTotal !== totalQuestions) {
    const key = order[idx % order.length];
    if (currentTotal < totalQuestions) {
      counts[key] += 1;
      currentTotal += 1;
    } else if (counts[key] > 0) {
      counts[key] -= 1;
      currentTotal -= 1;
    }
    idx += 1;
  }
  return counts;
}

function normalizeSearchQueries(value, fallbackTerms = []) {
  const queries = Array.isArray(value) ? value : [];
  return [...queries, ...fallbackTerms]
    .map((query) => String(query || "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function normalizePlan(raw = {}, userRequest = "") {
  const totalQuestions =
    Math.max(1, Math.min(60, Math.floor(Number(raw.totalQuestions)))) ||
    DEFAULT_TOTAL_QUESTIONS;
  const topic = String(raw.topic || userRequest || "知识库测试").trim();
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords
        .map((keyword) => String(keyword || "").trim())
        .filter(Boolean)
    : [];
  const questionTypeCounts = normalizeCounts(
    raw.questionTypeCounts || {},
    totalQuestions
  );

  return {
    topic,
    keywords,
    totalQuestions,
    questionTypeCounts,
    difficulty: normalizeDifficulty(raw.difficulty),
    searchQueries: normalizeSearchQueries(raw.searchQueries, [
      topic,
      keywords.join(" "),
      userRequest,
    ]),
  };
}

const CHINESE_DIGITS = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function chineseNumber(value = "") {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  if (text === "十") return 10;
  if (text.includes("十")) {
    const [tens = "", ones = ""] = text.split("十");
    const tensValue = tens ? CHINESE_DIGITS[tens] : 1;
    const onesValue = ones ? CHINESE_DIGITS[ones] : 0;
    if (tensValue !== undefined && onesValue !== undefined)
      return tensValue * 10 + onesValue;
  }
  return CHINESE_DIGITS[text] ?? null;
}

function requestedQuestionCount(userRequest = "") {
  const text = String(userRequest || "");
  const match =
    text.match(
      /([0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:道|个)(?=[^，。！？,.!?]{0,40}(?:测试|测验)?题)/i
    ) ||
    text.match(
      /([0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*(?=(?:测试|测验)?题)/i
    );
  const value = chineseNumber(match?.[1]);
  if (!Number.isFinite(value)) return DEFAULT_TOTAL_QUESTIONS;
  return Math.max(1, Math.min(60, Math.floor(value)));
}

function requestedTopic(userRequest = "") {
  const text = String(userRequest || "").trim();
  const about = text.match(
    /关于\s*([^，。！？,.!?]{1,40}?)(?:的)?(?:测试|测验|题目|题)?(?:[，。！？,.!?]|$)/
  );
  if (about?.[1])
    return about[1].replace(/的$/, "").trim() || text || "知识库测试";

  const compact = text.match(
    /(?:出|生成|来|准备|要)?\s*(?:[0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:道|个)?\s*([^，。！？,.!?]{1,24}?)\s*(?:测试)?题(?:目)?/
  );
  if (compact?.[1]) {
    const topic = compact[1]
      .replace(/^(?:简单|基础|入门|中等|普通|困难|高难|极难|非常难)的?/, "")
      .trim();
    return topic || text;
  }
  return text || "知识库测试";
}

function requestedDifficulty(userRequest = "") {
  const text = String(userRequest || "").toLowerCase();
  if (/(极难|非常难|专家|extreme)/.test(text)) return "extreme";
  if (/(简单|基础|入门|easy)/.test(text)) return "easy";
  if (/(中等|普通|medium)/.test(text)) return "medium";
  return DEFAULT_DIFFICULTY;
}

/**
 * Build a deterministic, synchronous plan so the Responses runtime can
 * persist the user's turn before any model or RAG work starts. The model may
 * refine this draft later, but a slow provider can no longer swallow a turn.
 */
function draftQuizPlan(userRequest = "") {
  const totalQuestions = requestedQuestionCount(userRequest);
  const topic = requestedTopic(userRequest);
  return normalizePlan(
    {
      topic,
      keywords: [topic],
      totalQuestions,
      questionTypeCounts: scaledCounts(totalQuestions),
      difficulty: requestedDifficulty(userRequest),
      searchQueries: [topic, userRequest],
    },
    userRequest
  );
}

async function extractQuizPlan({ userRequest, workspaceSlug }) {
  const prompt = `Extract a quiz generation plan from the user's request.

Rules:
- User explicit requirements override defaults.
- If omitted, use totalQuestions=20.
- If omitted, use questionTypeCounts: single_choice=10, multiple_choice=6, fill_blank=4.
- If omitted, use difficulty="high".
- Difficulty must be one of: easy, medium, high, extreme.
- Choose difficulty from the user's wording when they specify it; otherwise default to high.
- Output JSON only.

Workspace slug: ${workspaceSlug || "unknown"}
User request:
${userRequest}

JSON schema:
{
  "topic": "string",
  "keywords": ["string"],
  "totalQuestions": 20,
  "questionTypeCounts": {
    "single_choice": 10,
    "multiple_choice": 6,
    "fill_blank": 4
  },
  "difficulty": "easy | medium | high | extreme",
  "searchQueries": ["string"]
}`;

  let result;
  try {
    result = await completeJsonWithRetry({
      model: QUIZ_PLAN_MODEL,
      systemPrompt:
        "You extract quiz plans. Return a single strict JSON object.",
      userPrompt: prompt,
      temperature: 0.1,
      label: "quiz_plan",
      maxAttempts: 1,
      timeoutMs: 20_000,
    });
  } catch (failure) {
    console.warn(
      "[QuizPlan] model plan unavailable; using deterministic plan",
      {
        code: failure?.code || null,
        message: failure?.message || "quiz_plan_unavailable",
      }
    );
    return {
      plan: draftQuizPlan(userRequest),
      metrics: {
        requested_protocol: "responses",
        effective_protocol: "responses",
        degraded_reason: failure?.message || "quiz_plan_unavailable",
      },
      model: QUIZ_PLAN_MODEL,
    };
  }
  const { json, metrics, model } = result;

  return {
    plan: normalizePlan(json || {}, userRequest),
    metrics,
    model,
  };
}

module.exports = {
  draftQuizPlan,
  extractQuizPlan,
  normalizePlan,
  normalizeCounts,
  requestedQuestionCount,
  requestedTopic,
};
