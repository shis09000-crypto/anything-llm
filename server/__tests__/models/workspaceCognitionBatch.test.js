jest.mock("../../utils/prisma", () => ({}));
jest.mock("../../utils/llmTasks", () => ({ getTaskConnector: jest.fn() }));
jest.mock("../../utils/aiGovernance", () => ({
  beginModelExecution: jest.fn(),
  estimatedTokens: (messages) =>
    Math.ceil(Buffer.byteLength(JSON.stringify(messages || []), "utf8") / 4),
}));
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
  validateUserGate,
  repairPrompt,
  assertPromptBudget,
  shouldScheduleSilentRough,
  refinePrompt,
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

  test("silent tail scheduling counts only unscreened pending turns", () => {
    expect(shouldScheduleSilentRough(0)).toBe(false);
    expect(shouldScheduleSilentRough(1)).toBe(true);
    expect(shouldScheduleSilentRough(4)).toBe(true);
    expect(shouldScheduleSilentRough(5)).toBe(false);
    expect(shouldScheduleSilentRough(12)).toBe(false);
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
    expect(
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
    ).toEqual([]);
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
    expect(
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
    ).toEqual([]);
  });

  test("allows the model to return no candidates", () => {
    expect(
      validateRefinement(
        { items: [] },
        { segments: [], sources: [], activeItems: [] }
      )
    ).toEqual([]);
  });

  test("user gate only accepts user segment and chat references", () => {
    const segments = [
      {
        segmentId: "u1",
        stableSegmentId: "stable-u1",
        chatId: 12,
        speaker: "user",
        userId: 7,
        text: "我认为这一假说还需要实验验证。",
      },
    ];
    expect(
      validateUserGate({ keep: ["u1"], assistantChatIds: [12] }, segments)
    ).toEqual({ kept: segments, assistantChatIds: [12] });
    expect(() =>
      validateUserGate({ keep: ["u1"], assistantChatIds: [99] }, segments)
    ).toThrow("user_gate_chat_reference_invalid");
  });

  test("micro repair prompt never contains the original chat prompt", () => {
    const messages = repairPrompt("{bad", "model_json_invalid", {
      schema: { keep: [] },
      allowedSegmentIds: ["u1"],
    });
    const encoded = JSON.stringify(messages);
    expect(encoded).toContain("u1");
    expect(encoded).not.toContain("预算上限是 500 万元");
    expect(messages).toHaveLength(2);
  });

  test("budget blocking preserves the job until explicit override", () => {
    const oversized = [{ role: "user", content: "x".repeat(500) }];
    expect(() =>
      assertPromptBudget({ metadataJson: "{}" }, oversized, 10, "gate")
    ).toThrow("cognitive_budget_blocked");
    expect(
      assertPromptBudget(
        { metadataJson: JSON.stringify({ budgetOverrideOnce: true }) },
        oversized,
        10,
        "gate"
      ).decision
    ).toBe("override_once");
  });

  test("rejects standalone assistant conclusions but accepts grounded user positions", () => {
    const segments = [
      {
        segmentId: "u1",
        chatId: 1,
        threadId: 3,
        speaker: "user",
        userId: 7,
        text: "我认为这个模型解释力不足。",
      },
      {
        segmentId: "a1",
        chatId: 1,
        threadId: 3,
        speaker: "assistant",
        userId: null,
        text: "这个模型可能解释力不足。",
      },
    ];
    const quality = {
      retentionReason: "explicit_position",
      workspaceRelevance: 0.95,
      durability: 0.9,
      userCentrality: 1,
    };
    expect(
      validateRefinement(
        {
          items: [
            {
              assertionType: "user_position",
              statement: "用户认为该模型解释力不足",
              origin: "user",
              evidenceSegmentIds: ["u1"],
              sourceRefs: [],
              ...quality,
            },
          ],
        },
        { segments, sources: [], activeItems: [], pendingItems: [] }
      )
    ).toHaveLength(1);
    expect(
      validateRefinement(
        {
          items: [
            {
              assertionType: "conclusion",
              statement: "这个模型解释力不足",
              origin: "assistant",
              evidenceSegmentIds: ["a1"],
              sourceRefs: [],
              ...quality,
            },
          ],
        },
        { segments, sources: [], activeItems: [], pendingItems: [] }
      )
    ).toEqual([]);
  });

  test("only accepts document facts backed by a valid document or graph source", () => {
    const segments = [
      {
        segmentId: "u1",
        chatId: 1,
        threadId: 3,
        speaker: "user",
        userId: 7,
        text: "文档说明有丝分裂检查点会阻止异常分离。",
      },
    ];
    const item = {
      assertionType: "document_fact",
      statement: "有丝分裂检查点会阻止异常分离",
      origin: "document",
      evidenceSegmentIds: ["u1"],
      retentionReason: "source_backed_fact",
      workspaceRelevance: 0.95,
      durability: 0.9,
      userCentrality: 0.2,
    };
    expect(
      validateRefinement(
        { items: [{ ...item, sourceRefs: [] }] },
        { segments, sources: [], activeItems: [], pendingItems: [] }
      )
    ).toEqual([]);
    expect(
      validateRefinement(
        { items: [{ ...item, sourceRefs: ["doc:1"] }] },
        {
          segments,
          sources: [{ ref: "doc:1", sourceType: "document_chunk" }],
          activeItems: [],
          pendingItems: [],
        }
      )
    ).toHaveLength(1);
  });

  test("assistant hypotheses require paired user and assistant evidence", () => {
    const segments = [
      {
        segmentId: "u1",
        chatId: 1,
        threadId: 3,
        speaker: "user",
        userId: 7,
        text: "我想解释检查点异常的来源。",
      },
      {
        segmentId: "a1",
        chatId: 1,
        threadId: 3,
        speaker: "assistant",
        userId: null,
        text: "可能与纺锤体组装检查点缺陷有关。",
      },
    ];
    const item = {
      assertionType: "hypothesis",
      statement: "检查点异常可能与纺锤体组装检查点缺陷有关",
      origin: "assistant",
      sourceRefs: [],
      retentionReason: "relevant_inference",
      workspaceRelevance: 0.9,
      durability: 0.8,
      userCentrality: 0.8,
    };
    expect(
      validateRefinement(
        { items: [{ ...item, evidenceSegmentIds: ["a1"] }] },
        { segments, sources: [], activeItems: [], pendingItems: [] }
      )
    ).toEqual([]);
    expect(
      validateRefinement(
        { items: [{ ...item, evidenceSegmentIds: ["u1", "a1"] }] },
        { segments, sources: [], activeItems: [], pendingItems: [] }
      )
    ).toHaveLength(1);
  });

  test("refine protocol distinguishes durable workspace governance from one-off tool noise", () => {
    const encoded = JSON.stringify(
      refinePrompt({
        episodes: [],
        sources: [],
        activeItems: [],
        pendingItems: [],
      })
    );
    expect(encoded).toContain("一次性的权限排查");
    expect(encoded).toContain("长期工作区治理 constraint/decision");
  });
});
