const mockCompleteJsonStreamWithRetry = jest.fn();

jest.mock("../../../utils/quiz/llm", () => ({
  completeJsonStreamWithRetry: mockCompleteJsonStreamWithRetry,
}));

const {
  singleChoiceGenerator,
} = require("../../../utils/quiz/generators/singleChoiceGenerator");

describe("quiz type generators", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCompleteJsonStreamWithRetry.mockResolvedValue({
      json: {
        questions: [
          {
            id: "q1",
            type: "single_choice",
            question: "What is true?",
            options: [
              { id: "A", text: "A" },
              { id: "B", text: "B" },
              { id: "C", text: "C" },
              { id: "D", text: "D" },
            ],
            correctAnswer: "A",
            sourceRefs: ["evidence-1"],
          },
        ],
      },
      metrics: {},
      model: "deepseek-v4-pro",
    });
  });

  it("uses DeepSeek Flash for background question generation", async () => {
    const result = await singleChoiceGenerator({
      type: "single_choice",
      count: 1,
      topic: "Topic",
      keywords: [],
      difficulty: "high",
      evidenceChunks: [
        {
          id: "evidence-1",
          text: "Evidence",
          score: 1,
          sourceRef: { id: "evidence-1", title: "Doc" },
        },
      ],
    });

    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].difficulty).toBe("high");
    expect(mockCompleteJsonStreamWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-v4-flash",
        label: "quiz_generate_single_choice",
      })
    );
  });

  it("keeps generation prompts focused on minimal question JSON", async () => {
    await singleChoiceGenerator({
      type: "single_choice",
      count: 1,
      topic: "Topic",
      keywords: [],
      difficulty: "high",
      evidenceChunks: [
        {
          id: "evidence-1",
          text: "Evidence",
          score: 1,
          sourceRef: { id: "evidence-1", title: "Doc" },
        },
      ],
    });

    const prompt = mockCompleteJsonStreamWithRetry.mock.calls[0][0].userPrompt;
    expect(prompt).toContain('"questions"');
    expect(prompt).toContain('"correctAnswer"');
    expect(prompt).toContain('"sourceRefs"');
    expect(prompt).toContain("independently judge which evidence chunks");
    expect(prompt).toContain("per-question evidence judgment");
    expect(prompt).not.toContain('"explanation"');
    expect(prompt).not.toContain('"difficulty"');
  });

  it("runs a repair generation when the first output has no valid questions", async () => {
    mockCompleteJsonStreamWithRetry
      .mockResolvedValueOnce({
        json: {
          questions: [
            {
              id: "bad",
              type: "single_choice",
              question: "Invalid source ref",
              options: [
                { id: "A", text: "A" },
                { id: "B", text: "B" },
                { id: "C", text: "C" },
                { id: "D", text: "D" },
              ],
              correctAnswer: "A",
              sourceRefs: ["missing-evidence"],
            },
          ],
        },
        metrics: {},
        model: "deepseek-v4-pro",
      })
      .mockResolvedValueOnce({
        json: {
          questions: [
            {
              id: "q1",
              type: "single_choice",
              question: "What is true?",
              options: [
                { id: "A", text: "A" },
                { id: "B", text: "B" },
                { id: "C", text: "C" },
                { id: "D", text: "D" },
              ],
              correctAnswer: "A",
              sourceRefs: ["evidence-1"],
            },
          ],
        },
        metrics: { repaired: true },
        model: "deepseek-v4-pro",
      });

    const result = await singleChoiceGenerator({
      type: "single_choice",
      count: 1,
      topic: "Topic",
      keywords: [],
      difficulty: "high",
      evidenceChunks: [
        {
          id: "evidence-1",
          text: "Evidence",
          score: 1,
          sourceRef: { id: "evidence-1", title: "Doc" },
        },
      ],
    });

    expect(result.questions).toHaveLength(1);
    expect(mockCompleteJsonStreamWithRetry).toHaveBeenCalledTimes(2);
    const repairCall = mockCompleteJsonStreamWithRetry.mock.calls[1][0];
    expect(repairCall).toEqual(
      expect.objectContaining({ label: "quiz_repair_single_choice" })
    );
    expect(repairCall.userPrompt).not.toContain("and explanation");
    expect(repairCall.userPrompt).not.toContain('"explanation"');
  });

  it("throws when repair generation still returns no valid questions", async () => {
    mockCompleteJsonStreamWithRetry.mockResolvedValue({
      json: { questions: [] },
      metrics: {},
      model: "deepseek-v4-pro",
    });

    await expect(
      singleChoiceGenerator({
        type: "single_choice",
        count: 1,
        topic: "Topic",
        keywords: [],
        difficulty: "high",
        evidenceChunks: [
          {
            id: "evidence-1",
            text: "Evidence",
            score: 1,
            sourceRef: { id: "evidence-1", title: "Doc" },
          },
        ],
      })
    ).rejects.toThrow("quiz_single_choice_empty_valid_questions");
  });
});
