const mockCount = jest.fn();
const mockFindMany = jest.fn();
const mockQueryRawUnsafe = jest.fn();
const mockGetLLMProvider = jest.fn();
const mockThreadGet = jest.fn();
const mockMarkPending = jest.fn();
const mockMarkFailed = jest.fn();
const mockUpdateAutomaticTitle = jest.fn();
const mockRequestInternalService = jest.fn();

jest.mock("../../../utils/microModules", () => ({
  requestInternalService: (...args) => mockRequestInternalService(...args),
}));

jest.mock("../../../utils/prisma", () => ({
  _runtimeDataModel: {
    models: {
      workspace_threads: {
        fields: [
          { name: "title" },
          { name: "titleSource" },
          { name: "titleGeneratedAt" },
          { name: "titleHash" },
          { name: "titleVersion" },
          { name: "titleMessageScope" },
          { name: "titleGenerationStatus" },
        ],
      },
    },
  },
  $queryRawUnsafe: (...args) => mockQueryRawUnsafe(...args),
  workspace_chats: {
    count: (...args) => mockCount(...args),
    findMany: (...args) => mockFindMany(...args),
  },
}));

jest.mock("../../../utils/helpers", () => ({
  getLLMProvider: (...args) => mockGetLLMProvider(...args),
}));

jest.mock("../../../models/workspaceThread", () => ({
  WorkspaceThread: {
    get: (...args) => mockThreadGet(...args),
    markTitleGenerationPending: (...args) => mockMarkPending(...args),
    markTitleGenerationFailed: (...args) => mockMarkFailed(...args),
    updateAutomaticTitle: (...args) => mockUpdateAutomaticTitle(...args),
  },
}));

