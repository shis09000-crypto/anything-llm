const { QUIZ_TYPES } = require("./constants");

const GENERATORS = {
  single_choice: "singleChoiceGenerator",
  multiple_choice: "multipleChoiceGenerator",
  fill_blank: "fillBlankGenerator",
};

const PRIORITY = {
  single_choice: 1,
  multiple_choice: 2,
  fill_blank: 3,
};

function allocateQuestionGeneration({
  plan,
  evidenceChunks = [],
  evidenceMode = "workspace",
}) {
  const counts = plan.questionTypeCounts || {};
  return QUIZ_TYPES.map((type) => ({
    type,
    count: Math.max(0, Math.floor(Number(counts[type]) || 0)),
    generator: GENERATORS[type],
    priority: PRIORITY[type],
    difficulty: plan.difficulty,
    topic: plan.topic,
    keywords: plan.keywords || [],
    evidenceMode,
    evidenceChunks,
    sourceRefs: evidenceChunks.map((chunk) => chunk.sourceRef),
  }))
    .filter((job) => job.count > 0)
    .sort((a, b) => a.priority - b.priority);
}

module.exports = { allocateQuestionGeneration };
