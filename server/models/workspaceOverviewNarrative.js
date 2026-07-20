const prisma = require("../utils/prisma");
const {
  ensureMigrationOwnedTables,
} = require("../utils/database/schemaIntrospection");
const { safeJsonParse } = require("../utils/http");

const PROMPT_VERSION = "workspace-overview-tagline-v2";
let tableReady = false;

function safeJSONStringify(value = {}, fallback = "{}") {
  try {
    return JSON.stringify(value || {});
  } catch {
    return fallback;
  }
}

function normalizeRow(row = null) {
  if (!row) return null;
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspaceId),
    tagline: row.tagline || "",
    sourceHash: row.sourceHash || "",
    model: row.model || null,
    promptVersion: row.promptVersion || PROMPT_VERSION,
    status: row.status || "empty",
    errorType: row.errorType || null,
    metadata: safeJsonParse(row.metadataJson, {}),
    lastGeneratedAt: row.lastGeneratedAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function ensureTable() {
  if (tableReady) return;
  if (
    await ensureMigrationOwnedTables(prisma, ["WorkspaceOverviewNarrative"], {
      context: "workspace-overview-narrative",
    })
  ) {
    tableReady = true;
    return;
  }
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WorkspaceOverviewNarrative" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "tagline" TEXT,
      "sourceHash" TEXT NOT NULL DEFAULT '',
      "model" TEXT,
      "promptVersion" TEXT NOT NULL DEFAULT '${PROMPT_VERSION}',
      "status" TEXT NOT NULL DEFAULT 'empty',
      "errorType" TEXT,
      "metadataJson" TEXT NOT NULL DEFAULT '{}',
      "lastGeneratedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceOverviewNarrative_workspaceId_key"
    ON "WorkspaceOverviewNarrative"("workspaceId")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "WorkspaceOverviewNarrative_status_idx"
    ON "WorkspaceOverviewNarrative"("status")
  `);
  tableReady = true;
}

const WorkspaceOverviewNarrative = {
  PROMPT_VERSION,
  ensureTable,

  async get(workspaceId) {
    await ensureTable();
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT *, CAST("createdAt" AS TEXT) AS "createdAt",
          CAST("updatedAt" AS TEXT) AS "updatedAt",
          CAST("lastGeneratedAt" AS TEXT) AS "lastGeneratedAt"
        FROM "WorkspaceOverviewNarrative"
        WHERE "workspaceId" = ? LIMIT 1`,
        Number(workspaceId)
      )
    )?.[0];
    return normalizeRow(row);
  },

  async upsert({
    workspaceId,
    tagline = "",
    sourceHash = "",
    model = null,
    promptVersion = PROMPT_VERSION,
    status = "empty",
    errorType = null,
    metadata = {},
    markGenerated = false,
  }) {
    await ensureTable();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WorkspaceOverviewNarrative" (
        "workspaceId", "tagline", "sourceHash", "model", "promptVersion",
        "status", "errorType", "metadataJson", "lastGeneratedAt",
        "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${
        markGenerated ? "CURRENT_TIMESTAMP" : "NULL"
      }, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT("workspaceId") DO UPDATE SET
        "tagline" = excluded."tagline",
        "sourceHash" = excluded."sourceHash",
        "model" = excluded."model",
        "promptVersion" = excluded."promptVersion",
        "status" = excluded."status",
        "errorType" = excluded."errorType",
        "metadataJson" = excluded."metadataJson",
        "lastGeneratedAt" = ${
          markGenerated
            ? "CURRENT_TIMESTAMP"
            : '"WorkspaceOverviewNarrative"."lastGeneratedAt"'
        },
        "updatedAt" = CURRENT_TIMESTAMP`,
      Number(workspaceId),
      String(tagline || ""),
      String(sourceHash || ""),
      model,
      promptVersion,
      status,
      errorType,
      safeJSONStringify(metadata)
    );
    return await this.get(workspaceId);
  },
};

module.exports = { WorkspaceOverviewNarrative };
