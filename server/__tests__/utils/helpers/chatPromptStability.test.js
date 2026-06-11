const {
  fillSourceWindow,
  messageArrayCompressor,
} = require("../../../utils/helpers/chat");
const {
  convertToPromptHistory,
} = require("../../../utils/helpers/chat/responses");

function chat(id, sources = [], text = `answer ${id}`) {
  return {
    id,
    prompt: `prompt ${id}`,
    response: JSON.stringify({
      text,
      sources,
    }),
  };
}

describe("chat prompt stability helpers", () => {
  it("messageArrayCompressor does not mutate rawHistory order", async () => {
    const rawHistory = [chat(1), chat(2), chat(3)];
    const originalIds = rawHistory.map((row) => row.id);
    const llm = {
      model: "gpt-4o",
      limits: {
        history: 10_000,
        system: 10_000,
        user: 10_000,
      },
      promptWindowLimit: () => 20,
    };

    await messageArrayCompressor(
      llm,
      [
        { role: "system", content: "system" },
        { role: "user", content: "current" },
      ],
      rawHistory
    );

    expect(rawHistory.map((row) => row.id)).toEqual(originalIds);
  });

  it("fillSourceWindow does not mutate history order and dedupes sources without ids", () => {
    const duplicateA = {
      score: 0.9,
      text: "duplicate source text",
    };
    const duplicateB = {
      score: 0.8,
      text: "duplicate source text",
    };
    const unique = {
      score: 0.7,
      text: "unique source text",
    };
    const history = [
      chat(1, [duplicateA]),
      chat(2, [duplicateB]),
      chat(3, [unique]),
    ];
    const originalIds = history.map((row) => row.id);

    const result = fillSourceWindow({
      nDocs: 2,
      searchResults: [],
      history,
      filterIdentifiers: [],
    });

    expect(history.map((row) => row.id)).toEqual(originalIds);
    expect(result.contextTexts).toEqual([
      "unique source text",
      "duplicate source text",
    ]);
  });

  it("convertToPromptHistory strips reasoning blocks from assistant prompt history", () => {
    const history = [
      chat(
        1,
        [],
        "<think>hidden reasoning</think><reasoning>more hidden</reasoning>visible answer"
      ),
    ];

    const promptHistory = convertToPromptHistory(history);

    expect(promptHistory).toEqual([
      { role: "user", content: "prompt 1" },
      { role: "assistant", content: "visible answer" },
    ]);
  });
});
