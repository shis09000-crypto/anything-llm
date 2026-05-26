const {
  DEFAULT_DIFFICULTY,
  DEFAULT_QUESTION_TYPE_COUNTS,
  DEFAULT_TOTAL_QUESTIONS,
  QUIZ_DIFFICULTIES,
  QUIZ_PLAN_MODEL,
  QUIZ_TYPES,
} = require("./constants");
const { completeJson } = require("./llm");

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

  const { json, metrics, model } = await completeJson({
    model: QUIZ_PLAN_MODEL,
    systemPrompt: "You extract quiz plans. Return a single strict JSON object.",
    userPrompt: prompt,
    temperature: 0.1,
  });

  return {
    plan: normalizePlan(json || {}, userRequest),
    metrics,
    model,
  };
}

module.exports = {
  extractQuizPlan,
  normalizePlan,
  normalizeCounts,
};
