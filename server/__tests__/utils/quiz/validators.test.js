const {
  validateQuestion,
} = require("../../../utils/quiz/validators/questionValidator");
const {
  validateQuestions,
} = require("../../../utils/quiz/validators/quizValidator");

describe("quiz question validator", () => {
  const evidenceIds = new Set(["evidence-1", "evidence-2"]);

  it("accepts valid single-choice questions", () => {
    const question = validateQuestion(
      {
        id: "q1",
        type: "single_choice",
        question: "What is true?",
        options: ["One", "Two", "Three", "Four"],
        correctAnswer: "A",
        sourceRefs: ["evidence-1"],
      },
      evidenceIds
    );
    expect(question.correctAnswer).toBe("A");
    expect(question.options).toHaveLength(4);
    expect(question.explanation).toBeUndefined();
    expect(question.difficulty).toBeUndefined();
  });

  it("keeps legacy explanation and difficulty when present", () => {
    const question = validateQuestion(
      {
        id: "legacy",
        type: "single_choice",
        question: "What is true?",
        options: ["One", "Two", "Three", "Four"],
        correctAnswer: "A",
        sourceRefs: ["evidence-1"],
        difficulty: "high",
        explanation: "legacy analysis",
      },
      evidenceIds
    );
    expect(question.difficulty).toBe("high");
    expect(question.explanation).toBe("legacy analysis");
  });

  it("drops multiple-choice questions with all options correct", () => {
    const question = validateQuestion(
      {
        id: "q2",
        type: "multiple_choice",
        question: "Pick all",
        options: ["A", "B", "C", "D"],
        correctAnswer: ["A", "B", "C", "D"],
        sourceRefs: ["evidence-1"],
      },
      evidenceIds
    );
    expect(question).toBeNull();
  });

  it("accepts multiple-choice questions with 4 to 6 options", () => {
    for (const options of [
      ["A", "B", "C", "D"],
      ["A", "B", "C", "D", "E"],
      ["A", "B", "C", "D", "E", "F"],
    ]) {
      const question = validateQuestion(
        {
          id: `multi-${options.length}`,
          type: "multiple_choice",
          question: "Pick all",
          options,
          correctAnswer: ["A", "B"],
          sourceRefs: ["evidence-1"],
        },
        evidenceIds
      );
      expect(question.options).toHaveLength(options.length);
      expect(question.correctAnswer).toEqual(["A", "B"]);
    }
  });

  it("drops multiple-choice questions with more than four correct answers", () => {
    const question = validateQuestion(
      {
        id: "too-many-correct",
        type: "multiple_choice",
        question: "Pick all",
        options: ["A", "B", "C", "D", "E", "F"],
        correctAnswer: ["A", "B", "C", "D", "E"],
        sourceRefs: ["evidence-1"],
      },
      evidenceIds
    );
    expect(question).toBeNull();
  });

  it("drops questions with unmapped sourceRefs", () => {
    const question = validateQuestion(
      {
        id: "q3",
        type: "fill_blank",
        question: "Fill ____",
        correctAnswer: ["blank"],
        sourceRefs: ["missing"],
      },
      evidenceIds
    );
    expect(question).toBeNull();
  });

  it("fills default difficulty outside the LLM schema", () => {
    const questions = validateQuestions(
      [
        {
          id: "q1",
          type: "fill_blank",
          question: "Fill ____",
          correctAnswer: ["blank"],
          sourceRefs: ["evidence-1"],
        },
      ],
      [{ id: "evidence-1" }],
      { difficulty: "extreme" }
    );

    expect(questions[0]).toEqual(
      expect.objectContaining({ difficulty: "extreme" })
    );
  });
});
