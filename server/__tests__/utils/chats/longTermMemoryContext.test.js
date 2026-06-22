const mockUserGet = jest.fn();
const mockBlocks = jest.fn();
const mockMemoryOwnerIdFromSessionUser = jest.fn();
const mockIsMemorySchemaMissingError = jest.fn();

jest.mock("../../../models/user", () => ({
  User: {
    get: mockUserGet,
  },
}));

jest.mock("../../../models/userMemory", () => ({
  MEMORY_CATEGORIES: [
    "preferences",
    "projects",
    "facts",
    "decisions",
    "open_topics",
    "interests",
  ],
  MEMORY_CATEGORY_LABELS: {
    preferences: "用户偏好",
    projects: "长期项目",
    facts: "长期事实",
    decisions: "重要决策",
    open_topics: "待解决问题",
    interests: "兴趣与研究方向",
  },
  MEMORY_OWNER_REQUIRED_ERROR: "当前账号未完成统一身份绑定，无法使用长期记忆。",
  isMemorySchemaMissingError: mockIsMemorySchemaMissingError,
  UserMemory: {
    memoryOwnerIdFromSessionUser: mockMemoryOwnerIdFromSessionUser,
    blocks: mockBlocks,
  },
}));

const {
  appendUserLongTermMemoryToSystemPrompt,
  appendUserLongTermMemoryToSystemPromptWithState,
  formatLongTermMemoryPromptBlock,
  stripUserLongTermMemoryPromptBlock,
  userLongTermMemoryPromptBlock,
} = require("../../../utils/chats/longTermMemoryContext");

function memoryBlock(category, items = []) {
  return {
    category,
    title: category,
    items,
  };
}

