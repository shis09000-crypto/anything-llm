const prisma = require("../utils/prisma");
const {
  databaseTableColumns,
  ensureMigrationOwnedTables,
} = require("../utils/database/schemaIntrospection");
const {
  chatHistoryEncryptionEnabled,
  decryptSecretIfNeededAsync,
  decryptWorkspaceChatRecordsAsync,
  encryptSecretAsync,
  isEncryptedSecret,
} = require("../utils/security");

const SUMMARY_FORMAT = "thread-compact-markdown-v1";
const CAPSULE_FORMAT = "conversation-state-capsule-json-v1";
let tableReady = false;
const COMPACTION_ENCRYPTION_PURPOSE = "thread-compaction-memory";

class ThreadMemoryError extends Error {
  constructor(code, cause = null) {
    super(code, cause ? { cause } : undefined);
    this.name = "ThreadMemoryError";
    this.code = code;
    this.httpStatus = 503;
  }
}

function isContractCompatibilityError(error = null) {
  const value = [error?.code, error?.reasonCode, error?.message]
    .filter(Boolean)
    .join(":")
    .toLowerCase();
  return (
    value.includes("aicp_contract_fingerprint_mismatch") ||
    value.includes("contract_fingerprint_mismatch") ||
    value.includes("contract_incompatible")
  );
}

function threadMemoryError(error, phase = "store") {
  if (error instanceof ThreadMemoryError) return error;
  if (isContractCompatibilityError(error))
    return new ThreadMemoryError("thread_memory_contract_incompatible", error);
  if (["encrypt", "decrypt"].includes(phase))
    return new ThreadMemoryError("thread_memory_decryption_unavailable", error);
  return new ThreadMemoryError("thread_memory_store_unavailable", error);
}

function nullableScope(value) {
  return value === undefined || value === null ? null : value;
}

function normalizeScope({
  workspace_id = null,
  workspaceId = null,
  user_id = null,
  thread_id = null,
  api_session_id = null,
} = {}) {
  const workspaceIdValue = workspace_id ?? workspaceId;
  if (!workspaceIdValue) throw new Error("workspace_id is required");
  return {
    workspace_id: Number(workspaceIdValue),
    user_id: nullableScope(user_id) === null ? null : Number(user_id),
    thread_id: nullableScope(thread_id) === null ? null : Number(thread_id),
    api_session_id:
      nullableScope(api_session_id) === null ? null : String(api_session_id),
  };
}

function scopeWhere(scope = {}, alias = "") {
  const normalized = normalizeScope(scope);
  const prefix = alias ? `${alias}.` : "";
  const clauses = [`${prefix}"workspace_id" = ?`];
  const params = [normalized.workspace_id];

  for (const field of ["user_id", "thread_id", "api_session_id"]) {
    if (normalized[field] === null) {
      clauses.push(`${prefix}"${field}" IS NULL`);
    } else {
      clauses.push(`${prefix}"${field}" = ?`);
      params.push(normalized[field]);
    }
  }

  return { where: clauses.join(" AND "), params, scope: normalized };
}

function chatScopeWhere(scope = {}, alias = "") {
  const normalized = normalizeScope(scope);
  const prefix = alias ? `${alias}.` : "";
  const clauses = [`${prefix}"workspaceId" = ?`];
  const params = [normalized.workspace_id];

  for (const field of ["user_id", "thread_id", "api_session_id"]) {
    if (normalized[field] === null) {
      clauses.push(`${prefix}"${field}" IS NULL`);
    } else {
      clauses.push(`${prefix}"${field}" = ?`);
      params.push(normalized[field]);
    }
  }

  return { where: clauses.join(" AND "), params, scope: normalized };
}

function encryptedPurpose(value = null) {
  if (!isEncryptedSecret(value)) return COMPACTION_ENCRYPTION_PURPOSE;
  const parts = String(value).split(":");
  if (parts[0] !== "enc" || parts[1] !== "v2" || !parts[3])
    return "secret-store";
  try {
    return Buffer.from(parts[3], "base64url").toString("utf8");
  } catch {
    return "secret-store";
  }
}

