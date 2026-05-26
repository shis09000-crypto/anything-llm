const {
  QUIZ_STRUCTURED_RESULTS_COUNT_MISMATCH,
  QUIZ_STRUCTURED_RESULTS_INVALID_JSON,
  QUIZ_STRUCTURED_RESULTS_INVALID_SOURCE_REFS,
  QUIZ_STRUCTURED_RESULTS_MISSING,
  QUIZ_STRUCTURED_RESULTS_MISSING_IS_CORRECT,
  createTaggedAnalysisStreamParser,
  parseStructuredResults,
} = require("../../../utils/quiz/analysis");

const quiz = {
  plan: { difficulty: "high" },
  questions: [
    {
      id: "q1",
      type: "single_choice",
      question: "题目 1",
      options: [{ id: "A", text: "A" }],
      correctAnswer: "A",
      sourceRefs: ["s1"],
    },
  ],
};

describe("quiz final analysis", () => {
  let consoleError;

  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("streams only markdown while buffering tags and structured JSON across chunks", () => {
    const streamed = [];
    const parser = createTaggedAnalysisStreamParser({
      onMarkdown: (text) => streamed.push(text),
    });

    for (const chunk of [
      "<analysis_mar",
      "kdown>可见",
      "分析</analysis_mark",
      "down><structured_res",
      'ults>{"questionResults":[{"questionId":"q1","isCorrect":true,"score":1}]}',
      "</structured_results>",
    ]) {
      parser.push(chunk);
    }

    const result = parser.finish();
    expect(streamed.join("")).toBe("可见分析");
    expect(result.markdown).toBe("可见分析");
    expect(result.structuredText).toContain('"questionResults"');
    expect(result.markdown).not.toContain("<analysis_markdown>");
    expect(result.markdown).not.toContain("<structured_results>");
  });

  it("parses reliable structured question results", () => {
    const result = parseStructuredResults({
      quiz,
      answers: { q1: "A" },
      structuredText:
        '{"questionResults":[{"questionId":"q1","isCorrect":true,"score":1,"analysis":"正确","sourceRefs":["s1"]}]}',
    });

    expect(result.reliable).toBe(true);
    expect(result.error).toBe(null);
    expect(result.questionResults[0]).toEqual(
      expect.objectContaining({
        questionId: "q1",
        isCorrect: true,
        score: 1,
      })
    );
  });

  it("marks malformed structured results as unreliable fallback", () => {
    const result = parseStructuredResults({
      quiz,
      answers: { q1: "B" },
      structuredText: '{"questionResults":[',
    });

    expect(result.reliable).toBe(false);
    expect(result.error).toBe(QUIZ_STRUCTURED_RESULTS_INVALID_JSON);
    expect(result.questionResults[0].isCorrect).toBe(null);
  });

  it("marks missing isCorrect as unreliable", () => {
    const result = parseStructuredResults({
      quiz,
      answers: { q1: "B" },
      structuredText:
        '{"questionResults":[{"questionId":"q1","score":0,"analysis":"缺少判定"}]}',
    });

    expect(result.reliable).toBe(false);
    expect(result.error).toBe(QUIZ_STRUCTURED_RESULTS_MISSING_IS_CORRECT);
    expect(result.questionResults[0].isCorrect).toBe(null);
  });

  it("marks missing structured_results with a dedicated error code", () => {
    const result = parseStructuredResults({
      quiz,
      answers: { q1: "B" },
      structuredText: "",
    });

    expect(result.reliable).toBe(false);
    expect(result.error).toBe(QUIZ_STRUCTURED_RESULTS_MISSING);
  });

  it("marks invalid structured sourceRefs as unreliable", () => {
    const result = parseStructuredResults({
      quiz: {
        ...quiz,
        evidenceChunks: [{ id: "s1" }],
        sourceRefs: [{ id: "s1" }],
      },
      answers: { q1: "A" },
      structuredText:
        '{"questionResults":[{"questionId":"q1","isCorrect":true,"score":1,"analysis":"正确","sourceRefs":["made-up"]}]}',
    });

    expect(result.reliable).toBe(false);
    expect(result.error).toBe(QUIZ_STRUCTURED_RESULTS_INVALID_SOURCE_REFS);
  });

  it("marks result count mismatches separately", () => {
    const result = parseStructuredResults({
      quiz,
      answers: { q1: "A" },
      structuredText: '{"questionResults":[]}',
    });

    expect(result.reliable).toBe(false);
    expect(result.error).toBe(QUIZ_STRUCTURED_RESULTS_COUNT_MISMATCH);
  });
});
