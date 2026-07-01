const prisma = require("../utils/prisma");
const { decryptWorkspaceChatRecords } = require("../utils/security");

const SUMMARY_FORMAT = "thread-compact-markdown-v1";
const CAPSULE_FORMAT = "conversation-state-capsule-json-v1";
let tableReady = false;

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

function normalizeRow(row = null) {
  if (!row) return null;
  return {
    id: Number(row.id),
    workspace_id: Number(row.workspace_id),
    user_id: row.user_id === null ? null : Number(row.user_id),
    thread_id: row.thread_id === null ? null : Number(row.thread_id),
    api_session_id: row.api_session_id || null,
    summary: row.summary,
    summary_format: row.summary_format || SUMMARY_FORMAT,
    capsule_json: row.capsule_json || null,
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

async function ensureTable() {
  if (tableReady) return;
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
  const columns = await prisma.$queryRawUnsafe(
    `PRAGMA table_info("workspace_chat_compactions")`
  );
  if (!columns.some((column) => column.name === "metadata_json")) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "workspace_chat_compactions"
      ADD COLUMN "metadata_json" TEXT NOT NULL DEFAULT '{}'
    `);
  }
  if (!columns.some((column) => column.name === "capsule_json")) {
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
    await ensureTable();
    const scoped = scopeWhere(scope);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT *, CAST("created_at" AS TEXT) AS "created_at",
        CAST("updated_at" AS TEXT) AS "updated_at"
      FROM "workspace_chat_compactions"
      WHERE ${scoped.where}
      ORDER BY "created_at" DESC, "id" DESC
      LIMIT 1`,
      ...scoped.params
    );
    return normalizeRow(rows?.[0] || null);
  },

  async create(data = {}) {
    await ensureTable();
    const scope = normalizeScope(data);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "workspace_chat_compactions" (
        "workspace_id", "user_id", "thread_id", "api_session_id",
        "summary", "summary_format", "capsule_json", "covered_chat_ids",
        "covered_from_chat_id", "covered_to_chat_id", "covered_message_count",
        "token_before", "token_after", "metadata_json", "reason", "created_at", "updated_at"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      scope.workspace_id,
      scope.user_id,
      scope.thread_id,
      scope.api_session_id,
      String(data.summary || ""),
      data.summary_format || SUMMARY_FORMAT,
      data.capsule_json ? String(data.capsule_json) : null,
      data.covered_chat_ids || "[]",
      data.covered_from_chat_id ?? null,
      data.covered_to_chat_id ?? null,
      Number(data.covered_message_count || 0),
      Number(data.token_before || 0),
      Number(data.token_after || 0),
      data.metadata_json || "{}",
      data.reason ? String(data.reason) : null
    );

    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT *, CAST("created_at" AS TEXT) AS "created_at",
          CAST("updated_at" AS TEXT) AS "updated_at"
        FROM "workspace_chat_compactions"
        WHERE "id" = last_insert_rowid()
        LIMIT 1`
      )
    )?.[0];
    return normalizeRow(row);
  },

  async where(
    scope = {},
    { afterChatId = null, limit = null, orderBy = "asc" } = {}
  ) {
    await ensureTable();
    const scoped = chatScopeWhere(scope, "wc");
    const params = [...scoped.params];
    const clauses = [scoped.where, `wc."include" = 1`];
    if (afterChatId !== null) {
      clauses.push(`wc."id" > ?`);
      params.push(Number(afterChatId));
    }
    const direction = String(orderBy).toLowerCase() === "desc" ? "DESC" : "ASC";
    if (limit !== null) params.push(Number(limit));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT wc.*
      FROM "workspace_chats" wc
      WHERE ${clauses.join(" AND ")}
      ORDER BY wc."id" ${direction}
      ${limit !== null ? "LIMIT ?" : ""}`,
      ...params
    );
    return decryptWorkspaceChatRecords(rows || []);
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
