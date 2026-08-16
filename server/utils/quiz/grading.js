const SELECTION_TYPES = new Set(["single_choice", "multiple_choice"]);

function answerIds(answer) {
  if (answer === undefined || answer === null || answer === "") return [];
  const values = Array.isArray(answer) ? answer : [answer];
  return [
    ...new Set(
      values
        .map((value) => String(value).trim())
        .filter(Boolean)
        .sort()
    ),
  ];
}

function sameAnswer(left, right) {
  const actual = answerIds(left);
  const expected = answerIds(right);
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function gradeSelectionQuestions({ quiz = {}, answers = {}, attemptId }) {
  const completedAt = new Date().toISOString();
  const questionResults = (quiz.questions || []).flatMap((question, index) => {
    if (!SELECTION_TYPES.has(question.type)) return [];
    const correctAnswer = question.correctAnswer;
    const expected = answerIds(correctAnswer);
    const isCorrect = expected.length
      ? sameAnswer(answers[question.id], correctAnswer)
      : null;
    return [
      {
        id: `${attemptId}:result:${index + 1}`,
        questionResultId: `${attemptId}:result:${index + 1}`,
        attemptId,
        questionId: question.id,
        questionType: question.type,
        difficulty: question.difficulty || quiz.plan?.difficulty || null,
        question: question.question,
        options: question.options || [],
        userAnswer: answers[question.id],
        correctAnswer,
        isCorrect,
        score: isCorrect === null ? null : isCorrect ? 1 : 0,
        analysis: "",
        mistakeReason: "",
        weakConcepts: [],
        sourceRefs: question.sourceRefs || [],
        gradingMode: "deterministic_selection",
      },
    ];
  });
  const graded = questionResults.filter(
    (result) => result.isCorrect === true || result.isCorrect === false
  );
  const correctCount = graded.filter(
    (result) => result.isCorrect === true
  ).length;
  return {
    questionResults,
    quickGrade: {
      status: "completed",
      mode: "deterministic_selection",
      completedAt,
      selectionQuestionCount: questionResults.length,
      gradedQuestionCount: graded.length,
      correctCount,
      incorrectCount: graded.length - correctCount,
      pendingAnalysisQuestionCount: Math.max(
        0,
        (quiz.questions || []).length - graded.length
      ),
      totalQuestionCount: (quiz.questions || []).length,
    },
  };
}

function mergeFinalQuestionResults({
  attemptId,
  quiz = {},
  structuredResults = [],
}) {
  const deterministic = new Map(
    (quiz.questionResults || [])
      .filter((result) => result.gradingMode === "deterministic_selection")
      .map((result) => [result.questionId, result])
  );
  const modelResults = new Map(
    structuredResults.map((result) => [result.questionId, result])
  );
  return (quiz.questions || []).map((question, index) => {
    const result = modelResults.get(question.id) || {
      questionId: question.id,
      questionType: question.type,
      difficulty: question.difficulty || quiz.plan?.difficulty || null,
      question: question.question,
      options: question.options || [],
      userAnswer: quiz.answers?.[question.id],
      correctAnswer: question.correctAnswer,
      isCorrect: null,
      score: null,
      analysis: "",
      mistakeReason: "",
      weakConcepts: [],
      sourceRefs: question.sourceRefs || [],
    };
    const quickResult = deterministic.get(question.id);
    return {
      ...result,
      ...(quickResult
        ? {
            userAnswer: quickResult.userAnswer,
            correctAnswer: quickResult.correctAnswer,
            isCorrect: quickResult.isCorrect,
            score: quickResult.score,
            gradingMode: quickResult.gradingMode,
          }
        : {}),
      id: `${attemptId}:result:${index + 1}`,
      questionResultId: `${attemptId}:result:${index + 1}`,
      attemptId,
    };
  });
}

module.exports = {
  SELECTION_TYPES,
  answerIds,
  gradeSelectionQuestions,
  mergeFinalQuestionResults,
  sameAnswer,
};
