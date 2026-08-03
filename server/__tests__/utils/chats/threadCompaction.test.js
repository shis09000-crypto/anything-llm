const mockWorkspaceChatsWhere = jest.fn();
const mockWorkspaceChatsCount = jest.fn();
const mockLatest = jest.fn();
const mockCompactionWhere = jest.fn();
const mockCreate = jest.fn();
const mockGetLLMProvider = jest.fn();

function mockNormalizeScope(scope = {}) {
  const workspaceId = scope.workspace_id ?? scope.workspaceId;
  if (!workspaceId) throw new Error("workspace_id is required");
  return {
    workspace_id: Number(workspaceId),
    user_id:
      scope.user_id === undefined || scope.user_id === null
        ? null
        : Number(scope.user_id),
    thread_id:
      scope.thread_id === undefined || scope.thread_id === null
        ? null
        : Number(scope.thread_id),
    api_session_id:
      scope.api_session_id === undefined || scope.api_session_id === null
        ? null
        : String(scope.api_session_id),
  };
}

jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: {
    where: mockWorkspaceChatsWhere,
    count: mockWorkspaceChatsCount,
  },
}));

jest.mock("../../../models/workspaceChatCompaction", () => ({
  WorkspaceChatCompaction: {
    SUMMARY_FORMAT: "thread-compact-markdown-v1",
    CAPSULE_FORMAT: "conversation-state-capsule-json-v1",
    normalizeScope: mockNormalizeScope,
    latest: mockLatest,
    where: mockCompactionWhere,
    create: mockCreate,
  },
}));

jest.mock("../../../utils/helpers", () => ({
  getLLMProvider: mockGetLLMProvider,
}));

const chat = (id, prompt = `prompt ${id}`, text = `answer ${id}`) => ({
  id,
  prompt,
  response: JSON.stringify({ text, sources: [] }),
  include: true,
});

const capsule = (overrides = {}) =>
  JSON.stringify({
    topic: "账号权限体系",
    currentGoal: "设计账号删除与封禁架构",
    confirmedFacts: ["系统采用 Shared Auth DB", "TTL 为 3 次压缩"],
    confirmedDecisions: ["公开注册只能创建 user"],
    openQuestions: ["ZK Login 最终落地方案"],
    temporaryContext: [{ text: "当前测试失败", expiresAfterCompactions: 3 }],
    recentDirection: "最近在讨论 Thread Compaction 的状态胶囊重构",
    architectureDecisions: ["Owner Hierarchy", "DeepSeek v4 flash"],
    generatedAt: "2026-06-14T00:00:00.000Z",
    coveredToChatId: "2",
    ...overrides,
  });

