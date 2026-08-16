const {
  gradeSelectionQuestions,
  mergeFinalQuestionResults,
  sameAnswer,
} = require("../../../utils/quiz/grading");

describe("quiz deterministic selection grading", () => {
  const quiz = {
    questions: [
      {
        id: "single-1",
        type: "single_choice",
        question: "单选",
        correctAnswer: "B",
        options: [],
      },
      {
        id: "multi-1",
        type: "multiple_choice",
        question: "多选",
        correctAnswer: ["A", "C"],
        options: [],
      },
      {
        id: "blank-1",
        type: "fill_blank",
        question: "填空",
        correctAnswer: ["答案"],
      },
    ],
  };

  test("compares multi-select answers without depending on option order", () => {
    expect(sameAnswer(["C", "A"], ["A", "C"])).toBe(true);
    expect(sameAnswer(["A"], ["A", "C"])).toBe(false);
  });

  test("grades only single and multiple choice questions immediately", () => {
    const result = gradeSelectionQuestions({
      quiz,
      answers: { "single-1": "B", "multi-1": ["A", "B"] },
      attemptId: "quiz-1",
    });

    expect(result.quickGrade).toMatchObject({
      status: "completed",
      selectionQuestionCount: 2,
      gradedQuestionCount: 2,
      correctCount: 1,
      incorrectCount: 1,
      pendingAnalysisQuestionCount: 1,
    });
    expect(result.questionResults.map((item) => item.isCorrect)).toEqual([
      true,
      false,
    ]);
  });

  test("keeps deterministic choice scores when model analysis is merged", () => {
    const quick = gradeSelectionQuestions({
      quiz,
      answers: { "single-1": "B", "multi-1": ["A", "B"] },
      attemptId: "quiz-1",
    });
    const merged = mergeFinalQuestionResults({
      attemptId: "quiz-1",
      quiz: { ...quiz, questionResults: quick.questionResults },
      structuredResults: [
        { questionId: "single-1", isCorrect: false, score: 0 },
        { questionId: "multi-1", isCorrect: true, score: 1 },
        { questionId: "blank-1", isCorrect: true, score: 1 },
      ],
    });

    expect(merged.map((item) => item.isCorrect)).toEqual([true, false, true]);
    expect(merged[0].gradingMode).toBe("deterministic_selection");
  });
});
