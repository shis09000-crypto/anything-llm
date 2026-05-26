function generatedCounts(questions = []) {
  return questions.reduce(
    (acc, question) => {
      if (acc[question.type] !== undefined) acc[question.type] += 1;
      return acc;
    },
    { single_choice: 0, multiple_choice: 0, fill_blank: 0 }
  );
}

function pendingTypesFromJobs(jobs = [], questions = [], failedTypes = []) {
  const counts = generatedCounts(questions);
  return jobs
    .filter((job) => !failedTypes.includes(job.type))
    .filter((job) => counts[job.type] < job.count)
    .map((job) => job.type);
}

function mergeQuestions(existing = [], incoming = []) {
  const byId = new Map();
  for (const question of [...existing, ...incoming]) {
    if (!question?.id || byId.has(question.id)) continue;
    byId.set(question.id, question);
  }
  return [...byId.values()];
}

function assembleQuiz({
  quizId = null,
  plan,
  evidenceChunks = [],
  sourceRefs = [],
  jobs = [],
  questions = [],
  failedTypes = [],
  errors = [],
  status = null,
}) {
  const counts = generatedCounts(questions);
  const pendingTypes = pendingTypesFromJobs(jobs, questions, failedTypes);
  const nextStatus =
    status ||
    (pendingTypes.length > 0
      ? "partial_generating"
      : failedTypes.length > 0
        ? "failed"
        : "ready");
  return {
    id: quizId,
    title: plan.topic || "Knowledge Quiz",
    topic: plan.topic,
    plan,
    questions,
    expectedTotalQuestions: plan.totalQuestions,
    generatedCounts: counts,
    pendingTypes,
    failedTypes,
    errors,
    sourceRefs,
    evidenceChunks,
    generationStatus: {
      status: nextStatus,
      jobs: jobs.map(({ evidenceChunks: _e, sourceRefs: _s, ...job }) => job),
    },
  };
}

function quizResponseText(quiz = {}) {
  if (quiz.generationStatus?.status === "ready") {
    return `测试题已生成，共 ${quiz.questions?.length || 0} 题。`;
  }
  return `测试题已先生成 ${quiz.questions?.length || 0} 题，后续题目正在继续生成。`;
}

function quizOutput(quiz) {
  return [{ type: "QuizCard", payload: quiz }];
}

module.exports = {
  assembleQuiz,
  mergeQuestions,
  generatedCounts,
  pendingTypesFromJobs,
  quizResponseText,
  quizOutput,
};
