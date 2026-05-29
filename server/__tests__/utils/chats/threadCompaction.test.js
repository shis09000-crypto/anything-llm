const mockWorkspaceChatsWhere = jest.fn();
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
  },
}));

jest.mock("../../../models/workspaceChatCompaction", () => ({
  WorkspaceChatCompaction: {
    SUMMARY_FORMAT: "thread-compact-markdown-v1",
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
    mockWorkspaceChatsWhere.mockResolvedValue([chat(1)]);
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
        textResponse: "# Thread Compact Summary\n## 当前任务\n保留上下文",
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

  it("injects only compact summary and chats after covered_to_chat_id", async () => {
    mockLatest.mockResolvedValue({
      id: 88,
      summary: "summary",
      covered_to_chat_id: 2,
    });
    mockCompactionWhere.mockResolvedValue([chat(3)]);
    const {
      injectCompactionIntoSystemPrompt,
      recentChatHistoryWithCompaction,
    } = require("../../../utils/chats/threadCompaction");

    const result = await recentChatHistoryWithCompaction({
      user,
      workspace,
      thread,
      messageLimit: 5,
    });
    const system = injectCompactionIntoSystemPrompt("base", result.compaction);

    expect(mockCompactionWhere).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 1, user_id: 7, thread_id: 9 }),
      { afterChatId: 2, limit: 5, orderBy: "desc" }
    );
    expect(result.rawHistory.map((row) => row.id)).toEqual([3]);
    expect(result.chatHistory.map((item) => item.content)).toEqual([
      "prompt 3",
      "answer 3",
    ]);
    expect(system).toContain("[BEGIN COMPACTED THREAD MEMORY]");
    expect(system).toContain("summary");
  });

  it("strips provider thinking text before storing or injecting summaries", async () => {
    const {
      injectCompactionIntoSystemPrompt,
      normalizeCompactionSummary,
    } = require("../../../utils/chats/threadCompaction");
    const noisy =
      "<think>model reasoning that should not be persisted" +
      "# Thread Compact Summary\n## 当前任务\n干净摘要";

    const normalized = normalizeCompactionSummary(noisy);
    const system = injectCompactionIntoSystemPrompt("base", {
      summary: noisy,
    });

    expect(normalized).toBe("# Thread Compact Summary\n## 当前任务\n干净摘要");
    expect(system).toContain("# Thread Compact Summary");
    expect(system).not.toContain("<think>");
    expect(system).not.toContain("model reasoning");
  });

  it("does not auto compact when auto is disabled", async () => {
    process.env.THREAD_COMPACTION_AUTO_ENABLED = "false";
    const { maybeAutoCompact } = require("../../../utils/chats/threadCompaction");

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
    const { maybeAutoCompact } = require("../../../utils/chats/threadCompaction");

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
    const { maybeAutoCompact } = require("../../../utils/chats/threadCompaction");

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
    const {
      compactThread,
    } = require("../../../utils/chats/threadCompaction");
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
      created.summary
    );

    expect(result.success).toBe(true);
    expect(created.covered_chat_ids).toBe("[1,2]");
    expect(created.covered_to_chat_id).toBe(2);
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
    mockLatest.mockResolvedValue({
      id: 88,
      summary: "# Thread Compact Summary\n## 当前任务\n状态摘要",
      summary_format: "thread-compact-markdown-v1",
      covered_from_chat_id: 1,
      covered_to_chat_id: 10,
      covered_message_count: 5,
      token_before: 100,
      token_after: 20,
      created_at: "2026-05-28 00:00:00",
      updated_at: "2026-05-28 00:00:00",
    });
    mockCompactionWhere.mockResolvedValue(rows);
    const {
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
      "# Thread Compact Summary\n## 当前任务\n状态摘要"
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
    expect(status.limitTokens).toBe(4000);
    expect(status.compactableMessageCount).toBe(2);
    expect(status.targetRatio).toBe(0.15);
    expect(status.targetTokens).toBe(600);
    expect(status.chatInjectionLimit).toBe(4000);
    expect(status.latestCompaction.summary).toBeUndefined();
    expect(status.excludes).toEqual(
      expect.arrayContaining(["RAG context", "current attachments"])
    );
  });

  it("calculates compaction input and chat injection budgets separately", async () => {
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
    expect(budgets.chatInjectionLimit).toBe(150000);
    expect(budgets.targetTokens).toBe(22500);
    expect(budgets.estimatedSummaryBudget).toBe(12000);
    expect(budgets.recentRawBudget).toBe(10500);
  });

  it("uses compaction window by default when workspace chat model matches Flash compaction model", async () => {
    const {
      resolveTargetBudgets,
    } = require("../../../utils/chats/threadCompaction");
    const llm = mockGetLLMProvider();

    const budgets = resolveTargetBudgets({
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

    expect(budgets.targetBase).toBe("compaction_window");
    expect(budgets.chatInjectionLimit).toBe(1_000_000);
    expect(budgets.targetTokens).toBe(150_000);
  });

  it("target mode can compact history even when keep-10 would retain it", async () => {
    const rows = Array.from({ length: 4 }, (_, index) =>
      chat(index + 1, `prompt ${index + 1}`, "long answer ".repeat(500))
    );
    mockCompactionWhere.mockResolvedValue(rows);
    const {
      compactThread,
    } = require("../../../utils/chats/threadCompaction");

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
          "<compacted_thread_memory>\nsummary\n</compacted_thread_memory>",
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
        content: expect.stringContaining("<compacted_thread_memory>"),
      })
    );
    expect(functions.map((fn) => fn.name)).toEqual(["demo-tool"]);
  });
});