describe("longTermMemoryContext", () => {
  let warnSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockIsMemorySchemaMissingError.mockReturnValue(false);
    mockMemoryOwnerIdFromSessionUser.mockReturnValue(7001);
    mockBlocks.mockResolvedValue([]);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("does not inject when there are no active non-sensitive memories", async () => {
    await expect(
      userLongTermMemoryPromptBlock({ authUserId: 7001 })
    ).resolves.toBe("");
    await expect(
      appendUserLongTermMemoryToSystemPrompt("System", { authUserId: 7001 })
    ).resolves.toBe("System");
    await expect(
      appendUserLongTermMemoryToSystemPromptWithState("System", {
        authUserId: 7001,
      })
    ).resolves.toEqual({ systemPrompt: "System", injected: false });
  });

  it("builds a stable category-ordered non-sensitive memory context", () => {
    const block = formatLongTermMemoryPromptBlock([
      memoryBlock("facts", [
        {
          title: "Athena 是长期项目",
          detail: "Athena 是用户长期维护的知识操作系统。",
          source: "explicit_user_request",
          confidence: "1.0",
          updatedAt: "2026-06-20T10:55:58.876Z",
          isSensitive: false,
        },
      ]),
      memoryBlock("preferences", [
        {
          title: "中文回答偏好",
          detail: "以后回答优先使用中文。",
          source: "explicit_user_request",
          confidence: "1.0",
          updatedAt: "2026-06-20T10:55:58.876Z",
          isSensitive: false,
        },
        {
          title: "敏感偏好",
          detail: "不应该进入普通长期记忆上下文。",
          source: "test",
          confidence: "高",
          updatedAt: "2026-06-20T10:55:58.876Z",
          isSensitive: true,
        },
      ]),
    ]);

    expect(block).toContain("<user_long_term_memory_context>");
    expect(block.indexOf("[用户偏好]")).toBeLessThan(block.indexOf("[长期事实]"));
    expect(block).toContain("- 中文回答偏好");
    expect(block).toContain("内容: 以后回答优先使用中文。");
    expect(block).toContain("来源: explicit_user_request");
    expect(block).toContain("更新于:");
    expect(block).toContain("- Athena 是长期项目");
    expect(block).not.toContain("敏感偏好");
    expect(block).toContain("</user_long_term_memory_context>");
  });

  it("limits each category to five memories", () => {
    const block = formatLongTermMemoryPromptBlock([
      memoryBlock(
        "preferences",
        Array.from({ length: 7 }, (_, index) => ({
          title: `偏好 ${index + 1}`,
          detail: `详情 ${index + 1}`,
          isSensitive: false,
        }))
      ),
    ]);

    expect(block).toContain("偏好 5");
    expect(block).not.toContain("偏好 6");
  });

  it("keeps the context tag closed when truncating long content", () => {
    const block = formatLongTermMemoryPromptBlock([
      memoryBlock("preferences", [
        {
          title: "很长的偏好",
          detail: "长内容".repeat(3_000),
          isSensitive: false,
        },
      ]),
    ]);

    expect(block.length).toBeLessThanOrEqual(4_001);
    expect(block.trim().endsWith("</user_long_term_memory_context>")).toBe(
      true
    );
  });

  it("can resolve the memory owner by authUserId or session user id", async () => {
    mockBlocks.mockResolvedValue([
      memoryBlock("preferences", [
        {
          title: "中文回答偏好",
          detail: "以后回答优先使用中文。",
          isSensitive: false,
        },
      ]),
    ]);

    await expect(
      userLongTermMemoryPromptBlock({ authUserId: 7001 })
    ).resolves.toContain("中文回答偏好");
    expect(mockUserGet).not.toHaveBeenCalled();

    mockUserGet.mockResolvedValue({ id: 7, authUserId: 7001 });
    await expect(userLongTermMemoryPromptBlock({ id: 7 })).resolves.toContain(
      "中文回答偏好"
    );
    expect(mockUserGet).toHaveBeenCalledWith({ id: 7 });
  });

  it("appends long-term memory without duplicating the block", async () => {
    mockBlocks.mockResolvedValue([
      memoryBlock("preferences", [
        {
          title: "中文回答偏好",
          detail: "以后回答优先使用中文。",
          isSensitive: false,
        },
      ]),
    ]);

    const first = await appendUserLongTermMemoryToSystemPrompt("System", {
      authUserId: 7001,
    });
    const second = await appendUserLongTermMemoryToSystemPrompt(first, {
      authUserId: 7001,
    });

    expect(
      second.startsWith("System\n\n<user_long_term_memory_context>")
    ).toBe(true);
    expect(second.match(/<user_long_term_memory_context>/g)).toHaveLength(1);
    expect(stripUserLongTermMemoryPromptBlock(second)).toBe("System");
  });

  it("reports when long-term memory was injected", async () => {
    mockBlocks.mockResolvedValue([
      memoryBlock("preferences", [
        {
          title: "中文回答偏好",
          detail: "以后回答优先使用中文。",
          isSensitive: false,
        },
      ]),
    ]);

    const result = await appendUserLongTermMemoryToSystemPromptWithState(
      "System",
      {
        authUserId: 7001,
      }
    );

    expect(result.injected).toBe(true);
    expect(result.systemPrompt).toContain(
      "<user_long_term_memory_context>"
    );
  });

  it("skips injection for missing auth binding or missing schema", async () => {
    mockMemoryOwnerIdFromSessionUser.mockImplementationOnce(() => {
      throw new Error("当前账号未完成统一身份绑定，无法使用长期记忆。");
    });
    await expect(
      appendUserLongTermMemoryToSystemPrompt("System", { id: 7 })
    ).resolves.toBe("System");

    mockMemoryOwnerIdFromSessionUser.mockReturnValue(7001);
    mockBlocks.mockRejectedValueOnce(
      Object.assign(new Error("table user_memory_blocks missing"), {
        code: "P2021",
      })
    );
    mockIsMemorySchemaMissingError.mockReturnValueOnce(true);
    await expect(
      appendUserLongTermMemoryToSystemPrompt("System", { authUserId: 7001 })
    ).resolves.toBe("System");
  });
});
