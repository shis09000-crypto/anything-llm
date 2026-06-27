const mockCompleteJsonStreamWithRetry = jest.fn();

jest.mock("../../../utils/quiz/llm", () => ({
  completeJsonStreamWithRetry: (...args) =>
    mockCompleteJsonStreamWithRetry(...args),
}));

describe("quiz general knowledge generation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("accepts generated questions that reference the general knowledge source", async () => {
    mockCompleteJsonStreamWithRetry.mockResolvedValue({
      json: {
        questions: [
          {
            id: "single-choice-1",
            type: "single_choice",
            question: "洛克的经验主义通常主张知识主要来源于什么？",
            options: [
              { id: "A", text: "先天理念" },
              { id: "B", text: "感觉经验与反省" },
              { id: "C", text: "神秘启示" },
              { id: "D", text: "数学直觉" },
            ],
            correctAnswer: "B",
            sourceRefs: ["general-knowledge"],
          },
        ],
      },
      metrics: {},
      model: "mock-model",
    });
    const {
      generateQuestionsForType,
    } = require("../../../utils/quiz/generators/shared");

    const result = await generateQuestionsForType({
      systemPrompt: "Generate quiz JSON.",
      typeRules: "- single_choice must have four options.",
      job: {
        type: "single_choice",
        count: 1,
        topic: "洛克经验主义",
        keywords: [],
        difficulty: "high",
        evidenceMode: "general_knowledge",
        evidenceChunks: [
          {
            id: "general-knowledge",
            text: "Use model general knowledge.",
            score: 0,
            sourceRef: { id: "general-knowledge", title: "模型通识" },
          },
        ],
      },
    });

    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].sourceRefs).toEqual(["general-knowledge"]);
    expect(
      mockCompleteJsonStreamWithRetry.mock.calls[0][0].userPrompt
    ).toContain('sourceRefs exactly as ["general-knowledge"]');
  });
});
