jest.mock("../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: jest.fn(() => ({})),
}));
jest.mock("../../utils/llmTasks", () => ({
  getTaskConnector: jest.fn(),
}));

describe("workspace cognition extractor boundaries", () => {
  it("uses the server-selected speaker even when model output claims user origin", () => {
    const {
      normalizeItems,
    } = require("../../utils/workspaceCognition/extractor");
    const items = normalizeItems(
      {
        items: [
          {
            assertionType: "conclusion",
            statement: "这是 AI 生成的结论",
            origin: "user",
            confidence: 0.7,
          },
        ],
      },
      "assistant"
    );

    expect(items).toHaveLength(1);
    expect(items[0].origin).toBe("assistant");
  });
});
