const { validateQuestion } = require("./questionValidator");

function validateQuestions(questions = [], evidenceChunks = [], defaults = {}) {
  return validateQuestionsWithReport(questions, evidenceChunks, defaults)
    .questions;
}

function validateQuestionsWithReport(
  questions = [],
  evidenceChunks = [],
  defaults = {}
) {
  const evidenceIds = new Set(evidenceChunks.map((chunk) => chunk.id));
  const seen = new Set();
  const valid = [];
  const input = Array.isArray(questions) ? questions : [];
  const report = {
    total: input.length,
    dropped: 0,
    dropRate: 0,
    reasons: {},
  };
  for (const question of input) {
    const normalized = validateQuestion(question, evidenceIds);
    if (!normalized) {
      report.dropped += 1;
      const reason = "invalid_question_or_source_refs";
      report.reasons[reason] = (report.reasons[reason] || 0) + 1;
      continue;
    }
    if (!normalized.difficulty && defaults.difficulty) {
      normalized.difficulty = defaults.difficulty;
    }
    if (seen.has(normalized.id)) {
      normalized.id = `${normalized.id}-${valid.length + 1}`;
    }
    seen.add(normalized.id);
    valid.push(normalized);
  }
  report.dropRate = report.total > 0 ? report.dropped / report.total : 0;
  return { questions: valid, report };
}

module.exports = { validateQuestions, validateQuestionsWithReport };
