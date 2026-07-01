const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mockPrisma = {
  workspace_chats: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
  },
};

jest.mock("../../utils/prisma", () => mockPrisma);
jest.mock("../../utils/chats/chatIdentifiers", () => ({
  newPublicChatId: jest.fn(() => "chat_public_test"),
}));

describe("WorkspaceChats chat history encryption", () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_MASTER_KEY;
    else process.env.ENCRYPTION_MASTER_KEY = originalKey;
    delete process.env.CHAT_HISTORY_ENCRYPTION;
    delete process.env.CHAT_HISTORY_ENCRYPTION_DISABLED;
  });

  it("stores prompt and response encrypted while returning plaintext", async () => {
    mockPrisma.workspace_chats.create.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 1,
        ...data,
      })
    );

    const { WorkspaceChats } = require("../../models/workspaceChats");
    const { workspaceChatFieldIsEncrypted } = require("../../utils/security");
    const { chat, message } = await WorkspaceChats.new({
      workspaceId: 10,
      prompt: "hello private chat",
      response: { text: "secret assistant response" },
      user: { id: 2 },
      threadId: 3,
      apiSessionId: "api-session",
    });
    const saved = mockPrisma.workspace_chats.create.mock.calls[0][0].data;

    expect(message).toBeNull();
    expect(workspaceChatFieldIsEncrypted(saved.prompt)).toBe(true);
    expect(workspaceChatFieldIsEncrypted(saved.response)).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("hello private chat");
    expect(JSON.stringify(saved)).not.toContain("secret assistant response");
    expect(chat.prompt).toBe("hello private chat");
    expect(JSON.parse(chat.response)).toEqual({
      text: "secret assistant response",
    });
  });

  it("decrypts encrypted rows and keeps legacy plaintext readable", async () => {
    const { encryptWorkspaceChatField } = require("../../utils/security");
    mockPrisma.workspace_chats.findMany.mockResolvedValue([
      {
        id: 1,
        workspaceId: 10,
        prompt: encryptWorkspaceChatField("encrypted prompt"),
        response: encryptWorkspaceChatField(
          JSON.stringify({ text: "encrypted" })
        ),
      },
      {
        id: 2,
        workspaceId: 10,
        prompt: "legacy prompt",
        response: JSON.stringify({ text: "legacy" }),
      },
    ]);

    const { WorkspaceChats } = require("../../models/workspaceChats");
    const rows = await WorkspaceChats.where({ workspaceId: 10 });

    expect(rows.map((row) => row.prompt)).toEqual([
      "encrypted prompt",
      "legacy prompt",
    ]);
    expect(rows.map((row) => JSON.parse(row.response).text)).toEqual([
      "encrypted",
      "legacy",
    ]);
  });

  it("encrypts explicit prompt and response updates", async () => {
    mockPrisma.workspace_chats.update.mockResolvedValue({});

    const { WorkspaceChats } = require("../../models/workspaceChats");
    const { workspaceChatFieldIsEncrypted } = require("../../utils/security");
    await WorkspaceChats._update(11, {
      prompt: "edited user text",
      response: JSON.stringify({ text: "edited assistant text" }),
    });
    const saved = mockPrisma.workspace_chats.update.mock.calls[0][0].data;

    expect(workspaceChatFieldIsEncrypted(saved.prompt)).toBe(true);
    expect(workspaceChatFieldIsEncrypted(saved.response)).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("edited user text");
    expect(JSON.stringify(saved)).not.toContain("edited assistant text");
  });

  it("can disable encryption for local compatibility", async () => {
    process.env.CHAT_HISTORY_ENCRYPTION = "false";
    mockPrisma.workspace_chats.create.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 1,
        ...data,
      })
    );

    const { WorkspaceChats } = require("../../models/workspaceChats");
    const { workspaceChatFieldIsEncrypted } = require("../../utils/security");
    await WorkspaceChats.new({
      workspaceId: 10,
      prompt: "plain local prompt",
      response: { text: "plain local response" },
    });
    const saved = mockPrisma.workspace_chats.create.mock.calls[0][0].data;

    expect(workspaceChatFieldIsEncrypted(saved.prompt)).toBe(false);
    expect(saved.prompt).toBe("plain local prompt");
    expect(saved.response).toContain("plain local response");
  });
});
