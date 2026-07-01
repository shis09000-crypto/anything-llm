const tx = {
  user_memory_blocks: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  user_memory_archives: {
    create: jest.fn(),
    update: jest.fn(),
  },
};

const mockTransaction = jest.fn(async (callback) => callback(tx));

jest.mock("../../utils/prisma", () => ({
  $transaction: (...args) => mockTransaction(...args),
}));

jest.mock("../../utils/security/encryption", () => ({
  encryptSecret: jest.fn((value) => `encrypted:${value}`),
  decryptSecret: jest.fn((value) => value.replace(/^encrypted:/, "")),
}));

const { UserMemory } = require("../../models/userMemory");

describe("UserMemory.saveActiveMemory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tx.user_memory_blocks.findMany.mockResolvedValue([]);
    tx.user_memory_blocks.findFirst.mockResolvedValue(null);
    tx.user_memory_blocks.create.mockImplementation(async ({ data }) => ({
      id: 10,
      ...data,
    }));
    tx.user_memory_blocks.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      userId: 7001,
      category: "preferences",
      isSensitive: false,
      ...data,
    }));
    tx.user_memory_blocks.delete.mockResolvedValue({ id: 5 });
    tx.user_memory_archives.create.mockResolvedValue({ id: 99 });
    tx.user_memory_archives.update.mockResolvedValue({ id: 99 });
  });

  test("uses authUserId as the memory owner id", () => {
    expect(
      UserMemory.memoryOwnerIdFromSessionUser({ id: 7, authUserId: 7001 })
    ).toBe(7001);
  });

  test("rejects users without a unified auth identity", () => {
    expect(() =>
      UserMemory.memoryOwnerIdFromSessionUser({ id: 7, authUserId: null })
    ).toThrow("当前账号未完成统一身份绑定");
  });

  test("creates a new active non-sensitive memory", async () => {
    const result = await UserMemory.saveActiveMemory(7001, {
      category: "preferences",
      title: "中文回答偏好",
      detail: "以后回答都用中文。",
      source: "explicit_user_request",
      confidence: "1.0",
      isSensitive: false,
    });

    expect(result.created).toBe(true);
    expect(result.replaced).toBe(false);
    expect(tx.user_memory_blocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 7001,
        category: "preferences",
        title: "中文回答偏好",
        detail: "以后回答都用中文。",
        source: "explicit_user_request",
        confidence: "1.0",
        isSensitive: false,
        encryptedPayload: null,
      }),
    });
  });

  test("updates duplicate active memory and archives the old value", async () => {
    tx.user_memory_blocks.findMany.mockResolvedValueOnce([
      {
        id: 5,
        userId: 7001,
        category: "preferences",
        title: " 中文回答偏好 ",
        detail: "旧内容",
        source: "explicit_user_request",
        confidence: "1.0",
        updatedAt: new Date("2026-06-19T00:00:00Z"),
        isSensitive: false,
      },
    ]);

    const result = await UserMemory.saveActiveMemory(7001, {
      category: "preferences",
      title: "中文回答偏好",
      detail: "新内容",
      source: "explicit_user_request",
      confidence: "1.0",
      isSensitive: false,
    });

    expect(result.created).toBe(false);
    expect(result.replaced).toBe(true);
    expect(tx.user_memory_archives.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 7001,
        category: "preferences",
        replacedBy: null,
      }),
    });
    expect(tx.user_memory_blocks.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: expect.objectContaining({
        title: "中文回答偏好",
        detail: "新内容",
        source: "explicit_user_request",
        confidence: "1.0",
      }),
    });
    expect(tx.user_memory_archives.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { replacedBy: 5 },
    });
  });

  test("stores sensitive active memory encrypted and masked", async () => {
    await UserMemory.saveActiveMemory(7001, {
      category: "facts",
      title: "敏感事实",
      detail: "敏感内容",
      source: "explicit_user_request",
      confidence: "1.0",
      isSensitive: true,
    });

    expect(tx.user_memory_blocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 7001,
        category: "facts",
        title: "••••••••",
        detail: "••••••••",
        source: "explicit_user_request",
        confidence: "1.0",
        isSensitive: true,
        encryptedPayload:
          'encrypted:{"title":"敏感事实","detail":"敏感内容"}',
      }),
    });
  });

  test("archives replaced sensitive memory without decrypted plaintext", async () => {
    tx.user_memory_blocks.findMany.mockResolvedValueOnce([
      {
        id: 7,
        userId: 7001,
        category: "facts",
        title: "••••••••",
        detail: "••••••••",
        source: "manual",
        confidence: "中",
        updatedAt: new Date("2026-06-20T00:00:00Z"),
        isSensitive: true,
        encryptedPayload:
          'encrypted:{"title":"旧敏感标题","detail":"旧敏感内容"}',
      },
    ]);

    await UserMemory.saveActiveMemory(7001, {
      category: "facts",
      title: "旧敏感标题",
      detail: "新敏感内容",
      source: "manual",
      confidence: "高",
      isSensitive: true,
    });

    const archivePayload =
      tx.user_memory_archives.create.mock.calls[0][0].data.oldValue;
    expect(archivePayload).toContain("••••••••");
    expect(archivePayload).not.toContain("旧敏感标题");
    expect(archivePayload).not.toContain("旧敏感内容");
  });

  test("updates an active non-sensitive memory by owner id", async () => {
    tx.user_memory_blocks.findFirst.mockResolvedValueOnce({
      id: 5,
      userId: 7001,
      category: "preferences",
      title: "旧标题",
      detail: "旧内容",
      source: "manual",
      confidence: "中",
      isSensitive: false,
    });
    tx.user_memory_blocks.update.mockResolvedValueOnce({
      id: 5,
      userId: 7001,
      category: "projects",
      title: "新标题",
      detail: "新内容",
      source: "manual",
      confidence: "高",
      updatedAt: new Date("2026-06-20T00:00:00Z"),
      isSensitive: false,
      encryptedPayload: null,
    });

    const result = await UserMemory.updateActiveMemory(7001, 5, {
      category: "projects",
      title: "新标题",
      detail: "新内容",
      source: "manual",
      confidence: "高",
    });

    expect(result.title).toBe("新标题");
    expect(result.category).toBe("projects");
    expect(tx.user_memory_blocks.findFirst).toHaveBeenCalledWith({
      where: { id: 5, userId: 7001 },
    });
    expect(tx.user_memory_blocks.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: expect.objectContaining({
        category: "projects",
        title: "新标题",
        detail: "新内容",
        encryptedPayload: null,
      }),
    });
  });

  test("updates sensitive memory encrypted while returning masked content", async () => {
    tx.user_memory_blocks.findFirst.mockResolvedValueOnce({
      id: 6,
      userId: 7001,
      category: "facts",
      title: "••••••••",
      detail: "••••••••",
      source: "manual",
      confidence: "中",
      isSensitive: true,
      encryptedPayload: 'encrypted:{"title":"旧","detail":"旧"}',
    });
    tx.user_memory_blocks.update.mockResolvedValueOnce({
      id: 6,
      userId: 7001,
      category: "facts",
      title: "••••••••",
      detail: "••••••••",
      source: "manual",
      confidence: "高",
      updatedAt: new Date("2026-06-20T00:00:00Z"),
      isSensitive: true,
      encryptedPayload: 'encrypted:{"title":"新敏感","detail":"新内容"}',
    });

    const result = await UserMemory.updateActiveMemory(7001, 6, {
      category: "facts",
      title: "新敏感",
      detail: "新内容",
      source: "manual",
      confidence: "高",
    });

    expect(result.title).toBe("••••••••");
    expect(tx.user_memory_blocks.update).toHaveBeenCalledWith({
      where: { id: 6 },
      data: expect.objectContaining({
        title: "••••••••",
        detail: "••••••••",
        encryptedPayload: 'encrypted:{"title":"新敏感","detail":"新内容"}',
      }),
    });
  });

  test("deletes active memory and archives the old value", async () => {
    tx.user_memory_blocks.findFirst.mockResolvedValueOnce({
      id: 5,
      userId: 7001,
      category: "preferences",
      title: "旧标题",
      detail: "旧内容",
      source: "manual",
      confidence: "中",
      updatedAt: new Date("2026-06-20T00:00:00Z"),
      isSensitive: false,
    });

    const result = await UserMemory.deleteActiveMemory(7001, 5);

    expect(result.success).toBe(true);
    expect(tx.user_memory_archives.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 7001,
        category: "preferences",
        replacedBy: null,
      }),
    });
    expect(tx.user_memory_blocks.delete).toHaveBeenCalledWith({
      where: { id: 5 },
    });
  });

  test("archives sensitive deletes without plaintext", async () => {
    tx.user_memory_blocks.findFirst.mockResolvedValueOnce({
      id: 6,
      userId: 7001,
      category: "facts",
      title: "••••••••",
      detail: "••••••••",
      source: "manual",
      confidence: "中",
      updatedAt: new Date("2026-06-20T00:00:00Z"),
      isSensitive: true,
      encryptedPayload: 'encrypted:{"title":"敏感标题","detail":"敏感内容"}',
    });

    await UserMemory.deleteActiveMemory(7001, 6);

    const archiveCall = tx.user_memory_archives.create.mock.calls[0][0];
    expect(archiveCall.data.oldValue).toContain("••••••••");
    expect(archiveCall.data.oldValue).not.toContain("敏感标题");
    expect(archiveCall.data.oldValue).not.toContain("敏感内容");
  });

  test("rejects update and delete when memory is not owned by auth user", async () => {
    await expect(
      UserMemory.updateActiveMemory(7001, 999, {
        category: "facts",
        title: "标题",
        detail: "内容",
      })
    ).rejects.toThrow("Memory not found.");

    await expect(UserMemory.deleteActiveMemory(7001, 999)).rejects.toThrow(
      "Memory not found."
    );
  });
});