describe("threadTitleGeneration", () => {
  let mod;
  let warnSpy;
  let originalTitleRefreshInterval;
  let originalRuntimeRole;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    originalTitleRefreshInterval = process.env.THREAD_TITLE_REFRESH_INTERVAL;
    originalRuntimeRole = process.env.ATHENA_RUNTIME_ROLE;
    process.env.THREAD_TITLE_REFRESH_INTERVAL = "14d";
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mod = require("../../../utils/chats/threadTitleGeneration");
    mod._internals.pendingJobKeys.clear();
    mod._internals.resetTitleMetadataReadiness();
    mockQueryRawUnsafe.mockResolvedValue([
      { name: "title" },
      { name: "titleSource" },
      { name: "titleGeneratedAt" },
      { name: "titleHash" },
      { name: "titleVersion" },
      { name: "titleMessageScope" },
      { name: "titleGenerationStatus" },
    ]);
  });

  afterEach(async () => {
    await mod._internals.titleQueue.onIdle();
    mod._internals.pendingJobKeys.clear();
    if (originalTitleRefreshInterval === undefined)
      delete process.env.THREAD_TITLE_REFRESH_INTERVAL;
    else
      process.env.THREAD_TITLE_REFRESH_INTERVAL = originalTitleRefreshInterval;
    if (originalRuntimeRole === undefined)
      delete process.env.ATHENA_RUNTIME_ROLE;
    else process.env.ATHENA_RUNTIME_ROLE = originalRuntimeRole;
    warnSpy.mockRestore();
  });

  it("treats a rejected remote title lease as an idempotent no-op", async () => {
    process.env.ATHENA_RUNTIME_ROLE = "chat-runtime";
    mockFindMany.mockResolvedValue([{ prompt: "已经生成过标题的对话" }]);
    mockRequestInternalService.mockRejectedValue(
      Object.assign(new Error("thread_title_claim_rejected"), {
        code: "thread_title_claim_rejected",
      })
    );

    await expect(
      mod._internals.runTitleGenerationJob({
        workspaceId: 1,
        threadId: 10,
        userId: 2,
        scope: mod.TITLE_SCOPES.latestFiveUserMessages,
      })
    ).resolves.toBeNull();
    expect(mockGetLLMProvider).not.toHaveBeenCalled();
  });

  function mockRefreshQueries({ scanChats = [], prompts = [] } = {}) {
    let scanServed = false;
    mockFindMany.mockImplementation(async (query = {}) => {
      const threadClause = query.where?.thread_id;
      if (threadClause && typeof threadClause === "object") {
        if (scanServed) return [];
        scanServed = true;
        return scanChats;
      }

      return prompts.map((prompt) => ({ prompt }));
    });
  }

  it("normalizes and hashes only non-empty user message text", () => {
    const hashA = mod.hashUserMessages([
      "  hello   world ",
      "",
      " second\nline",
    ]);
    const hashB = mod.hashUserMessages(["hello world", "second line"]);
    expect(hashA).toEqual(hashB);
    expect(mod.normalizeUserMessages([" a\tb ", "   "])).toEqual(["a b"]);
  });

  it("sanitizes JSON title output and truncates to 12 chars", () => {
    expect(
      mod.parseTitleFromJson('{"title":"“这是一个非常长的标题内容！”"}')
    ).toBe("“这是一个非常长的标题内容！”");
    expect(
      mod.sanitizeTitle("“这是一个非常长的标题内容！”", "fallback").title
    ).toBe("这是一个非常长的标题内容");
  });

  it("skips automatic title work once a thread is manual", async () => {
    mockThreadGet.mockResolvedValue({
      id: 10,
      titleSource: "manual",
      titleMessageScope: null,
    });

    await mod.maybeEnqueueTitleGenerationAfterChat({
      workspaceId: 1,
      threadId: 10,
      userId: 2,
      include: true,
    });

    expect(mockCount).not.toHaveBeenCalled();
    expect(mockMarkPending).not.toHaveBeenCalled();
  });

  it("scopes thread lookups by workspace and user before title work", async () => {
    mockThreadGet.mockResolvedValue(null);

    await mod.maybeEnqueueTitleGenerationAfterChat({
      workspaceId: 1,
      threadId: 10,
      userId: 2,
      include: true,
    });

    expect(mockThreadGet).toHaveBeenCalledWith({
      id: 10,
      workspace_id: 1,
      user_id: 2,
    });
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockMarkPending).not.toHaveBeenCalled();
  });

  it("allows system refresh scope without a user id while still matching workspace", () => {
    expect(
      mod._internals.scopedThreadClause({
        workspaceId: 1,
        threadId: 10,
        userId: null,
      })
    ).toEqual({
      id: 10,
      workspace_id: 1,
    });
  });

  it("skips title work when DB metadata columns are missing", async () => {
    mockQueryRawUnsafe.mockResolvedValue([{ name: "name" }]);
    mod._internals.resetTitleMetadataReadiness();

    const result = await mod.enqueueThreadTitleGeneration({
      workspaceId: 1,
      threadId: 10,
      userId: 2,
      scope: mod.TITLE_SCOPES.firstUserMessage,
    });

    expect(result).toEqual({ queued: false, skipped: "schema_missing" });
    expect(mockThreadGet).not.toHaveBeenCalled();
    expect(mockMarkPending).not.toHaveBeenCalled();
  });

  it("does not repeat first-five generation after that scope has been reached", async () => {
    mockThreadGet.mockResolvedValue({
      id: 10,
      titleSource: "llm",
      titleMessageScope: mod.TITLE_SCOPES.firstFiveUserMessages,
    });
    mockCount.mockResolvedValue(5);

    await mod.maybeEnqueueTitleGenerationAfterChat({
      workspaceId: 1,
      threadId: 10,
      userId: 2,
      include: true,
    });

    expect(mockMarkPending).not.toHaveBeenCalled();
  });

  it("skips latest-five refresh while the thread title is still on cooldown", async () => {
    mockRefreshQueries({
      scanChats: [{ id: 50, workspaceId: 1, thread_id: 10, user_id: 2 }],
      prompts: ["one", "two", "three", "four", "five"],
    });
    mockThreadGet.mockResolvedValue({
      id: 10,
      titleSource: "llm",
      titleHash: "old-hash",
      titleGeneratedAt: new Date(Date.now() - 60 * 1000),
      titleMessageScope: mod.TITLE_SCOPES.firstFiveUserMessages,
    });

    const result = await mod.refreshRecentThreadTitles({ waitForIdle: true });

    expect(result).toEqual({
      scannedChats: 1,
      scannedThreads: 1,
      queued: 0,
    });
    expect(mockMarkPending).not.toHaveBeenCalled();
  });

  it("queues latest-five refresh after the thread title cooldown expires", async () => {
    mockRefreshQueries({
      scanChats: [{ id: 50, workspaceId: 1, thread_id: 10, user_id: 2 }],
      prompts: ["one", "two", "three", "four", "five"],
    });
    mockThreadGet.mockResolvedValue({
      id: 10,
      workspace_id: 1,
      user_id: 2,
      slug: "thread-10",
      name: "Old title",
      title: "Old title",
      titleSource: "llm",
      titleHash: "old-hash",
      titleGeneratedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
      titleMessageScope: mod.TITLE_SCOPES.firstFiveUserMessages,
    });
    mockMarkPending.mockResolvedValue(true);
    mockGetLLMProvider.mockReturnValue({
      getChatCompletion: jest.fn(async () => ({
        textResponse: '{"title":"新的标题"}',
      })),
    });
    mockUpdateAutomaticTitle.mockResolvedValue({
      id: 10,
      workspace_id: 1,
      user_id: 2,
      slug: "thread-10",
      name: "新的标题",
      title: "新的标题",
      titleSource: "llm",
      titleVersion: 2,
    });

    const result = await mod.refreshRecentThreadTitles({ waitForIdle: true });

    expect(result).toEqual({
      scannedChats: 1,
      scannedThreads: 1,
      queued: 1,
    });
    expect(mockMarkPending).toHaveBeenCalledWith(
      10,
      mod.TITLE_SCOPES.latestFiveUserMessages
    );
    expect(mockUpdateAutomaticTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 10,
        title: "新的标题",
        titleSource: "llm",
        titleMessageScope: mod.TITLE_SCOPES.latestFiveUserMessages,
      })
    );
  });

  it("allows latest-five refresh backfill when titleGeneratedAt is missing", async () => {
    mockRefreshQueries({
      scanChats: [{ id: 50, workspaceId: 1, thread_id: 10, user_id: 2 }],
      prompts: ["one", "two", "three", "four", "five"],
    });
    mockThreadGet.mockResolvedValue({
      id: 10,
      workspace_id: 1,
      user_id: 2,
      slug: "thread-10",
      name: "Old title",
      title: "Old title",
      titleSource: "llm",
      titleHash: "old-hash",
      titleGeneratedAt: null,
      titleMessageScope: mod.TITLE_SCOPES.firstFiveUserMessages,
    });
    mockMarkPending.mockResolvedValue(true);
    mockGetLLMProvider.mockReturnValue({
      getChatCompletion: jest.fn(async () => ({
        textResponse: '{"title":"回填标题"}',
      })),
    });
    mockUpdateAutomaticTitle.mockResolvedValue({
      id: 10,
      workspace_id: 1,
      user_id: 2,
      slug: "thread-10",
      name: "回填标题",
      title: "回填标题",
      titleSource: "llm",
      titleVersion: 1,
    });

    const result = await mod.refreshRecentThreadTitles({ waitForIdle: true });

    expect(result.queued).toBe(1);
    expect(mockMarkPending).toHaveBeenCalledWith(
      10,
      mod.TITLE_SCOPES.latestFiveUserMessages
    );
  });

  it("does not apply refresh cooldown to immediate first and first-five triggers", async () => {
    mockThreadGet.mockResolvedValue({
      id: 10,
      titleSource: "llm",
      titleHash: "old-hash",
      titleGeneratedAt: new Date(),
      titleMessageScope: null,
    });
    mockMarkPending.mockResolvedValue(false);

    mockCount.mockResolvedValueOnce(1);
    await mod.maybeEnqueueTitleGenerationAfterChat({
      workspaceId: 1,
      threadId: 10,
      userId: 2,
      include: true,
    });
    expect(mockMarkPending).toHaveBeenCalledWith(
      10,
      mod.TITLE_SCOPES.firstUserMessage
    );

    mockMarkPending.mockClear();
    mockCount.mockResolvedValueOnce(5);
    await mod.maybeEnqueueTitleGenerationAfterChat({
      workspaceId: 1,
      threadId: 10,
      userId: 2,
      include: true,
    });
    expect(mockMarkPending).toHaveBeenCalledWith(
      10,
      mod.TITLE_SCOPES.firstFiveUserMessages
    );
  });

  it("falls back to first-message title when the fixed title model is unavailable", async () => {
    mockThreadGet.mockResolvedValue({
      id: 10,
      titleSource: null,
      titleMessageScope: null,
    });
    mockMarkPending.mockResolvedValue(true);
    mockFindMany.mockResolvedValue([{ prompt: "帮我规划一个学习计划" }]);
    mockGetLLMProvider.mockImplementation(() => {
      throw new Error("No DeepSeek API key was set.");
    });
    mockUpdateAutomaticTitle.mockResolvedValue({
      id: 10,
      workspace_id: 1,
      slug: "thread-10",
      name: "帮我规划一个学习计划",
      title: "帮我规划一个学习计划",
      titleSource: "first_message",
    });

    await mod.enqueueThreadTitleGeneration({
      workspaceId: 1,
      threadId: 10,
      userId: 2,
      scope: mod.TITLE_SCOPES.firstUserMessage,
    });
    await mod._internals.titleQueue.onIdle();

    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockUpdateAutomaticTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 10,
        title: "帮我规划一个学习计划",
        titleSource: "first_message",
        titleMessageScope: mod.TITLE_SCOPES.firstUserMessage,
      })
    );
  });

  it("recovers stale pending DB status when no queue job exists", async () => {
    mockThreadGet.mockResolvedValue({
      id: 10,
      titleSource: null,
      titleGenerationStatus: "pending",
      titleMessageScope: mod.TITLE_SCOPES.firstUserMessage,
    });
    mockMarkPending.mockResolvedValue(true);
    mockFindMany.mockResolvedValue([{ prompt: "解释阿奎纳的哲学思想" }]);
    mockGetLLMProvider.mockReturnValue({
      getChatCompletion: jest.fn(async () => ({
        textResponse: '{"title":"阿奎纳哲学"}',
      })),
    });
    mockUpdateAutomaticTitle.mockResolvedValue({
      id: 10,
      workspace_id: 1,
      slug: "thread-10",
      name: "阿奎纳哲学",
      title: "阿奎纳哲学",
    });

    const result = await mod.enqueueThreadTitleGeneration({
      workspaceId: 1,
      threadId: 10,
      userId: 2,
      scope: mod.TITLE_SCOPES.firstUserMessage,
    });
    await mod._internals.titleQueue.onIdle();

    expect(result.queued).toBe(true);
    expect(mockUpdateAutomaticTitle).toHaveBeenCalled();
  });

  it("generates a first-message title and saves name/title together", async () => {
    const titleUpdates = [];
    const {
      subscribeToThreadTitleUpdates,
    } = require("../../../utils/chats/threadTitleEvents");
    const unsubscribe = subscribeToThreadTitleUpdates((event) =>
      titleUpdates.push(event)
    );

    mockThreadGet.mockResolvedValue({
      id: 10,
      titleSource: null,
      titleMessageScope: null,
    });
    mockMarkPending.mockResolvedValue(true);
    mockFindMany.mockResolvedValue([{ prompt: "帮我制定东京旅行计划" }]);
    mockGetLLMProvider.mockReturnValue({
      getChatCompletion: jest.fn(async () => ({
        textResponse: '{"title":"东京旅行计划"}',
      })),
    });
    mockUpdateAutomaticTitle.mockResolvedValue({
      id: 10,
      workspace_id: 1,
      slug: "thread-10",
      name: "东京旅行计划",
      title: "东京旅行计划",
      titleSource: "llm",
      titleVersion: 1,
    });

    await mod.enqueueThreadTitleGeneration({
      workspaceId: 1,
      threadId: 10,
      userId: 2,
      scope: mod.TITLE_SCOPES.firstUserMessage,
    });
    await mod._internals.titleQueue.onIdle();

    expect(mockUpdateAutomaticTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 10,
        title: "东京旅行计划",
        titleSource: "llm",
        titleMessageScope: mod.TITLE_SCOPES.firstUserMessage,
      })
    );
    expect(titleUpdates).toEqual([
      expect.objectContaining({
        workspaceId: 1,
        threadId: 10,
        slug: "thread-10",
        name: "东京旅行计划",
        title: "东京旅行计划",
        titleSource: "llm",
        titleVersion: 1,
      }),
    ]);
    unsubscribe();
  });
});
