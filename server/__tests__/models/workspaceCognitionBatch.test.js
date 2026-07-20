jest.mock("../../utils/prisma", () => ({}));
jest.mock("../../utils/llmTasks", () => ({ getTaskConnector: jest.fn() }));
jest.mock("../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getEmbeddingEngineSelection: jest.fn(),
}));
jest.mock("../../models/workspaceChats", () => ({ WorkspaceChats: {} }));

const {
  extractionPlanForPending,
  segmentCatalog,
  validateScreening,
  validateRefinement,
  refineGroupSize,
} = require("../../models/workspaceCognitionBatch");

describe("WorkspaceCognitionBatch", () => {
  test("creates a rough-screen plan exactly at five turns", () => {
    expect(extractionPlanForPending(4)).toBeNull();
    expect(extractionPlanForPending(5)).toEqual({
      take: 5,
      pipeline: "rough_screen",
      triggerReason: "batch5",
    });
  });

  test("still rough-screens an explicit under-five flush", () => {
    expect(extractionPlanForPending(3, "silence")).toEqual({
      take: 3,
      pipeline: "rough_screen",
      triggerReason: "silence",
    });
  });

  test("aggregates exactly three rough results and waits on incomplete work", () => {
    expect(refineGroupSize({ readyCount: 3 })).toBe(3);
    expect(refineGroupSize({ readyCount: 8 })).toBe(3);
    expect(refineGroupSize({ readyCount: 2, activeRough: 1 })).toBe(0);
    expect(refineGroupSize({ readyCount: 2 })).toBe(0);
  });

  test("allows a one-or-two result partial refine only on flush or timeout", () => {
    const now = Date.now();
    expect(refineGroupSize({ readyCount: 2, forcePartial: true, now })).toBe(2);
    expect(
      refineGroupSize({
        readyCount: 1,
        oldestReadyAt: new Date(now - 10 * 60 * 1000 - 1),
        now,
      })
    ).toBe(1);
  });

  test("screening only accepts stable segment ids", () => {
    const segments = segmentCatalog([
      {
        id: 1,
        user_id: 7,
        thread_id: 3,
        prompt: "预算上限是 500 万元。",
        response: JSON.stringify({ text: "我推测交付存在延期风险。" }),
      },
    ]);
    expect(
      validateScreening({ keep: [segments[0].segmentId] }, segments)
    ).toEqual([segments[0]]);
    expect(() =>
      validateScreening({ keep: ["missing-segment"] }, segments)
    ).toThrow("screening_reference_invalid");
  });

  test("never accepts an assistant inference as a user position", () => {
    const segments = [
      {
        segmentId: "assistant-segment",
        chatId: 1,
        threadId: 3,
        speaker: "assistant",
        userId: null,
        text: "我推测交付存在延期风险。",
      },
    ];
    expect(() =>
      validateRefinement(
        {
          items: [
            {
              assertionType: "user_position",
              statement: "交付会延期",
              origin: "assistant",
              evidenceSegmentIds: ["assistant-segment"],
              sourceRefs: [],
            },
          ],
        },
        { segments, sources: [], activeItems: [] }
      )
    ).toThrow("user_position_origin_invalid");
  });

  test("does not merge two users into one position", () => {
    const segments = [7, 8].map((userId) => ({
      segmentId: `user-${userId}`,
      chatId: userId,
      threadId: userId,
      speaker: "user",
      userId,
      text: `用户 ${userId} 的观点`,
    }));
    expect(() =>
      validateRefinement(
        {
          items: [
            {
              assertionType: "user_position",
              statement: "两个用户共享同一观点",
              origin: "user",
              evidenceSegmentIds: ["user-7", "user-8"],
              sourceRefs: [],
            },
          ],
        },
        { segments, sources: [], activeItems: [] }
      )
    ).toThrow("user_position_origin_invalid");
  });

  test("allows the model to return no candidates", () => {
    expect(
      validateRefinement(
        { items: [] },
        { segments: [], sources: [], activeItems: [] }
      )
    ).toEqual([]);
  });
});
