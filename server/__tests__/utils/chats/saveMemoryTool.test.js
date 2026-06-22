const mockSaveActiveMemory = jest.fn();

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
  UserMemory: {
    maskedText: "••••••••",
    saveActiveMemory: mockSaveActiveMemory,
  },
}));

const {
  approvalPayloadForMemory,
  executeSaveMemoryTool,
  hasExplicitMemoryIntent,
  normalizeSaveMemoryArgs,
  saveMemoryToolsForMessage,
} = require("../../../utils/chats/saveMemoryTool");

describe("save_memory explicit long-term memory tool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveActiveMemory.mockResolvedValue({
      memory: {
        id: 42,
        category: "preferences",
        source: "explicit_user_request",
      },
      created: true,
      replaced: false,
    });
  });

  test("only exposes the tool for explicit memory intent", () => {
    expect(hasExplicitMemoryIntent("记住：以后回答都用中文")).toBe(true);
    expect(saveMemoryToolsForMessage("记住：Athena 是我的长期项目")).toHaveLength(
      1
    );
    expect(saveMemoryToolsForMessage("以后回答能不能用中文？")).toHaveLength(0);
  });

  test("normalizes source and confidence for explicit requests", () => {
    expect(
      normalizeSaveMemoryArgs({
        category: "preferences",
        title: "中文回答偏好",
        detail: "以后回答都用中文。",
        source: "model_guess",
        confidence: 0.4,
        isSensitive: false,
      })
    ).toEqual({
      category: "preferences",
      title: "中文回答偏好",
      detail: "以后回答都用中文。",
      source: "explicit_user_request",
      confidence: "1.0",
      isSensitive: false,
    });
  });

  test("approval payload shows the category label and sensitivity", () => {
    expect(
      approvalPayloadForMemory({
        category: "decisions",
        title: "Primary Owner 不可删除",
        detail: "Primary Owner 账号不能被删除。",
        source: "explicit_user_request",
        confidence: "1.0",
        isSensitive: true,
      })
    ).toEqual({
      category: "decisions",
      categoryLabel: "重要决策",
      title: "Primary Owner 不可删除",
      detail: "Primary Owner 账号不能被删除。",
      source: "explicit_user_request",
      confidence: 1,
      isSensitive: true,
    });
  });

  test("writes approved explicit memory directly into active memory", async () => {
    const result = await executeSaveMemoryTool({
      memoryOwnerId: 7001,
      userMessage: "记住：以后回答都用中文",
      args: {
        category: "preferences",
        title: "中文回答偏好",
        detail: "以后回答都用中文。",
        isSensitive: false,
      },
    });

    expect(mockSaveActiveMemory).toHaveBeenCalledWith(7001, {
      category: "preferences",
      title: "中文回答偏好",
      detail: "以后回答都用中文。",
      source: "explicit_user_request",
      confidence: "1.0",
      isSensitive: false,
    });
    expect(result).toMatchObject({
      success: true,
      title: "中文回答偏好",
      detail: "以后回答都用中文。",
      confidence: 1,
      created: true,
    });
  });

  test("rejects model tool calls without explicit user intent", async () => {
    await expect(
      executeSaveMemoryTool({
        memoryOwnerId: 7001,
        userMessage: "以后回答能不能用中文？",
        args: {
          category: "preferences",
          title: "中文回答偏好",
          detail: "以后回答都用中文。",
          isSensitive: false,
        },
      })
    ).rejects.toThrow("explicit user memory request");
    expect(mockSaveActiveMemory).not.toHaveBeenCalled();
  });

  test("rejects execution without a memory owner id", async () => {
    await expect(
      executeSaveMemoryTool({
        memoryOwnerId: null,
        userMessage: "记住：以后回答都用中文",
        args: {
          category: "preferences",
          title: "中文回答偏好",
          detail: "以后回答都用中文。",
          isSensitive: false,
        },
      })
    ).rejects.toThrow("Invalid memory owner id");
    expect(mockSaveActiveMemory).not.toHaveBeenCalled();
  });

  test("masks sensitive tool results", async () => {
    mockSaveActiveMemory.mockResolvedValueOnce({
      memory: {
        id: 43,
        category: "facts",
        source: "explicit_user_request",
      },
      created: true,
      replaced: false,
    });

    const result = await executeSaveMemoryTool({
      memoryOwnerId: 7001,
      userMessage: "记住：这是敏感信息",
      args: {
        category: "facts",
        title: "敏感事实",
        detail: "敏感内容",
        isSensitive: true,
      },
    });

    expect(mockSaveActiveMemory).toHaveBeenCalledWith(
      7001,
      expect.objectContaining({ isSensitive: true })
    );
    expect(result.detail).toBe("••••••••");
  });
});
