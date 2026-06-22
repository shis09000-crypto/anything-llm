const mockUserGet = jest.fn();
const mockSaveActiveMemory = jest.fn();
const mockMemoryOwnerIdFromSessionUser = jest.fn();

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
  UserMemory: {
    categories: [
      "preferences",
      "projects",
      "facts",
      "decisions",
      "open_topics",
      "interests",
    ],
    maskedText: "••••••••",
    memoryOwnerIdFromSessionUser: mockMemoryOwnerIdFromSessionUser,
    saveActiveMemory: mockSaveActiveMemory,
  },
}));

const { saveMemory } = require("../../../utils/agents/aibitat/plugins/save-memory");

function setupPlugin({ approval } = {}) {
  let registeredFunction = null;
  const aibitat = {
    handlerProps: {
      invocation: { user_id: 7 },
      log: jest.fn(),
    },
    function: jest.fn((config) => {
      registeredFunction = config;
    }),
    requestToolApproval: jest.fn(async () => approval),
    introspect: jest.fn(),
  };

  saveMemory.plugin().setup(aibitat);
  return { aibitat, registeredFunction };
}

describe("agent save_memory plugin", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserGet.mockResolvedValue({ id: 7, authUserId: 7001 });
    mockMemoryOwnerIdFromSessionUser.mockReturnValue(7001);
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

  test("registers the save_memory function", () => {
    const { registeredFunction } = setupPlugin({
      approval: { approved: false },
    });

    expect(registeredFunction.name).toBe("save_memory");
    expect(registeredFunction.parameters.required).toEqual([
      "category",
      "title",
      "detail",
      "isSensitive",
    ]);
  });

  test("always requests agent tool approval before saving", async () => {
    const { aibitat, registeredFunction } = setupPlugin({
      approval: { approved: true },
    });

    await registeredFunction.handler.call(
      { super: aibitat, caller: "@agent" },
      {
        category: "preferences",
        title: "中文回答偏好",
        detail: "以后回答都用中文。",
        source: "model_guess",
        confidence: 0.5,
        isSensitive: false,
      }
    );

    expect(aibitat.requestToolApproval).toHaveBeenCalledWith({
      skillName: "save_memory",
      payload: expect.objectContaining({
        category: "preferences",
        categoryLabel: "用户偏好",
        title: "中文回答偏好",
        detail: "以后回答都用中文。",
        source: "explicit_user_request",
        confidence: 1,
        isSensitive: false,
      }),
      description: "保存长期记忆：中文回答偏好",
      forceApproval: true,
      allowAlwaysAllow: false,
    });
  });

  test("writes active memory only after approval", async () => {
    const { aibitat, registeredFunction } = setupPlugin({
      approval: { approved: true },
    });

    const result = await registeredFunction.handler.call(
      { super: aibitat, caller: "@agent" },
      {
        category: "preferences",
        title: "中文回答偏好",
        detail: "以后回答都用中文。",
        isSensitive: false,
      }
    );

    expect(mockUserGet).toHaveBeenCalledWith({ id: 7 });
    expect(mockMemoryOwnerIdFromSessionUser).toHaveBeenCalledWith({
      id: 7,
      authUserId: 7001,
    });
    expect(mockSaveActiveMemory).toHaveBeenCalledWith(7001, {
      category: "preferences",
      title: "中文回答偏好",
      detail: "以后回答都用中文。",
      source: "explicit_user_request",
      confidence: "1.0",
      isSensitive: false,
    });
    expect(JSON.parse(result)).toMatchObject({
      success: true,
      id: 42,
      category: "preferences",
      title: "中文回答偏好",
      detail: "以后回答都用中文。",
      confidence: 1,
      isSensitive: false,
      created: true,
    });
  });

  test("does not write memory when approval is rejected", async () => {
    const { aibitat, registeredFunction } = setupPlugin({
      approval: { approved: false, message: "Tool call was rejected by the user." },
    });

    const result = await registeredFunction.handler.call(
      { super: aibitat, caller: "@agent" },
      {
        category: "preferences",
        title: "中文回答偏好",
        detail: "以后回答都用中文。",
        isSensitive: false,
      }
    );

    expect(aibitat.requestToolApproval).toHaveBeenCalled();
    expect(mockSaveActiveMemory).not.toHaveBeenCalled();
    expect(result).toBe("Tool call was rejected by the user.");
  });

  test("masks sensitive memory in the tool result", async () => {
    mockSaveActiveMemory.mockResolvedValueOnce({
      memory: {
        id: 43,
        category: "facts",
        source: "explicit_user_request",
      },
      created: true,
      replaced: false,
    });
    const { aibitat, registeredFunction } = setupPlugin({
      approval: { approved: true },
    });

    const result = await registeredFunction.handler.call(
      { super: aibitat, caller: "@agent" },
      {
        category: "facts",
        title: "敏感事实",
        detail: "敏感内容",
        isSensitive: true,
      }
    );

    expect(mockSaveActiveMemory).toHaveBeenCalledWith(
      7001,
      expect.objectContaining({ isSensitive: true })
    );
    expect(JSON.parse(result).detail).toBe("••••••••");
  });
});
