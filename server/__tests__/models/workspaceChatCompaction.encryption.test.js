const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mockPrisma = {
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
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

    mockPrisma.$executeRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (String(sql).includes('INSERT INTO "workspace_chat_compactions"')) {
        inserted = {
          workspace_id: params[0],
          user_id: params[1],
          thread_id: params[2],
          api_session_id: params[3],
          summary: params[4],
          summary_format: params[5],
          capsule_json: params[6],
          covered_chat_ids: params[7],
          covered_from_chat_id: params[8],
          covered_to_chat_id: params[9],
          covered_message_count: params[10],
          token_before: params[11],
          token_after: params[12],
          metadata_json: params[13],
          reason: params[14],
        };
      }
      return 1;
    });

    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('PRAGMA table_info')) return [];
      if (String(sql).includes("last_insert_rowid()")) {
        return [
          {
            id: 1,
            ...inserted,
            created_at: "2026-07-01 00:00:00",
            updated_at: "2026-07-01 00:00:00",
          },
        ];
      }
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
    const { WorkspaceChatCompaction } = require("../../models/workspaceChatCompaction");
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
    expect(JSON.stringify(inserted)).not.toContain("private compaction summary");
    expect(JSON.stringify(inserted)).not.toContain('"private":"capsule"');
    expect(row.summary).toBe("private compaction summary");
    expect(JSON.parse(row.capsule_json)).toEqual({ private: "capsule" });
  });
});
