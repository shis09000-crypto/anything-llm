const {
  PENDING_RETRY_MS,
  isPendingStale,
  parseTagline,
  sourcePayload,
} = require("../../../utils/workspaceOverview/narrative");

describe("workspace overview narrative", () => {
  test("only stale pending rows are eligible for retry", () => {
    const now = Date.parse("2026-05-28T08:00:00.000Z");

    expect(
      isPendingStale(
        {
          status: "pending",
          updatedAt: new Date(now - PENDING_RETRY_MS - 1).toISOString(),
        },
        now
      )
    ).toBe(true);

    expect(
      isPendingStale(
        {
          status: "pending",
          updatedAt: new Date(now - PENDING_RETRY_MS + 1).toISOString(),
        },
        now
      )
    ).toBe(false);

    expect(
      isPendingStale(
        {
          status: "ready",
          updatedAt: new Date(now - PENDING_RETRY_MS - 1).toISOString(),
        },
        now
      )
    ).toBe(false);
  });

  test("source hash ignores supplement row timing and document identity", () => {
    const baseSupplement = {
      supplementKind: "structure_json",
      id: 1,
      documentId: "doc-a",
      documentName: "A",
      updatedAt: "2026-05-28T08:00:00.000Z",
      metadata: {
        parsedStructure: { 主轴: "哲学主线", 次轴: ["知识", "政治"] },
        structureJsonValidation: { valid: true },
      },
    };
    const bookStructure = {
      structureType: "concept_driven",
      primaryAxis: "哲学主线",
      secondaryAxes: ["知识", "政治"],
      updatedAt: "2026-05-28T08:00:00.000Z",
      structureVersion: "book-structure-v1",
    };

    const first = sourcePayload({
      workspaceSupplements: [baseSupplement],
      bookStructure,
    });
    const second = sourcePayload({
      workspaceSupplements: [
        {
          ...baseSupplement,
          id: 2,
          documentId: "doc-b",
          documentName: "B",
          updatedAt: "2026-05-28T09:00:00.000Z",
        },
      ],
      bookStructure: {
        ...bookStructure,
        updatedAt: "2026-05-28T09:00:00.000Z",
      },
    });

    expect(first.hash).toEqual(second.hash);
  });

  test("parses tagline JSON after DeepSeek reasoning content", () => {
    expect(
      parseTagline(
        '<think>先分析输入，然后输出 JSON。</think>{"tagline":"从古希腊理性开端到现代性批判，追踪主体、知识、自由与社会秩序的思想演进。"}'
      )
    ).toBe(
      "从古希腊理性开端到现代性批判，追踪主体、知识、自由与社会秩序的思想演进。"
    );
  });
});
