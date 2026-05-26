const QUIZ_PLAN_MODEL = "deepseek-v4-flash";
const QUIZ_GENERATION_MODEL = "deepseek-v4-pro";
const QUIZ_GENERATION_FALLBACK_MODEL = "deepseek-v4-flash";
const QUIZ_ANALYSIS_MODEL = "deepseek-v4-pro";
const QUIZ_JSON_RESPONSE_FORMAT = { type: "json_object" };
const QUIZ_TYPES = ["single_choice", "multiple_choice", "fill_blank"];
const QUIZ_DIFFICULTIES = ["easy", "medium", "high", "extreme"];
const DEFAULT_QUESTION_TYPE_COUNTS = {
  single_choice: 10,
  multiple_choice: 6,
  fill_blank: 4,
};
const DEFAULT_TOTAL_QUESTIONS = 20;
const DEFAULT_DIFFICULTY = "high";
const MAX_EVIDENCE_CHUNKS = 10;

module.exports = {
  QUIZ_PLAN_MODEL,
  QUIZ_GENERATION_MODEL,
  QUIZ_GENERATION_FALLBACK_MODEL,
  QUIZ_ANALYSIS_MODEL,
  QUIZ_JSON_RESPONSE_FORMAT,
  QUIZ_TYPES,
  QUIZ_DIFFICULTIES,
  DEFAULT_QUESTION_TYPE_COUNTS,
  DEFAULT_TOTAL_QUESTIONS,
  DEFAULT_DIFFICULTY,
  MAX_EVIDENCE_CHUNKS,
};
