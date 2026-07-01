const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let conversationKeys = [];
let cryptoMetadata = [];
let auditChats = [];

const mockPrisma = {
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  workspace_chats: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
  },
};

function hexText(value = null) {
  if (value === null || value === undefined) return null;
  return Buffer.from(String(value), "utf8").toString("hex").toUpperCase();
}

function cursorFromSql(sql = "", field = "id") {
  const match = String(sql).match(
    new RegExp(`WHERE\\s+"${field}"\\s+>\\s+(\\d+)`, "i")
  );
  return match ? Number(match[1]) : 0;
}

jest.mock("../../utils/prisma", () => mockPrisma);
jest.mock("../../utils/chats/chatIdentifiers", () => ({
  newPublicChatId: jest.fn(() => "chat_public_test"),
}));

describe("WorkspaceChats chat history encryption", () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    conversationKeys = [];
    cryptoMetadata = [];
    auditChats = [];
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
    mockPrisma.$executeRawUnsafe.mockImplementation((sql, ...params) => {
      if (sql.includes(`"workspace_chat_conversation_keys"`)) {
        if (sql.includes("INSERT OR IGNORE")) {
          const row = {
            key_id: params[0],
            scope_hash: params[1],
            workspace_id: params[2],
            user_id: params[3],
            thread_id: params[4],
            api_session_id: params[5],
            wrapped_key: params[6],
          };
          if (!conversationKeys.some((item) => item.scope_hash === row.scope_hash)) {
            conversationKeys.push(row);
          }
        }
        return Promise.resolve(1);
      }
      if (sql.includes(`"workspace_chat_crypto_metadata"`)) {
        if (sql.includes("INSERT INTO")) {
          const row = {
            chat_id: params[0],
            workspace_id: params[1],
            user_id: params[2],
            thread_id: params[3],
            api_session_id: params[4],
            scope_hash: params[5],
            key_id: params[6],
            crypto_version: params[7],
            prompt_cipher_hash: params[8],
            response_cipher_hash: params[9],
            prev_chain_hash: params[10],
            chain_hash: params[11],
          };
          const index = cryptoMetadata.findIndex(
            (item) => Number(item.chat_id) === Number(row.chat_id)
          );
          if (index >= 0) cryptoMetadata[index] = row;
          else cryptoMetadata.push(row);
        }
        return Promise.resolve(1);
      }
      return Promise.resolve(1);
    });
    mockPrisma.$queryRawUnsafe.mockImplementation((sql, ...params) => {
      if (sql.includes(`FROM "workspace_chat_conversation_keys"`)) {
        if (sql.includes(`"scope_hash" = ?`)) {
          return Promise.resolve(
            conversationKeys.filter((row) => row.scope_hash === params[0])
          );
        }
        if (sql.includes(`"key_id" = ?`)) {
          return Promise.resolve(
            conversationKeys.filter((row) => row.key_id === params[0])
          );
        }
      }
      if (sql.includes(`FROM "workspace_chat_crypto_metadata"`)) {
        if (sql.includes(`WHERE "chat_id" >`)) {
          const cursor = cursorFromSql(sql, "chat_id");
          return Promise.resolve(
            cryptoMetadata
              .filter((row) => Number(row.chat_id) > cursor)
              .map((row) => ({
                chat_id: row.chat_id,
                key_id_hex: hexText(row.key_id),
                crypto_version_hex: hexText(row.crypto_version),
                prompt_cipher_hash_hex: hexText(row.prompt_cipher_hash),
                response_cipher_hash_hex: hexText(row.response_cipher_hash),
                workspace_id: row.workspace_id,
                user_id: row.user_id,
                thread_id: row.thread_id,
                api_session_id_hex: hexText(row.api_session_id),
                scope_hash_hex: hexText(row.scope_hash),
                prev_chain_hash_hex: hexText(row.prev_chain_hash),
                chain_hash_hex: hexText(row.chain_hash),
              }))
          );
        }
        return Promise.resolve(cryptoMetadata);
      }
      if (sql.includes(`FROM "workspace_chats"`)) {
        const cursor = cursorFromSql(sql, "id");
        return Promise.resolve(
          auditChats
            .filter((row) => Number(row.id) > cursor)
            .map((row) => ({
              id: row.id,
              public_id_hex: hexText(row.public_id),
              workspaceId: row.workspaceId,
              prompt_hex: hexText(row.prompt),
              response_hex: hexText(row.response),
              user_id: row.user_id,
              thread_id: row.thread_id,
              api_session_id_hex: hexText(row.api_session_id),
            }))
        );
      }
      return Promise.resolve([]);
    });
    mockPrisma.workspace_chats.findMany.mockResolvedValue([]);
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
    expect(saved.prompt.startsWith("chat:v2:")).toBe(true);
    expect(saved.response.startsWith("chat:v2:")).toBe(true);
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
    mockPrisma.workspace_chats.findFirst.mockResolvedValue({
      id: 11,
      workspaceId: 10,
      user_id: 2,
      thread_id: 3,
      api_session_id: null,
      prompt: "old",
      response: "old",
    });

    const { WorkspaceChats } = require("../../models/workspaceChats");
    const { workspaceChatFieldIsEncrypted } = require("../../utils/security");
    await WorkspaceChats._update(11, {
      prompt: "edited user text",
      response: JSON.stringify({ text: "edited assistant text" }),
    });
    const saved = mockPrisma.workspace_chats.update.mock.calls[0][0].data;

    expect(workspaceChatFieldIsEncrypted(saved.prompt)).toBe(true);
    expect(workspaceChatFieldIsEncrypted(saved.response)).toBe(true);
    expect(saved.prompt.startsWith("chat:v2:")).toBe(true);
    expect(saved.response.startsWith("chat:v2:")).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("edited user text");
    expect(JSON.stringify(saved)).not.toContain("edited assistant text");
  });

  it("preserves non-content updates without forcing encryption fields", async () => {
    mockPrisma.workspace_chats.update.mockResolvedValue({});
    mockPrisma.workspace_chats.findFirst.mockResolvedValue({
      id: 12,
      workspaceId: 10,
      user_id: 2,
      thread_id: 3,
      api_session_id: null,
      prompt: "old",
      response: "old",
    });

    const { WorkspaceChats } = require("../../models/workspaceChats");
    await expect(
      WorkspaceChats._update(12, { include: false })
    ).resolves.toBe(true);

    expect(mockPrisma.workspace_chats.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { include: false },
    });
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

  it("creates serial metadata with a chain hash for new chat history", async () => {
    let created = null;
    mockPrisma.workspace_chats.create.mockImplementation(({ data }) => {
      created = {
        id: 21,
        ...data,
      };
      return Promise.resolve(created);
    });
    mockPrisma.workspace_chats.findMany.mockImplementation(() =>
      Promise.resolve(created ? [created] : [])
    );

    const { WorkspaceChats } = require("../../models/workspaceChats");
    await WorkspaceChats.new({
      workspaceId: 10,
      prompt: "first chained prompt",
      response: { text: "first chained response" },
      user: { id: 2 },
      threadId: 3,
      apiSessionId: "test-session",
    });

    expect(conversationKeys).toHaveLength(1);
    expect(cryptoMetadata).toHaveLength(1);
    expect(cryptoMetadata[0]).toMatchObject({
      chat_id: 21,
      workspace_id: 10,
      user_id: 2,
      thread_id: 3,
      crypto_version: "athena-chat-history:v2",
      prev_chain_hash: null,
    });
    expect(cryptoMetadata[0].chain_hash).toHaveLength(64);
  });

  it("detects tampered serial metadata during integrity audit", async () => {
    let created = null;
    mockPrisma.workspace_chats.create.mockImplementation(({ data }) => {
      created = {
        id: 31,
        ...data,
      };
      return Promise.resolve(created);
    });
    mockPrisma.workspace_chats.findMany.mockImplementation(() =>
      Promise.resolve(created ? [created] : [])
    );

    const { WorkspaceChats } = require("../../models/workspaceChats");
    await WorkspaceChats.new({
      workspaceId: 10,
      prompt: "audit prompt",
      response: { text: "audit response" },
      user: { id: 2 },
      threadId: 3,
      apiSessionId: "test-session",
    });
    auditChats = [created];
    cryptoMetadata[0].chain_hash = "0".repeat(64);

    const {
      auditWorkspaceChatSerialIntegrity,
    } = require("../../utils/security/chatHistorySerialEncryption");
    const report = await auditWorkspaceChatSerialIntegrity();

    expect(report.total).toBe(1);
    expect(report.serialV2).toBe(1);
    expect(report.metadataMissing).toBe(0);
    expect(report.chainInvalid).toBe(1);
  });
});