describe("Thread compaction memory", () => {
  const workspace = {
    id: 1,
    slug: "workspace",
    chatProvider: "openai",
    chatModel: "gpt-4o",
    openAiHistory: 20,
  };
  const thread = { id: 9, slug: "thread-slug" };
  const user = { id: 7 };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.THREAD_COMPACTION_ENABLED;
    delete process.env.THREAD_COMPACTION_AUTO_ENABLED;
    delete process.env.THREAD_COMPACTION_CONTEXT_WINDOW_TOKENS;
    delete process.env.THREAD_COMPACTION_TARGET_BASE;
    delete process.env.THREAD_COMPACTION_TARGET_ABSOLUTE_TOKENS;
    delete process.env.THREAD_COMPACTION_MANUAL_TARGET_RATIO;
    delete process.env.THREAD_COMPACTION_AUTO_TARGET_RATIO;
    delete process.env.THREAD_COMPACTION_TARGET_MIN_SUMMARY_TOKENS;
    delete process.env.THREAD_COMPACTION_TARGET_MAX_SUMMARY_TOKENS;
    delete process.env.THREAD_COMPACTION_TARGET_SUMMARY_BUDGET_RATIO;
    delete process.env.LLM_TASK_ROUGH_PROVIDER;
    delete process.env.LLM_TASK_ROUGH_MODEL;
    mockWorkspaceChatsWhere.mockResolvedValue([chat(1)]);
    mockWorkspaceChatsCount.mockResolvedValue(1);
    mockLatest.mockResolvedValue(null);
    mockCompactionWhere.mockResolvedValue([]);
    mockCreate.mockImplementation(async (row) => ({ id: 123, ...row }));
    mockGetLLMProvider.mockReturnValue({
      model: "gpt-4o",
      promptWindowLimit: () => 4000,
      constructPrompt: ({
        systemPrompt = "",
        userPrompt = "",
        contextTexts = [],
        chatHistory = [],
      }) => [
        { role: "system", content: systemPrompt + contextTexts.join("\n") },
        ...chatHistory,
        { role: "user", content: userPrompt },
      ],
      compressMessages: jest.fn(async ({ systemPrompt, userPrompt }) => [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]),
      getChatCompletion: jest.fn(async () => ({
        textResponse: capsule(),
        metrics: {},
      })),
    });
  });

  it("leaves recentChatHistory default behavior unchanged", async () => {
    const { recentChatHistory } = require("../../../utils/chats");

    const result = await recentChatHistory({
      user,
      workspace,
      thread,
      messageLimit: 5,
      apiSessionId: "api-1",
    });

    expect(mockWorkspaceChatsWhere).toHaveBeenCalledWith(
      {
        workspaceId: 1,
        user_id: 7,
        thread_id: 9,
        api_session_id: "api-1",
        include: true,
      },
      5,
      { id: "desc" }
    );
    expect(result.rawHistory).toHaveLength(1);
  });

  it("uses cache-stable history blocks without sliding every turn", async () => {
    const {
      CACHE_STABLE_HISTORY_STRATEGY,
      recentChatHistory,
    } = require("../../../utils/chats");
    mockWorkspaceChatsWhere.mockImplementation(
      async (_clause, limit, _orderBy, offset = 0) =>
        Array.from({ length: limit }, (_, index) => chat(offset + index + 1))
    );

    for (const totalCount of [58, 59, 60]) {
      mockWorkspaceChatsCount.mockResolvedValueOnce(totalCount);
      const result = await recentChatHistory({
        user,
        workspace,
        thread,
        messageLimit: 20,
        historyStrategy: {
          type: CACHE_STABLE_HISTORY_STRATEGY,
          blockSize: 20,
          maxBlocks: 2,
        },
      });

      expect(result.rawHistory[0].id).toBe(21);
      expect(result.historyWindow.offset).toBe(20);
      expect(result.historyWindow.windowStartOrdinal).toBe(21);
      expect(result.historyWindow.windowEndOrdinal).toBe(totalCount);
    }

    mockWorkspaceChatsCount.mockResolvedValueOnce(61);
    const nextBlock = await recentChatHistory({
      user,
      workspace,
      thread,
      messageLimit: 20,
      historyStrategy: {
        type: CACHE_STABLE_HISTORY_STRATEGY,
        blockSize: 20,
        maxBlocks: 2,
      },
    });

    expect(nextBlock.rawHistory[0].id).toBe(41);
    expect(nextBlock.historyWindow.offset).toBe(40);
    expect(nextBlock.historyWindow.windowStartOrdinal).toBe(41);
    expect(nextBlock.historyWindow.windowEndOrdinal).toBe(61);
  });

  it("keeps short cache-stable history equivalent to the full short history", async () => {
    const {
      CACHE_STABLE_HISTORY_STRATEGY,
      recentChatHistory,
    } = require("../../../utils/chats");
    mockWorkspaceChatsCount.mockResolvedValueOnce(5);
    mockWorkspaceChatsWhere.mockImplementationOnce(
      async (_clause, limit, _orderBy, offset = 0) =>
        Array.from({ length: limit }, (_, index) => chat(offset + index + 1))
    );

    const result = await recentChatHistory({
      user,
      workspace,
      thread,
      messageLimit: 20,
      historyStrategy: {
        type: CACHE_STABLE_HISTORY_STRATEGY,
        blockSize: 20,
        maxBlocks: 2,
      },
    });

    expect(result.rawHistory.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(result.historyWindow.offset).toBe(0);
    expect(result.historyWindow.limit).toBe(5);
  });

  it("falls back to old history when no compact summary exists", async () => {
    const {
      recentChatHistoryWithCompaction,
    } = require("../../../utils/chats/threadCompaction");

    const result = await recentChatHistoryWithCompaction({
      user,
      workspace,
      thread,
      messageLimit: 5,
    });

    expect(mockLatest).toHaveBeenCalledWith({
      workspace_id: 1,
      user_id: 7,
      thread_id: 9,
      api_session_id: null,
    });
    expect(mockWorkspaceChatsWhere).toHaveBeenCalled();
    expect(result.compaction).toBeUndefined();
  });

  it("does not inject full raw history when the compaction store is unavailable", async () => {
    mockLatest.mockRejectedValue(
      Object.assign(new Error("database unavailable"), {
        code: "thread_memory_store_unavailable",
        httpStatus: 503,
      })
    );
    const {
      recentChatHistoryWithCompaction,
    } = require("../../../utils/chats/threadCompaction");

    await expect(
      recentChatHistoryWithCompaction({ user, workspace, thread })
    ).rejects.toMatchObject({
      code: "thread_memory_store_unavailable",
      httpStatus: 503,
    });
    expect(mockWorkspaceChatsWhere).not.toHaveBeenCalled();
  });

  it("reports active capsule coverage and only post-compaction raw messages", async () => {
    mockLatest.mockResolvedValue({
      id: 14,
      summary: "summary",
      capsule_json: capsule({ coveredToChatId: "2253" }),
      covered_to_chat_id: 2253,
      covered_message_count: 115,
      metadata_json: "{}",
    });
    mockCompactionWhere.mockResolvedValue(
      Array.from({ length: 13 }, (_, index) => chat(2254 + index))
    );
    const {
      getThreadCompactionStatus,
    } = require("../../../utils/chats/threadCompaction");

    const result = await getThreadCompactionStatus({
      user,
      workspace,
      thread,
      historyRevision: 999,
    });

    expect(result).toMatchObject({
      state: "active",
      compactionId: 14,
      coveredMessageCount: 115,
      coveredToChatId: 2253,
      newRawMessageCount: 13,
    });
    expect(mockCompactionWhere).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ afterChatId: 2253 })
    );
  });

  it("injects compact capsule as context and chats after covered_to_chat_id", async () => {
    mockLatest.mockResolvedValue({
      id: 88,
      summary: "summary",
      capsule_json: capsule({ coveredToChatId: "2" }),
      covered_to_chat_id: 2,
    });
    mockCompactionWhere.mockResolvedValue([chat(3)]);
    const {
      contextTextsWithCompaction,
      recentChatHistoryWithCompaction,
    } = require("../../../utils/chats/threadCompaction");

    const result = await recentChatHistoryWithCompaction({
      user,
      workspace,
      thread,
      messageLimit: 5,
    });
    const system = "base";
    const contextTexts = contextTextsWithCompaction([], result.compaction);

    expect(mockCompactionWhere).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 1, user_id: 7, thread_id: 9 }),
      { afterChatId: 2, limit: 5, orderBy: "desc" }
    );
    expect(result.rawHistory.map((row) => row.id)).toEqual([3]);
    expect(result.chatHistory.map((item) => item.content)).toEqual([
      "prompt 3",
      "answer 3",
    ]);
    expect(system).toBe("base");
    expect(contextTexts[0]).toContain("<athena_conversation_capsule>");
    expect(contextTexts[0]).toContain("账号权限体系");
  });

  it("applies cache-stable blocks only after covered_to_chat_id", async () => {
    mockLatest.mockResolvedValue({
      id: 88,
      summary: "summary",
      covered_to_chat_id: 40,
    });
    mockWorkspaceChatsCount.mockResolvedValueOnce(58);
    mockWorkspaceChatsWhere.mockImplementationOnce(
      async (_clause, limit, _orderBy, offset = 0) =>
        Array.from({ length: limit }, (_, index) => chat(41 + offset + index))
    );
    const { CACHE_STABLE_HISTORY_STRATEGY } = require("../../../utils/chats");
    const {
      recentChatHistoryWithCompaction,
    } = require("../../../utils/chats/threadCompaction");

    const result = await recentChatHistoryWithCompaction({
      user,
      workspace,
      thread,
      messageLimit: 20,
      historyStrategy: {
        type: CACHE_STABLE_HISTORY_STRATEGY,
        blockSize: 20,
        maxBlocks: 2,
      },
    });

    expect(mockWorkspaceChatsCount).toHaveBeenCalledWith(
      expect.objectContaining({ id: { gt: 40 } })
    );
    expect(mockWorkspaceChatsWhere).toHaveBeenCalledWith(
      expect.objectContaining({ id: { gt: 40 } }),
      38,
      { id: "asc" },
      20
    );
    expect(mockCompactionWhere).not.toHaveBeenCalled();
    expect(result.compaction.summary).toBe("summary");
    expect(result.rawHistory[0].id).toBe(61);
    expect(result.historyWindow.windowStartOrdinal).toBe(21);
  });

  it("strips provider thinking text before storing or injecting legacy summaries", async () => {
    const {
      compactionContextBlock,
      normalizeCompactionSummary,
    } = require("../../../utils/chats/threadCompaction");
    const noisy =
      "<think>model reasoning that should not be persisted" +
      "# Thread Compact Summary\n## 当前任务\n干净摘要";

    const normalized = normalizeCompactionSummary(noisy);
    const context = compactionContextBlock({
      summary: noisy,
    });

    expect(normalized).toBe("# Thread Compact Summary\n## 当前任务\n干净摘要");
    expect(context).toContain("# Thread Compact Summary");
    expect(context).not.toContain("<think>");
    expect(context).not.toContain("model reasoning");
  });

  it("prefers capsule_json over legacy summary in context", async () => {
    const {
      compactionContextBlock,
    } = require("../../../utils/chats/threadCompaction");

    const context = compactionContextBlock({
      summary: "# Thread Compact Summary\nlegacy should not win",
      capsule_json: capsule({
        topic: "Conversation State Capsule",
        confirmedFacts: ["端口 3001 已确认"],
      }),
    });

    expect(context).toContain("<athena_conversation_capsule>");
    expect(context).toContain("端口 3001 已确认");
    expect(context).not.toContain("legacy should not win");
  });

  it("decrements temporary context TTL and expires stale items", async () => {
    const {
      decrementTemporaryContextTtl,
    } = require("../../../utils/chats/threadCompaction");

    const next = decrementTemporaryContextTtl({
      temporaryContext: [
        { text: "保留一次", expiresAfterCompactions: 2 },
        { text: "本次过期", expiresAfterCompactions: 1 },
      ],
    });

    expect(next.temporaryContext).toEqual([
      { text: "保留一次", expiresAfterCompactions: 1 },
    ]);
  });

  it("normalizes precise confirmed numbers into capsule fields", async () => {
    const {
      normalizeConversationCapsule,
    } = require("../../../utils/chats/threadCompaction");

    const normalized = normalizeConversationCapsule({
      topic: "Thread Compaction",
      confirmedFacts: [
        "DeepSeek v4 flash 用于真实环境测试",
        "THREAD_COMPACTION_CONTEXT_WINDOW_TOKENS=400000",
      ],
      confirmedDecisions: ["temporaryContext 默认 TTL 为 3 次压缩"],
      architectureDecisions: ["capsule_json 优先级高于 summary"],
    });

    expect(normalized.confirmedFacts.join("\n")).toContain("400000");
    expect(normalized.confirmedDecisions.join("\n")).toContain("3");
    expect(normalized.architectureDecisions.join("\n")).toContain(
      "capsule_json"
    );
  });

  it("repairs malformed capsule JSON before normalizing it", async () => {
    const {
      parseConversationCapsule,
      normalizeConversationCapsule,
    } = require("../../../utils/chats/threadCompaction");

    const parsed = parseConversationCapsule(
      "{topic:'红色资本', currentGoal:'核对 2003 年财政部注资', confirmedFacts:['930亿元'], confirmedDecisions:[], openQuestions:[], temporaryContext:[], recentDirection:'讨论 2028 年前后压力', architectureDecisions:[], generatedAt:'2026-06-16T00:00:00.000Z', coveredToChatId:'1065',}",
      null
    );
    const normalized = normalizeConversationCapsule(parsed);

    expect(normalized.topic).toBe("红色资本");
    expect(normalized.confirmedFacts).toEqual(["930亿元"]);
    expect(normalized.recentDirection).toContain("2028");
  });

  it("retries capsule generation with a JSON repair prompt when model output is invalid", async () => {
    const connector = {
      model: "deepseek-v4-flash",
      promptWindowLimit: () => 4000,
      constructPrompt: ({
        systemPrompt = "",
        userPrompt = "",
        contextTexts = [],
        chatHistory = [],
      }) => [
        { role: "system", content: systemPrompt + contextTexts.join("\n") },
        ...chatHistory,
        { role: "user", content: userPrompt },
      ],
      compressMessages: jest.fn(async ({ systemPrompt, userPrompt }) => [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]),
      getChatCompletion: jest
        .fn()
        .mockResolvedValueOnce({ textResponse: "not json", metrics: {} })
        .mockResolvedValueOnce({ textResponse: capsule(), metrics: {} }),
    };
    mockGetLLMProvider.mockReturnValue(connector);
    mockCompactionWhere.mockResolvedValue([
      chat(1, "2003 年财政部注资 930亿元", "确认"),
      chat(2, "2028 年风险继续讨论", "确认"),
      ...Array.from({ length: 10 }, (_, index) => chat(index + 3)),
    ]);
    const { compactThread } = require("../../../utils/chats/threadCompaction");

    const result = await compactThread({
      workspace,
      user,
      thread,
      force: true,
      mode: "keep_recent",
      keepRecentMessages: 10,
    });

    expect(result.success).toBe(true);
    expect(connector.getChatCompletion).toHaveBeenCalledTimes(2);
    expect(connector.getChatCompletion.mock.calls[0][1]).toEqual(
      expect.objectContaining({ responseFormat: { type: "json_object" } })
    );
    expect(connector.getChatCompletion.mock.calls[1][1]).toEqual(
      expect.objectContaining({ responseFormat: { type: "json_object" } })
    );
    expect(mockCreate.mock.calls[0][0].capsule_json).toContain("账号权限体系");
  });

  it("surfaces recent exact value candidates for historical data and people", async () => {
    const {
      extractExactValueCandidates,
    } = require("../../../utils/chats/threadCompaction");

    const candidates = extractExactValueCandidates([
      chat(
        42,
        "请保留 2003 年财政部通过汇金注资 930亿元，并注意朱镕基时期的背景和 2028 年风险。",
        "确认：财政部、人民银行、中国银行这些机构和 930亿元 是关键数据。"
      ),
    ]);
    const joined = candidates.join("\n");

    expect(joined).toContain("2003");
    expect(joined).toContain("930亿元");
    expect(joined).toContain("财政部");
    expect(joined).toContain("朱镕基时期");
    expect(joined).toContain("2028");
  });

  it("prefers durable topic hints over transient cache-test prompts", async () => {
    const {
      extractDurableTopicHints,
      extractExactValueCandidates,
    } = require("../../../utils/chats/threadCompaction");
    const rows = [
      chat(
        1,
        "我们继续讨论《红色资本》中财政部、人民银行、汇金和国有银行在 2003 年注资 930亿元 的历史含义，以及朱镕基时期的改革背景。",
        "确认这些是当前历史金融分析的关键线索。"
      ),
      chat(2, "第 6 轮缓存一致性测试：只回复第6轮完成", "第6轮完成"),
    ];

    const hints = extractDurableTopicHints(rows).join("\n");
    const candidates = extractExactValueCandidates(rows).join("\n");

    expect(hints).toContain("红色资本");
    expect(hints).toContain("930亿元");
    expect(hints).not.toContain("第6轮完成");
    expect(candidates).toContain("2003");
    expect(candidates).toContain("930亿元");
  });

  it("uses rough-model metadata for status without initializing a provider", async () => {
    mockGetLLMProvider.mockImplementation(({ provider, model }) => {
      if (model === "deepseek-v4-pro") {
        throw new Error("pro model should not be initialized for compaction");
      }
      return {
        model,
        promptWindowLimit: () => 4000,
        constructPrompt: ({
          systemPrompt = "",
          userPrompt = "",
          contextTexts = [],
          chatHistory = [],
        }) => [
          { role: "system", content: systemPrompt + contextTexts.join("\n") },
          ...chatHistory,
          { role: "user", content: userPrompt },
        ],
        compressMessages: jest.fn(),
        getChatCompletion: jest.fn(),
        provider,
      };
    });
    mockCompactionWhere.mockResolvedValue([
      chat(1, "2003 年财政部注资 930亿元", "确认"),
      ...Array.from({ length: 10 }, (_, index) => chat(index + 2)),
    ]);
    const {
      getThreadCompactionStatus,
    } = require("../../../utils/chats/threadCompaction");

    const status = await getThreadCompactionStatus({
      workspace: {
        ...workspace,
        chatProvider: "deepseek",
        chatModel: "deepseek-v4-pro",
      },
      user,
      thread,
    });

    expect(status.compactionProvider).toBe("deepseek");
    expect(status.compactionModel).toBe("deepseek-v4-flash");
    expect(mockGetLLMProvider).not.toHaveBeenCalled();
  });

  it("uses the rough compaction model for manual compaction even when workspace chat model is pro", async () => {
    process.env.THREAD_COMPACTION_CONTEXT_WINDOW_TOKENS = "4000";
    const completions = [];
    mockGetLLMProvider.mockImplementation(({ provider, model }) => {
      if (model === "deepseek-v4-pro") {
        throw new Error("pro model should not be initialized for compaction");
      }
      return {
        model,
        promptWindowLimit: () => 4000,
        constructPrompt: ({
          systemPrompt = "",
          userPrompt = "",
          contextTexts = [],
          chatHistory = [],
        }) => [
          { role: "system", content: systemPrompt + contextTexts.join("\n") },
          ...chatHistory,
          { role: "user", content: userPrompt },
        ],
        compressMessages: jest.fn(async ({ systemPrompt, userPrompt }) => {
          completions.push(userPrompt);
          return [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ];
        }),
        getChatCompletion: jest.fn(async () => ({
          textResponse: capsule({
            topic: "红色资本",
            currentGoal: "核对历史数据",
            confirmedFacts: [
              "2003 年财政部通过汇金注资 930亿元",
              "2028 年风险需要继续讨论",
            ],
          }),
          metrics: {},
        })),
        provider,
      };
    });
    mockCompactionWhere.mockResolvedValue([
      chat(1, "2003 年财政部通过汇金注资 930亿元", "确认"),
      chat(2, "朱镕基时期背景和 2028 年风险也要保留", "确认"),
      ...Array.from({ length: 10 }, (_, index) => chat(index + 3)),
    ]);
    const { compactThread } = require("../../../utils/chats/threadCompaction");

    const result = await compactThread({
      workspace: {
        ...workspace,
        chatProvider: "deepseek",
        chatModel: "deepseek-v4-pro",
      },
      user,
      thread,
      force: true,
      mode: "target",
    });
    const created = mockCreate.mock.calls[0][0];

    expect(result.success).toBe(true);
    expect(result.provider).toBe("deepseek");
    expect(result.model).toBe("deepseek-v4-flash");
    expect(JSON.parse(created.metadata_json).model).toBe("deepseek-v4-flash");
    expect(completions.join("\n")).toContain("Recent exact value candidates");
    expect(completions.join("\n")).toContain("930亿元");
    expect(mockGetLLMProvider).not.toHaveBeenCalledWith({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
  });

  it("does not auto compact when auto is disabled", async () => {
    process.env.THREAD_COMPACTION_AUTO_ENABLED = "false";
    const {
      maybeAutoCompact,
    } = require("../../../utils/chats/threadCompaction");

    const result = await maybeAutoCompact({
      workspace,
      user,
      thread,
      llm: mockGetLLMProvider(),
      chatHistory: [],
    });

    expect(result.skipped).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("skips auto compaction before the turn has finished", async () => {
    process.env.THREAD_COMPACTION_AUTO_ENABLED = "true";
    const {
      maybeAutoCompact,
    } = require("../../../utils/chats/threadCompaction");

    const result = await maybeAutoCompact({
      workspace,
      user,
      thread,
      llm: mockGetLLMProvider(),
      chatHistory: [],
    });

    expect(result.reason).toBe("not_turn_end");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does not treat a full cache-stable history window as auto-compaction pressure", async () => {
    process.env.THREAD_COMPACTION_AUTO_ENABLED = "true";
    const {
      maybeAutoCompact,
    } = require("../../../utils/chats/threadCompaction");

    const result = await maybeAutoCompact({
      workspace,
      user,
      thread,
      llm: {
        ...mockGetLLMProvider(),
        promptWindowLimit: () => 1_000_000,
      },
      chatHistory: Array.from({ length: 80 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: "small",
      })),
      historyPressureLimit: 40,
      phase: "turn_end",
    });

    expect(result.reason).toBe("below_threshold");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("skips duplicate auto compaction for the same scope", async () => {
    process.env.THREAD_COMPACTION_AUTO_ENABLED = "true";
    const {
      buildCompactionScope,
      inFlightCompactions,
      maybeAutoCompact,
    } = require("../../../utils/chats/threadCompaction");
    const key = "1:7:9:null";
    expect(buildCompactionScope({ workspace, user, thread })).toEqual({
      workspace_id: 1,
      user_id: 7,
      thread_id: 9,
      api_session_id: null,
    });
    inFlightCompactions.add(key);

    const result = await maybeAutoCompact({
      workspace,
      user,
      thread,
      llm: mockGetLLMProvider(),
      chatHistory: [],
      phase: "turn_end",
    });

    expect(result.reason).toBe("already_in_progress");
    expect(mockCreate).not.toHaveBeenCalled();
    inFlightCompactions.delete(key);
  });

  it("skips auto compaction when latest scope compaction is recent", async () => {
    process.env.THREAD_COMPACTION_AUTO_ENABLED = "true";
    const {
      maybeAutoCompact,
    } = require("../../../utils/chats/threadCompaction");

    const result = await maybeAutoCompact({
      workspace,
      user,
      thread,
      llm: mockGetLLMProvider(),
      chatHistory: [],
      compaction: { created_at: new Date().toISOString() },
      phase: "turn_end",
    });

    expect(result.reason).toBe("recent_compaction");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("keeps null scope exact and does not treat null as wildcard", async () => {
    const {
      recentChatHistoryWithCompaction,
    } = require("../../../utils/chats/threadCompaction");

    await recentChatHistoryWithCompaction({
      workspace,
      user: null,
      thread: null,
      apiSessionId: null,
    });

    expect(mockLatest).toHaveBeenCalledWith({
      workspace_id: 1,
      user_id: null,
      thread_id: null,
      api_session_id: null,
    });
  });

  it("records token_before and token_after for compacted raw chats only", async () => {
    const rows = [
      chat(1, "small prompt", "small answer"),
      chat(2, "second prompt", "second answer"),
      ...Array.from({ length: 10 }, (_, index) =>
        chat(index + 3, "retained ".repeat(100), "retained answer")
      ),
    ];
    mockCompactionWhere.mockResolvedValue(rows);
    const { compactThread } = require("../../../utils/chats/threadCompaction");
    const { TokenManager } = require("../../../utils/helpers/tiktoken");
    const {
      convertToPromptHistory,
    } = require("../../../utils/helpers/chat/responses");

    const result = await compactThread({
      workspace,
      user,
      thread,
      force: true,
      mode: "keep_recent",
      keepRecentMessages: 10,
    });
    const created = mockCreate.mock.calls[0][0];
    const expectedBefore = new TokenManager("gpt-4o").statsFrom(
      convertToPromptHistory(rows.slice(0, 2))
    );
    const expectedAfter = new TokenManager("gpt-4o").countFromString(
      created.capsule_json
    );

    expect(result.success).toBe(true);
    expect(created.covered_chat_ids).toBe("[1,2]");
    expect(created.covered_to_chat_id).toBe(2);
    expect(created.summary_format).toBe("conversation-state-capsule-json-v1");
    expect(JSON.parse(created.capsule_json).confirmedFacts).toEqual(
      expect.arrayContaining(["系统采用 Shared Auth DB", "TTL 为 3 次压缩"])
    );
    expect(created.token_before).toBe(expectedBefore);
    expect(created.token_after).toBe(expectedAfter);
  });

  it("reports thread-memory status without RAG or attachment token fields", async () => {
    const rows = [
      chat(11, "recent prompt", "recent answer"),
      chat(12, "older compactable", "older answer"),
      ...Array.from({ length: 10 }, (_, index) =>
        chat(index + 13, "retained", "retained answer")
      ),
    ];
    const latestCompaction = {
      id: 88,
      summary: "# Thread Compact Summary\n## 当前任务\n状态摘要",
      capsule_json: capsule({
        topic: "账号权限体系",
        currentGoal: "状态摘要",
        coveredToChatId: "10",
      }),
      summary_format: "thread-compact-markdown-v1",
      covered_from_chat_id: 1,
      covered_to_chat_id: 10,
      covered_message_count: 5,
      token_before: 100,
      token_after: 20,
      created_at: "2026-05-28 00:00:00",
      updated_at: "2026-05-28 00:00:00",
    };
    mockLatest.mockResolvedValue(latestCompaction);
    mockCompactionWhere.mockResolvedValue(rows);
    const {
      compactionContextBlock,
      getThreadCompactionStatus,
    } = require("../../../utils/chats/threadCompaction");
    const { TokenManager } = require("../../../utils/helpers/tiktoken");
    const {
      convertToPromptHistory,
    } = require("../../../utils/helpers/chat/responses");

    const status = await getThreadCompactionStatus({
      workspace,
      user,
      thread,
    });
    const tokenManager = new TokenManager("gpt-4o");
    const expectedSummary = tokenManager.countFromString(
      compactionContextBlock(latestCompaction)
    );
    const expectedHistory = tokenManager.statsFrom(
      convertToPromptHistory(rows)
    );

    expect(mockCompactionWhere).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 1, user_id: 7, thread_id: 9 }),
      { afterChatId: 10, limit: null, orderBy: "asc" }
    );
    expect(status.summaryTokens).toBe(expectedSummary);
    expect(status.recentHistoryTokens).toBe(expectedHistory);
    expect(status.usedTokens).toBe(expectedSummary + expectedHistory);
    expect(status.limitTokens).toBe(400_000);
    expect(status.compactableMessageCount).toBe(2);
    expect(status.targetRatio).toBe(0.2);
    expect(status.targetTokens).toBe(80_000);
    expect(status.chatInjectionLimit).toBe(400_000);
    expect(status.latestCompaction.summary).toBeUndefined();
    expect(status.excludes).toEqual(
      expect.arrayContaining(["RAG context", "current attachments"])
    );
  });

  it("coalesces concurrent status work, expires after three seconds, and invalidates on demand", async () => {
    mockCompactionWhere.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => chat(index + 1))
    );
    const baseNow = Date.now();
    const now = jest.spyOn(Date, "now").mockReturnValue(baseNow);
    const {
      getThreadCompactionStatus,
      invalidateThreadCompactionStatus,
    } = require("../../../utils/chats/threadCompaction");
    const options = {
      workspace,
      user,
      thread: { ...thread, historyRevision: 4 },
      historyRevision: 4,
    };

    const [first, second] = await Promise.all([
      getThreadCompactionStatus(options),
      getThreadCompactionStatus(options),
    ]);
    expect(first).toEqual(second);
    expect(mockLatest).toHaveBeenCalledTimes(1);
    expect(mockCompactionWhere).toHaveBeenCalledTimes(1);

    await getThreadCompactionStatus(options);
    expect(mockCompactionWhere).toHaveBeenCalledTimes(1);

    now.mockReturnValue(baseNow + 3_001);
    await getThreadCompactionStatus(options);
    expect(mockCompactionWhere).toHaveBeenCalledTimes(2);

    invalidateThreadCompactionStatus(options);
    await getThreadCompactionStatus(options);
    expect(mockCompactionWhere).toHaveBeenCalledTimes(3);
    now.mockRestore();
  });

  it("uses the compaction window as the thread memory budget", async () => {
    process.env.THREAD_COMPACTION_CONTEXT_WINDOW_TOKENS = "1000000";
    process.env.THREAD_COMPACTION_TARGET_BASE = "absolute";
    process.env.THREAD_COMPACTION_TARGET_ABSOLUTE_TOKENS = "150000";
    process.env.THREAD_COMPACTION_MANUAL_TARGET_RATIO = "0.15";
    process.env.THREAD_COMPACTION_TARGET_MIN_SUMMARY_TOKENS = "12000";
    process.env.THREAD_COMPACTION_TARGET_MAX_SUMMARY_TOKENS = "60000";
    process.env.THREAD_COMPACTION_TARGET_SUMMARY_BUDGET_RATIO = "0.5";
    const {
      resolveTargetBudgets,
    } = require("../../../utils/chats/threadCompaction");
    const llm = mockGetLLMProvider();

    const budgets = resolveTargetBudgets({
      workspace,
      chatLLM: llm,
      compactionLLM: llm,
      targetRatio: 0.15,
      mode: "manual",
    });

    expect(budgets.compactionInputLimit).toBe(1000000);
    expect(budgets.targetBase).toBe("compaction_window");
    expect(budgets.chatInjectionLimit).toBe(1000000);
    expect(budgets.targetTokens).toBe(150000);
    expect(budgets.estimatedSummaryBudget).toBe(60000);
    expect(budgets.recentRawBudget).toBe(90000);
  });

  it("uses compaction window by default across workspace chat models", async () => {
    const {
      resolveTargetBudgets,
    } = require("../../../utils/chats/threadCompaction");
    const llm = mockGetLLMProvider();

    const flashBudgets = resolveTargetBudgets({
      workspace: {
        ...workspace,
        chatProvider: "deepseek",
        chatModel: "deepseek-v4-flash",
      },
      chatLLM: llm,
      compactionLLM: llm,
      compactionInfo: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        fallbackUsed: false,
      },
      mode: "manual",
    });
    const proBudgets = resolveTargetBudgets({
      workspace: {
        ...workspace,
        chatProvider: "deepseek",
        chatModel: "deepseek-v4-pro",
      },
      chatLLM: llm,
      compactionLLM: llm,
      compactionInfo: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        fallbackUsed: false,
      },
      mode: "manual",
    });

    expect(flashBudgets.targetBase).toBe("compaction_window");
    expect(flashBudgets.chatInjectionLimit).toBe(400_000);
    expect(flashBudgets.targetRatio).toBe(0.2);
    expect(flashBudgets.targetTokens).toBe(80_000);
    expect(proBudgets.targetBase).toBe("compaction_window");
    expect(proBudgets.chatInjectionLimit).toBe(flashBudgets.chatInjectionLimit);
    expect(proBudgets.targetTokens).toBe(flashBudgets.targetTokens);
  });

  it("ignores explicit chat-window target base overrides for thread memory", async () => {
    process.env.THREAD_COMPACTION_TARGET_BASE = "chat_window";
    const {
      resolveTargetBudgets,
    } = require("../../../utils/chats/threadCompaction");
    const llm = mockGetLLMProvider();

    const budgets = resolveTargetBudgets({
      workspace: {
        ...workspace,
        chatProvider: "deepseek",
        chatModel: "deepseek-v4-pro",
      },
      chatLLM: llm,
      compactionLLM: llm,
      mode: "manual",
    });

    expect(budgets.targetBase).toBe("compaction_window");
    expect(budgets.chatInjectionLimit).toBe(400_000);
    expect(budgets.targetRatio).toBe(0.2);
    expect(budgets.targetTokens).toBe(80_000);
  });

  it("keeps explicit 0.15 target ratio available for more aggressive manual compaction", async () => {
    const {
      resolveTargetBudgets,
    } = require("../../../utils/chats/threadCompaction");
    const llm = mockGetLLMProvider();

    const budgets = resolveTargetBudgets({
      workspace,
      chatLLM: llm,
      compactionLLM: llm,
      targetRatio: 0.15,
      mode: "manual",
    });

    expect(budgets.targetRatio).toBe(0.15);
    expect(budgets.targetTokens).toBe(60_000);
  });

  it("keeps auto target ratio at 0.2 by default", async () => {
    const {
      resolveTargetBudgets,
    } = require("../../../utils/chats/threadCompaction");
    const llm = mockGetLLMProvider();

    const budgets = resolveTargetBudgets({
      workspace,
      chatLLM: llm,
      compactionLLM: llm,
      mode: "auto",
    });

    expect(budgets.targetRatio).toBe(0.2);
    expect(budgets.targetTokens).toBe(80_000);
  });

  it("target mode can compact history even when keep-10 would retain it", async () => {
    process.env.THREAD_COMPACTION_CONTEXT_WINDOW_TOKENS = "4000";
    const rows = Array.from({ length: 4 }, (_, index) =>
      chat(index + 1, `prompt ${index + 1}`, "long answer ".repeat(500))
    );
    mockCompactionWhere.mockResolvedValue(rows);
    const { compactThread } = require("../../../utils/chats/threadCompaction");

    const result = await compactThread({
      workspace,
      user,
      thread,
      force: true,
      mode: "target",
      targetRatio: 0.15,
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe("target");
    expect(result.targetCompactableMessageCount).toBeGreaterThan(0);
    expect(mockCreate.mock.calls[0][0].metadata_json).toContain(
      '"mode":"target"'
    );
  });

  it("stores target metadata for status and anti-thrashing", async () => {
    mockLatest.mockResolvedValue({
      id: 88,
      summary: "# Thread Compact Summary\n## 当前任务目标\n状态摘要",
      summary_format: "thread-compact-markdown-v1",
      covered_from_chat_id: 1,
      covered_to_chat_id: 10,
      covered_message_count: 5,
      token_before: 100,
      token_after: 20,
      metadata_json: JSON.stringify({
        mode: "target",
        targetReached: false,
        targetRatio: 0.15,
        targetTokens: 600,
        usedTokensAfterCompact: 900,
        ratioAfterCompact: 0.225,
        cannotReachTargetReason: "minimum_summary_budget_exceeds_target",
      }),
      created_at: "2026-05-28 00:00:00",
      updated_at: "2026-05-28 00:00:00",
    });
    mockCompactionWhere.mockResolvedValue([chat(11)]);
    const {
      getThreadCompactionStatus,
    } = require("../../../utils/chats/threadCompaction");

    const status = await getThreadCompactionStatus({
      workspace,
      user,
      thread,
    });

    expect(status.latestTargetResult).toEqual(
      expect.objectContaining({
        targetReached: false,
        cannotReachTargetReason: "minimum_summary_budget_exceeds_target",
      })
    );
    expect(status.latestCompaction.metadata.mode).toBe("target");
  });

  it("keeps Agent tool calling while injecting compact memory into system context", async () => {
    const AIbitat = require("../../../utils/agents/aibitat");
    const complete = jest.fn(async () => ({ textResponse: "done" }));
    const provider = {
      supportsAgentStreaming: false,
      attachHandlerProps: jest.fn(),
      complete,
      getUsage: jest.fn(() => ({})),
    };
    const aibitat = new AIbitat({
      provider,
      handlerProps: {
        compactedThreadMemory:
          "<athena_conversation_capsule>\n{}\n</athena_conversation_capsule>",
        log: jest.fn(),
      },
    });
    aibitat.agent("USER", { role: "user" });
    aibitat.agent("@agent", { role: "agent role", functions: ["demo-tool"] });
    aibitat.function({ name: "demo-tool", handler: jest.fn() });
    aibitat.newMessage({ from: "USER", to: "@agent", content: "hello" });

    await aibitat.reply({ from: "@agent", to: "USER" });

    const [messages, functions] = complete.mock.calls[0];
    expect(messages[0]).toEqual(
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("<athena_conversation_capsule>"),
      })
    );
    expect(functions.map((fn) => fn.name)).toEqual(["demo-tool"]);
  });
});
