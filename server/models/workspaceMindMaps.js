const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const prisma = require("../utils/prisma");
const {
  ensureMigrationOwnedTables,
} = require("../utils/database/schemaIntrospection");
const { safeJsonParse } = require("../utils/http");

let tableReady = false;

function safeJSONStringify(value, fallback = "{}") {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function cacheUserKey(user = null) {
  return user?.id ? `user:${user.id}` : "anonymous";
}

function toPayload(record = null) {
  if (!record) return null;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    userId: record.user_id,
    threadId: record.thread_id,
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    sourceTitle: record.sourceTitle,
    sourceHash: record.sourceHash,
    title: record.title,
    layout: record.layout,
    theme: record.theme,
    schema: safeJsonParse(record.schema, {}),
    markdown: record.markdown,
    viewport: safeJsonParse(record.viewport, null),
    promptVersion: record.promptVersion,
    schemaVersion: record.schemaVersion,
    generationModel: record.generationModel,
    suitability: safeJsonParse(record.suitability, null),
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
  };
}

async function ensureTable() {
  if (tableReady) return;
  if (
    await ensureMigrationOwnedTables(prisma, ["workspace_mind_maps"], {
      context: "workspace-mind-maps",
    })
  ) {
    tableReady = true;
    return;
  }
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "workspace_mind_maps" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "user_id" INTEGER,
      "thread_id" INTEGER,
      "cacheUserKey" TEXT NOT NULL DEFAULT 'anonymous',
      "sourceType" TEXT NOT NULL,
      "sourceId" TEXT,
      "sourceTitle" TEXT,
      "sourceHash" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "layout" TEXT NOT NULL,
      "theme" TEXT NOT NULL,
      "schema" TEXT NOT NULL,
      "markdown" TEXT,
      "viewport" TEXT,
      "promptVersion" TEXT NOT NULL,
      "schemaVersion" TEXT NOT NULL,
      "generationModel" TEXT,
      "suitability" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "workspace_mind_maps_workspaceId_cacheUserKey_sourceHash_key"
    ON "workspace_mind_maps"("workspaceId", "cacheUserKey", "sourceHash");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "workspace_mind_maps_workspaceId_idx"
    ON "workspace_mind_maps"("workspaceId");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "workspace_mind_maps_user_id_idx"
    ON "workspace_mind_maps"("user_id");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "workspace_mind_maps_thread_id_idx"
    ON "workspace_mind_maps"("thread_id");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "workspace_mind_maps_sourceHash_idx"
    ON "workspace_mind_maps"("sourceHash");
  `);
  tableReady = true;
}

function whereSql(clause = {}) {
  const allowed = {
    id: "id",
    workspaceId: "workspaceId",
    user_id: "user_id",
    thread_id: "thread_id",
    cacheUserKey: "cacheUserKey",
    sourceHash: "sourceHash",
  };
  const parts = [];
  const values = [];
  for (const [key, value] of Object.entries(clause)) {
    if (!Object.prototype.hasOwnProperty.call(allowed, key)) continue;
    if (value === undefined) continue;
    if (value === null) parts.push(`"${allowed[key]}" IS NULL`);
    else {
      parts.push(`"${allowed[key]}" = ?`);
      values.push(value);
    }
  }
  return {
    sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
    values,
  };
}

function orderSql(orderBy = { lastUpdatedAt: "desc" }) {
  const [[key, dir] = ["lastUpdatedAt", "desc"]] = Object.entries(
    orderBy || {}
  );
  const allowed = new Set(["id", "createdAt", "lastUpdatedAt", "title"]);
  const column = allowed.has(key) ? key : "lastUpdatedAt";
  const direction = String(dir).toLowerCase() === "asc" ? "ASC" : "DESC";
  return `ORDER BY "${column}" ${direction}`;
}

const WorkspaceMindMaps = {
  ensureTable,
  cacheUserKey,
  toPayload,

  async get(clause = {}) {
    try {
      await ensureTable();
      const where = whereSql(clause);
      const records = await prisma.$queryRawUnsafe(
        `SELECT * FROM "workspace_mind_maps" ${where.sql} LIMIT 1`,
        ...where.values
      );
      return toPayload(records?.[0]);
    } catch (error) {
      throwModelDataAccessError("workspaceMindMaps.get", error);
    }
  },

  async where(clause = {}, limit = null, orderBy = { lastUpdatedAt: "desc" }) {
    try {
      await ensureTable();
      const where = whereSql(clause);
      const records = await prisma.$queryRawUnsafe(
        `SELECT * FROM "workspace_mind_maps" ${where.sql} ${orderSql(orderBy)} ${
          limit !== null ? "LIMIT ?" : ""
        }`,
        ...where.values,
        ...(limit !== null ? [Number(limit)] : [])
      );
      return records.map(toPayload);
    } catch (error) {
      throwModelDataAccessError("workspaceMindMaps.where", error);
    }
  },

  async findCached({ workspaceId, user = null, sourceHash }) {
    if (!workspaceId || !sourceHash) return null;
    return await this.get({
      workspaceId: Number(workspaceId),
      cacheUserKey: cacheUserKey(user),
      sourceHash,
    });
  },

  async create(data = {}) {
    try {
      await ensureTable();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "workspace_mind_maps" (
          "workspaceId", "user_id", "thread_id", "cacheUserKey", "sourceType",
          "sourceId", "sourceTitle", "sourceHash", "title", "layout", "theme",
          "schema", "markdown", "viewport", "promptVersion", "schemaVersion",
          "generationModel", "suitability"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        Number(data.workspaceId),
        data.user?.id || null,
        data.threadId ? Number(data.threadId) : null,
        cacheUserKey(data.user),
        data.sourceType,
        data.sourceId ? String(data.sourceId) : null,
        data.sourceTitle ? String(data.sourceTitle) : null,
        data.sourceHash,
        data.title,
        data.layout,
        data.theme,
        safeJSONStringify(data.schema),
        data.markdown || null,
        data.viewport ? safeJSONStringify(data.viewport) : null,
        data.promptVersion,
        data.schemaVersion,
        data.generationModel || null,
        data.suitability ? safeJSONStringify(data.suitability) : null
      );
      const record = (
        await prisma.$queryRawUnsafe(
          `SELECT * FROM "workspace_mind_maps"
          WHERE "workspaceId" = ? AND "cacheUserKey" = ? AND "sourceHash" = ?
          LIMIT 1`,
          Number(data.workspaceId),
          cacheUserKey(data.user),
          data.sourceHash
        )
      )?.[0];
      return { mindMap: toPayload(record), error: null };
    } catch (error) {
      console.error(error.message);
      return { mindMap: null, error: error.message };
    }
  },

  async updateViewport({ id, workspaceId, user = null, viewport = null }) {
    if (!id || !workspaceId) return null;
    try {
      await ensureTable();
      await prisma.$executeRawUnsafe(
        `UPDATE "workspace_mind_maps"
        SET "viewport" = ?, "lastUpdatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ? AND "workspaceId" = ? AND "cacheUserKey" = ?`,
        viewport ? safeJSONStringify(viewport) : null,
        Number(id),
        Number(workspaceId),
        cacheUserKey(user)
      );
      return await this.get({
        id: Number(id),
        workspaceId: Number(workspaceId),
        cacheUserKey: cacheUserKey(user),
      });
    } catch (error) {
      throwModelDataAccessError("workspaceMindMaps.updateViewport", error);
    }
  },
};

module.exports = { WorkspaceMindMaps };
