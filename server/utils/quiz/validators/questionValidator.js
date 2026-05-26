const { QUIZ_TYPES } = require("../constants");

function normalizeOptions(options = []) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option, index) => {
      if (typeof option === "string") {
        return { id: String.fromCharCode(65 + index), text: option };
      }
      return {
        id: String(option?.id || String.fromCharCode(65 + index)).trim(),
        text: String(option?.text || option?.label || "").trim(),
      };
    })
    .filter((option) => option.id && option.text);
}

function normalizeAnswer(answer) {
  if (Array.isArray(answer))
    return answer.map((item) => String(item || "").trim()).filter(Boolean);
  if (answer === undefined || answer === null) return [];
  return [String(answer).trim()].filter(Boolean);
}

function validateQuestion(question = {}, evidenceIds = new Set()) {
  const type = String(question.type || "").trim();
  if (!QUIZ_TYPES.includes(type)) return null;

  const sourceRefs = Array.isArray(question.sourceRefs)
    ? question.sourceRefs.map((ref) => String(ref || "").trim()).filter(Boolean)
    : [];
  if (sourceRefs.length === 0) return null;
  if (!sourceRefs.every((ref) => evidenceIds.has(ref))) return null;

  const base = {
    id: String(question.id || `${type}-${Date.now()}`).trim(),
    type,
    question: String(question.question || "").trim(),
    sourceRefs,
  };
  const difficulty = String(question.difficulty || "").trim();
  if (difficulty) base.difficulty = difficulty;
  const explanation = String(question.explanation || "").trim();
  if (explanation) base.explanation = explanation;
  if (!base.question) return null;

  if (type === "fill_blank") {
    const correctAnswer = normalizeAnswer(question.correctAnswer);
    if (correctAnswer.length === 0) return null;
    return { ...base, correctAnswer };
  }

  const options = normalizeOptions(question.options);
  const correctAnswer = normalizeAnswer(question.correctAnswer);
  const optionIds = new Set(options.map((option) => option.id));
  if (type === "single_choice") {
    if (options.length !== 4) return null;
    if (correctAnswer.length !== 1 || !optionIds.has(correctAnswer[0]))
      return null;
    return { ...base, options, correctAnswer: correctAnswer[0] };
  }

  if (type === "multiple_choice") {
    if (options.length < 4 || options.length > 6) return null;
    if (correctAnswer.length < 2 || correctAnswer.length >= options.length)
      return null;
    if (correctAnswer.length > 4) return null;
    if (!correctAnswer.every((answer) => optionIds.has(answer))) return null;
    return { ...base, options, correctAnswer };
  }

  return null;
}

module.exports = {
  validateQuestion,
  normalizeOptions,
  normalizeAnswer,
};