function compactionFieldContext(row, field, operation) {
  const value = row?.[field];
  const purpose = encryptedPurpose(value);
  return {
    purpose,
    domain: purpose,
    operation,
    resource: `workspace-chat-compaction:${row?.id || "new"}:${field}`,
  };
}

async function normalizeRow(row = null) {
  if (!row) return null;
  let summary;
  let capsuleJson;
  try {
    [summary, capsuleJson] = await Promise.all([
      decryptCompactionField(
        row.summary,
        compactionFieldContext(row, "summary", "thread-memory-read")
      ),
      row.capsule_json
        ? decryptCompactionField(
            row.capsule_json,
            compactionFieldContext(row, "capsule_json", "thread-memory-read")
          )
        : null,
    ]);
  } catch (error) {
    throw threadMemoryError(error, "decrypt");
  }
  return {
    id: Number(row.id),
    workspace_id: Number(row.workspace_id),
    user_id: row.user_id === null ? null : Number(row.user_id),
    thread_id: row.thread_id === null ? null : Number(row.thread_id),
    api_session_id: row.api_session_id || null,
    summary,
    summary_format: row.summary_format || SUMMARY_FORMAT,
    capsule_json: capsuleJson,
    covered_chat_ids: row.covered_chat_ids || "[]",
    covered_from_chat_id:
      row.covered_from_chat_id === null
        ? null
        : Number(row.covered_from_chat_id),
    covered_to_chat_id:
      row.covered_to_chat_id === null ? null : Number(row.covered_to_chat_id),
    covered_message_count: Number(row.covered_message_count || 0),
    token_before: Number(row.token_before || 0),
    token_after: Number(row.token_after || 0),
    metadata_json: row.metadata_json || "{}",
    reason: row.reason || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function encryptCompactionField(value = null, context = {}) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (!chatHistoryEncryptionEnabled()) return text;
  return encryptSecretAsync(text, context);
}

async function decryptCompactionField(value = null, context = {}) {
  if (value === null || value === undefined) return value;
  return decryptSecretIfNeededAsync(value, context);
}

async function ensureTable() {
  if (tableReady) return;
  if (
    await ensureMigrationOwnedTables(prisma, ["workspace_chat_compactions"], {
      context: "workspace-chat-compaction",
    })
  ) {
    tableReady = true;
    return;
  }
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "workspace_chat_compactions" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspace_id" INTEGER NOT NULL,
      "user_id" INTEGER,
      "thread_id" INTEGER,
      "api_session_id" TEXT,
      "summary" TEXT NOT NULL,
      "summary_format" TEXT NOT NULL DEFAULT '${SUMMARY_FORMAT}',
      "capsule_json" TEXT,
      "covered_chat_ids" TEXT NOT NULL DEFAULT '[]',
      "covered_from_chat_id" INTEGER,
      "covered_to_chat_id" INTEGER,
      "covered_message_count" INTEGER NOT NULL DEFAULT 0,
      "token_before" INTEGER NOT NULL DEFAULT 0,
      "token_after" INTEGER NOT NULL DEFAULT 0,
      "metadata_json" TEXT NOT NULL DEFAULT '{}',
      "reason" TEXT,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const columns = await databaseTableColumns(
    prisma,
    "workspace_chat_compactions"
  );
  if (!columns.has("metadata_json")) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "workspace_chat_compactions"
      ADD COLUMN "metadata_json" TEXT NOT NULL DEFAULT '{}'
    `);
  }
  if (!columns.has("capsule_json")) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "workspace_chat_compactions"
      ADD COLUMN "capsule_json" TEXT
    `);
  }
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "workspace_chat_compactions_scope_created_idx"
    ON "workspace_chat_compactions"("workspace_id", "user_id", "thread_id", "api_session_id", "created_at")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "workspace_chat_compactions_thread_covered_idx"
    ON "workspace_chat_compactions"("workspace_id", "thread_id", "api_session_id", "covered_to_chat_id")
  `);
  tableReady = true;
}

const WorkspaceChatCompaction = {
  SUMMARY_FORMAT,
  CAPSULE_FORMAT,
  ensureTable,
  normalizeScope,
  scopeWhere,
  chatScopeWhere,

  async latest(scope = {}) {
    try {
      await ensureTable();
      const scoped = scopeWhere(scope, "wcc");
      const rows = await prisma.$queryRawUnsafe(
        `SELECT wcc.*
        FROM "workspace_chat_compactions" wcc
        WHERE ${scoped.where}
        ORDER BY wcc."created_at" DESC, wcc."id" DESC
        LIMIT 1`,
        ...scoped.params
      );
      return await normalizeRow(rows?.[0] || null);
    } catch (error) {
      throw threadMemoryError(
        error,
        error instanceof ThreadMemoryError ? "decrypt" : "store"
      );
    }
  },

  async create(data = {}) {
    await ensureTable().catch((error) => {
      throw threadMemoryError(error, "store");
    });
    const scope = normalizeScope(data);
    const pendingRow = {
      id: "new",
      summary: data.summary,
      capsule_json: data.capsule_json,
    };
    let encryptedSummary;
    let encryptedCapsule;
    try {
      [encryptedSummary, encryptedCapsule] = await Promise.all([
        encryptCompactionField(
          String(data.summary || ""),
          compactionFieldContext(pendingRow, "summary", "thread-memory-write")
        ),
        data.capsule_json
          ? encryptCompactionField(
              String(data.capsule_json),
              compactionFieldContext(
                pendingRow,
                "capsule_json",
                "thread-memory-write"
              )
            )
          : null,
      ]);
    } catch (error) {
      throw threadMemoryError(error, "encrypt");
    }

    let row;
    try {
      row = await prisma.workspace_chat_compactions.create({
        data: {
          workspace_id: scope.workspace_id,
          user_id: scope.user_id,
          thread_id: scope.thread_id,
          api_session_id: scope.api_session_id,
          summary: encryptedSummary,
          summary_format: data.summary_format || SUMMARY_FORMAT,
          capsule_json: encryptedCapsule,
          covered_chat_ids: data.covered_chat_ids || "[]",
          covered_from_chat_id: data.covered_from_chat_id ?? null,
          covered_to_chat_id: data.covered_to_chat_id ?? null,
          covered_message_count: Number(data.covered_message_count || 0),
          token_before: Number(data.token_before || 0),
          token_after: Number(data.token_after || 0),
          metadata_json: data.metadata_json || "{}",
          reason: data.reason ? String(data.reason) : null,
        },
      });
    } catch (error) {
      throw threadMemoryError(error, "store");
    }
    return await normalizeRow(row);
  },

  async where(
    scope = {},
    { afterChatId = null, limit = null, orderBy = "asc" } = {}
  ) {
    await ensureTable().catch((error) => {
      throw threadMemoryError(error, "store");
    });
    const scoped = chatScopeWhere(scope, "wc");
    const params = [...scoped.params];
    const clauses = [scoped.where, `wc."include" = TRUE`];
    if (afterChatId !== null) {
      clauses.push(`wc."id" > ?`);
      params.push(Number(afterChatId));
    }
    const direction = String(orderBy).toLowerCase() === "desc" ? "DESC" : "ASC";
    if (limit !== null) params.push(Number(limit));
    let rows;
    try {
      rows = await prisma.$queryRawUnsafe(
        `SELECT wc.*
        FROM "workspace_chats" wc
        WHERE ${clauses.join(" AND ")}
        ORDER BY wc."id" ${direction}
        ${limit !== null ? "LIMIT ?" : ""}`,
        ...params
      );
    } catch (error) {
      throw threadMemoryError(error, "store");
    }
    try {
      return await decryptWorkspaceChatRecordsAsync(rows || []);
    } catch (error) {
      throw threadMemoryError(error, "decrypt");
    }
  },

  async deleteForScope(scope = {}) {
    await ensureTable();
    const scoped = scopeWhere(scope);
    await prisma.$executeRawUnsafe(
      `DELETE FROM "workspace_chat_compactions" WHERE ${scoped.where}`,
      ...scoped.params
    );
    return true;
  },
};

module.exports = { WorkspaceChatCompaction };
