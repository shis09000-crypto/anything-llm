const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mockPrisma = {
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  workspace_chat_compactions: {
    create: jest.fn(),
  },
};

jest.mock("../../utils/prisma", () => mockPrisma);

describe("WorkspaceChatCompaction encryption", () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;
  let inserted;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
    inserted = {};

    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
    mockPrisma.workspace_chat_compactions.create.mockImplementation(
      async ({ data }) => {
        inserted = { ...data };
        return {
          id: 1,
          ...inserted,
          created_at: new Date("2026-07-01T00:00:00.000Z"),
          updated_at: new Date("2026-07-01T00:00:00.000Z"),
        };
      }
    );

    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes("PRAGMA table_info")) return [];
      return [];
    });
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_MASTER_KEY;
    else process.env.ENCRYPTION_MASTER_KEY = originalKey;
    delete process.env.CHAT_HISTORY_ENCRYPTION;
    delete process.env.CHAT_HISTORY_ENCRYPTION_DISABLED;
  });

  it("stores summary and capsule encrypted while returning plaintext", async () => {
    const {
      WorkspaceChatCompaction,
    } = require("../../models/workspaceChatCompaction");
    const { isEncryptedSecret } = require("../../utils/security");

    const row = await WorkspaceChatCompaction.create({
      workspace_id: 10,
      user_id: 20,
      thread_id: 30,
      summary: "private compaction summary",
      summary_format: WorkspaceChatCompaction.CAPSULE_FORMAT,
      capsule_json: JSON.stringify({ private: "capsule" }),
      covered_chat_ids: "[1,2]",
      covered_from_chat_id: 1,
      covered_to_chat_id: 2,
      covered_message_count: 2,
      token_before: 1000,
      token_after: 100,
      metadata_json: "{}",
      reason: "test",
    });

    expect(isEncryptedSecret(inserted.summary)).toBe(true);
    expect(isEncryptedSecret(inserted.capsule_json)).toBe(true);
    expect(JSON.stringify(inserted)).not.toContain(
      "private compaction summary"
    );
    expect(JSON.stringify(inserted)).not.toContain('"private":"capsule"');
    expect(row.summary).toBe("private compaction summary");
    expect(JSON.parse(row.capsule_json)).toEqual({ private: "capsule" });
  });

  it("uses an alias-qualified latest query on SQLite/PostgreSQL-compatible SQL", async () => {
    const stored = {
      id: 14,
      workspace_id: 10,
      user_id: 20,
      thread_id: 30,
      api_session_id: null,
      summary: "summary",
      summary_format: "conversation-state-capsule-json-v1",
      capsule_json: JSON.stringify({ topic: "memory" }),
      covered_chat_ids: "[1,2]",
      covered_from_chat_id: 1,
      covered_to_chat_id: 2,
      covered_message_count: 2,
      token_before: 1000,
      token_after: 100,
      metadata_json: "{}",
      reason: "test",
      created_at: new Date("2026-07-01T00:00:00.000Z"),
      updated_at: new Date("2026-07-01T00:00:00.000Z"),
    };
    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql) =>
      String(sql).includes("SELECT wcc.*") ? [stored] : []
    );
    const {
      WorkspaceChatCompaction,
    } = require("../../models/workspaceChatCompaction");

    const row = await WorkspaceChatCompaction.latest({
      workspace_id: 10,
      user_id: 20,
      thread_id: 30,
      api_session_id: null,
    });
    const latestSql = mockPrisma.$queryRawUnsafe.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("SELECT wcc.*"));

    expect(latestSql).toContain('ORDER BY wcc."created_at" DESC');
    expect(latestSql).toContain('wcc."workspace_id" = ?');
    expect(latestSql).not.toContain('AS "created_at"');
    expect(row.id).toBe(14);
  });

  it("counts every persisted post-compaction chat without filtering include", async () => {
    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql) =>
      String(sql).includes("SELECT COUNT(*)") ? [{ count: BigInt(13) }] : []
    );
    const {
      WorkspaceChatCompaction,
    } = require("../../models/workspaceChatCompaction");

    const count = await WorkspaceChatCompaction.countAfter(
      {
        workspace_id: 10,
        user_id: 20,
        thread_id: 30,
        api_session_id: null,
      },
      { afterChatId: 2253 }
    );
    const countSql = mockPrisma.$queryRawUnsafe.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("SELECT COUNT(*)"));

    expect(count).toBe(13);
    expect(countSql).toContain('wc."id" > ?');
    expect(countSql).not.toContain('wc."include" = TRUE');
  });
});
