/* global jest, describe, beforeEach, test, expect */

const mockGetChatCompletion = jest.fn();
const mockCompressMessages = jest.fn(async ({ userPrompt }) => [
  { role: "user", content: userPrompt },
]);
const mockUpdateNodeChineseFields = jest.fn(async (node) => node);
const mockInvalidateGraphRetrievalCache = jest.fn(async () => null);

jest.mock("../../../utils/AiProviders/deepseek", () => ({
  DeepSeekLLM: jest.fn().mockImplementation(() => ({
    compressMessages: mockCompressMessages,
    getChatCompletion: mockGetChatCompletion,
  })),
}));

jest.mock("../../../models/knowledgeGraph", () => ({
  KnowledgeGraph: {
    updateNodeChineseFields: mockUpdateNodeChineseFields,
    findLabelTranslationCache: jest.fn(),
    updateNodeDisplayLabels: jest.fn(),
    setLabelTranslationCache: jest.fn(),
    canonicalKey: jest.fn((value = "") => String(value).toLowerCase()),
  },
}));

jest.mock("../../../utils/knowledgeGraph/retrievalCache", () => ({
  invalidateGraphRetrievalCache: mockInvalidateGraphRetrievalCache,
}));

const {
  buildExtractionPrompt,
} = require("../../../utils/knowledgeGraph/promptRegistry");
const {
  normalizeExtractionResult,
} = require("../../../utils/knowledgeGraph/schema");
const {
  needsChineseNodeBackfill,
  normalizeBackfillItems,
  backfillChineseNodeFields,
} = require("../../../utils/knowledgeGraph/chineseBackfill");

describe("knowledge graph Chinese extraction/backfill", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("extraction prompt requires Chinese-first graph fields and string aliases", () => {
    const prompt = buildExtractionPrompt({ text: "Thales proposed water." });
    expect(prompt).toContain("输出语言必须以简体中文为主");
    expect(prompt).toContain("name、summary、snippet 必须优先中文");
    expect(prompt).toContain("aliases 必须是字符串数组");
  });

  test("extraction schema normalizes object aliases instead of rendering object text", () => {
    const graph = normalizeExtractionResult({
      entities: [
        {
          name: "泰勒斯",
          type: "person",
          summary: "首位希腊哲学家。",
          aliases: [{ en: "Thales", zh: "泰勒斯" }],
        },
      ],
      relations: [],
    });
    expect(graph.entities[0].aliases).toEqual(["泰勒斯", "Thales"]);
    expect(graph.entities[0].aliases).not.toContain("[object Object]");
  });

  test("detects only missing Chinese labels or English-only summaries", () => {
    expect(
      needsChineseNodeBackfill({
        id: 1,
        canonicalName: "Thales",
        displayNameZh: "泰勒斯",
        summary: "首位希腊哲学家。",
      })
    ).toBe(false);
    expect(
      needsChineseNodeBackfill({
        id: 2,
        canonicalName: "Thales",
        displayNameZh: "",
        summary: "首位希腊哲学家。",
      })
    ).toBe(true);
    expect(
      needsChineseNodeBackfill({
        id: 3,
        canonicalName: "Thales",
        displayNameZh: "泰勒斯",
        summary: "First Greek philosopher.",
      })
    ).toBe(true);
  });

  test("backfill persists parsed Chinese fields and invalidates graph cache", async () => {
    mockGetChatCompletion.mockResolvedValueOnce({
      textResponse: JSON.stringify({
        items: [
          {
            id: 7,
            displayNameZh: "泰勒斯",
            summaryZh: "首位希腊哲学家，提出水是万物本原。",
            aliases: [{ en: "Thales", zh: "泰勒斯" }],
          },
        ],
      }),
    });

    const result = await backfillChineseNodeFields({
      workspaceId: 1,
      nodes: [
        {
          id: 7,
          canonicalName: "Thales",
          displayNameZh: "",
          displayNameEn: "Thales",
          summary: "First Greek philosopher.",
          aliases: ["Thales"],
        },
      ],
    });

    expect(result).toEqual({ updated: 1, total: 1 });
    expect(mockUpdateNodeChineseFields).toHaveBeenCalledWith({
      id: 7,
      displayNameZh: "泰勒斯",
      summary: "首位希腊哲学家，提出水是万物本原。",
      aliases: [{ en: "Thales", zh: "泰勒斯" }],
    });
    expect(mockInvalidateGraphRetrievalCache).toHaveBeenCalledWith(1);
  });

  test("backfill JSON parser drops unusable non-Chinese rows", () => {
    expect(
      normalizeBackfillItems({
        items: [
          { id: 1, displayNameZh: "气", summaryZh: "阿那克西美尼的本原。" },
          { id: 2, displayNameZh: "air", summaryZh: "arche" },
        ],
      })
    ).toHaveLength(1);
  });
});
