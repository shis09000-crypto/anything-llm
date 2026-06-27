jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: {
    getValueOrFallback: jest.fn(async () => "3"),
  },
}));

const {
  requestUserInput,
  normalizeChoiceQuestion,
  MAX_CHOICE_OPTIONS,
} = require("../../../utils/agents/aibitat/plugins/request-user-input");

function registerRequestUserInputTool() {
  let registeredTool = null;
  const aibitat = {
    requestUserClarification: jest.fn(async () => ({
      skipped: false,
      timedOut: false,
      answers: [{ skipped: false, answer: "Option B" }],
    })),
    function: jest.fn((definition) => {
      registeredTool = definition;
    }),
    introspect: jest.fn(),
    addClarifyingQuestionSurvey: jest.fn(),
    addClarifyingQuestionPromptTail: jest.fn(),
  };

  requestUserInput.plugin[0].plugin().setup(aibitat);
  return { aibitat, tool: registeredTool };
}

describe("request-user-input", () => {
  it("normalizes valid choice questions and forces the custom answer option", () => {
    const result = normalizeChoiceQuestion({
      kind: "choice",
      question: "Which path should I use?",
      options: ["  Option A  ", "Option B", "Option C"],
      optionDescriptions: ["Best", "Backup", "Fallback"],
      multiSelect: true,
      allowOther: false,
    });

    expect(result.error).toBeUndefined();
    expect(result.question).toEqual({
      kind: "choice",
      question: "Which path should I use?",
      options: ["Option A", "Option B", "Option C"],
      optionDescriptions: ["Best", "Backup", "Fallback"],
      multiSelect: false,
      allowOther: true,
    });
  });

  it("rejects legacy input questions before prompting the frontend", async () => {
    const { aibitat, tool } = registerRequestUserInputTool();

    const result = await tool.handler.call(
      { super: aibitat },
      {
        questions: [
          {
            kind: "input",
            question: "Who is the visitor?",
            inputType: "text",
          },
        ],
      }
    );

    expect(result).toContain("requires choice questions only");
    expect(result).toContain("Do not use kind='input'");
    expect(aibitat.requestUserClarification).not.toHaveBeenCalled();
  });

  it("rejects choice questions without exactly three non-empty options", async () => {
    const { aibitat, tool } = registerRequestUserInputTool();

    const result = await tool.handler.call(
      { super: aibitat },
      {
        questions: [
          {
            kind: "choice",
            question: "Pick one",
            options: ["Option A", "", "Option C"],
          },
        ],
      }
    );

    expect(result).toContain(
      `exactly ${MAX_CHOICE_OPTIONS} non-empty options`
    );
    expect(aibitat.requestUserClarification).not.toHaveBeenCalled();
  });

  it("sends valid choice questions to the frontend with allowOther enabled", async () => {
    const { aibitat, tool } = registerRequestUserInputTool();

    const result = await tool.handler.call(
      { super: aibitat },
      {
        questions: [
          {
            kind: "choice",
            question: "Which path should I use?",
            options: ["Option A", "Option B", "Option C"],
          },
        ],
      }
    );

    expect(aibitat.requestUserClarification).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            kind: "choice",
            options: ["Option A", "Option B", "Option C"],
            multiSelect: false,
            allowOther: true,
          }),
        ],
      })
    );
    expect(result).toContain("A: Option B");
  });
});
